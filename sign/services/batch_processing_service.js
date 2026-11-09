const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const sharp = require('sharp')

const { DOC_TYPES } = require('../lib/package_constants')
const { runPaddleBatchOcr } = require('../lib/paddle_batch_ocr')
const { analyzeDocumentOcr } = require('../lib/paddle_document_analyzer')
const { createWorkbenchModelPipelineService } = require('../lib/workbench_model_pipeline_service')
const { readSidecar, writeSidecar, isSidecarReusable } = require('../lib/qwen_ocr/sidecar')
const { QWEN_PROMPT_VERSION } = require('../lib/qwen_ocr/qwen_client')
const { sanitizeReceiptJunk } = require('../lib/qwen_ocr/qwen_ocr_adapter')
const { recordStageTiming } = require('../lib/model_pipeline_orchestrator')
const {
  CORE_FIELD_LABELS: PASSPORT_CORE_FIELD_LABELS,
  cleanPassportFieldValue,
  mergePassportFieldModelAnalysis,
} = require('../lib/passport_field_model')
const {
  CORE_FIELD_LABELS: RECEIPT_CORE_FIELD_LABELS,
  cleanReceiptFieldValue,
  mergeReceiptFieldModelAnalysis,
} = require('../lib/receipt_field_model')
const { getPassportSecondPassConfig } = require('../lib/passport_second_pass')
const { getReceiptSecondPassConfig } = require('../lib/receipt_second_pass')
const { MANUAL_SIGNATURE_SOURCE, WEBSITE_SIGNATURE_SOURCE } = require('../lib/signature_queue')
const { recoverCompletedStateAfterManualReview } = require('../lib/workbench_task_recovery')
const {
  hasTaskVersionChanged,
  markStaleModelResultSkipped,
} = require('../lib/workbench_task_versioning')
const { chunkArray, ensureDir } = require('../lib/workbench_utils')

function uniqueReviewReasons(...reasonLists) {
  return [
    ...new Set(
      reasonLists
        .flat()
        .map((item) => String(item || '').trim())
        .filter(Boolean)
    ),
  ]
}

// L142(追加图片绕过切图):append 路径不过 splitImage,ensureQwenSidecar 的 extractAnalyses 若在
// 同一张未切原图上识别出 ≥2 张护照/小票单据,只会留 1 张写 sidecar、其余静默丢(此路径无切图基建
// 可裁子图,不像 splitImage 会把 ≥2 文档裁成子图)。把选中张标 needsReview + multi_doc_uncut 转人工,
// 操作员据此走「同图补小票/按此店重切」补齐——否则同框第二张单据既不产任务也无任何红标,静默漏收。
// 纯函数:analyses=extractAnalyses 返回的全量列表,analysis=已选中要写 sidecar 的那张;
// 只数护照/小票(other 区如包装/航班截图不算,避免误报)。与 splitImage 的多文档处理同精神、异手段。
function markMultiDocUncut(analysis, analyses) {
  if (!analysis) return analysis
  const relevantDocs = Array.isArray(analyses)
    ? analyses.filter(
        (a) => a && (a.docTypeFinal === DOC_TYPES.PASSPORT || a.docTypeFinal === DOC_TYPES.RECEIPT)
      ).length
    : 0
  if (relevantDocs >= 2) {
    analysis.needsReview = true
    analysis.reviewReasons = uniqueReviewReasons(analysis.reviewReasons, ['multi_doc_uncut'])
  }
  return analysis
}

function buildPaddedCropRegion(box, imageMeta) {
  const imageWidth = Math.max(1, Number(imageMeta.width || 0))
  const imageHeight = Math.max(1, Number(imageMeta.height || 0))
  const paddingX = Math.max(4, Math.round(Number(box.width || 0) * 0.08))
  const paddingY = Math.max(4, Math.round(Number(box.height || 0) * 0.2))
  const left = Math.max(0, Math.floor(Number(box.left || 0) - paddingX))
  const top = Math.max(0, Math.floor(Number(box.top || 0) - paddingY))
  const right = Math.min(imageWidth, Math.ceil(Number(box.right || 0) + paddingX))
  const bottom = Math.min(imageHeight, Math.ceil(Number(box.bottom || 0) + paddingY))
  const width = Math.max(1, right - left)
  const height = Math.max(1, bottom - top)
  return { left, top, width, height }
}

function getOcrRecordText(record = {}) {
  const joinedText = String(record.joined_text || record.joinedText || '').trim()
  if (joinedText) {
    return joinedText
  }
  return (Array.isArray(record.lines) ? record.lines : [])
    .map((line) => String(line?.text || '').trim())
    .filter(Boolean)
    .join(' ')
}

function createBatchProcessingService({
  activeBatches,
  batchDir,
  batchJsonPath,
  batchSubdirs,
  withBatchWrite,
  loadBatch,
  saveBatchAsync,
  saveJson,
  modelPipelineOrchestrator,
  documentTypeModel,
  passportFieldModel,
  receiptFieldModel,
  qwenOcrBackend = null, // SIGN_OCR_BACKEND=qwen 时注入;为 null 走 PaddleX(默认)
  groupCodePrematchService: initialGroupCodePrematchService = null, // 团号预匹配(晚绑定,monthlyDb 后注入)
  paddleOcrOptions,
  paddleBatchChunkSize,
  resolveTask,
  recalcTask,
  touchTask,
  syncRecognitionProgress,
  hasAutoConfirmedDocType,
  markClassificationConfirmed,
  clearSignatureRegionAsset,
  clearAutoFinalSignatureAsset,
  canAutoQueueWebsiteSignature,
  queueAutomaticWebsiteSignature,
}) {
  // 团号预匹配服务(晚绑定:monthlyDb 在本服务之后创建,server 装配完再 set 进来)。
  let groupCodePrematchService = initialGroupCodePrematchService
  // run-token:看门狗强制释放守卫后,悬死老协程复活时 finally 不得误删新一轮守卫。
  const activeRunTokens = new Map()
  let processRunSeq = 0

  async function updateBatchRecognitionProgress(batchId, updateProgress) {
    await withBatchWrite(batchId, async () => { // label: updateBatchRecognitionProgress
      if (!fs.existsSync(batchJsonPath(batchId))) {
        return
      }

      const latestBatch = loadBatch(batchId)
      const progress = syncRecognitionProgress(latestBatch)
      updateProgress(progress)
      await saveBatchAsync(latestBatch)
    }, { label: 'updateBatchRecognitionProgress' })
  }

  async function runModelPipelineStage(batchId, stageName, action) {
    return modelPipelineOrchestrator.runPersistedStage({
      stageName,
      begin: async (normalizedStageName) => {
        await updateBatchRecognitionProgress(batchId, (progress) => {
          progress.currentStage = normalizedStageName
          progress.failedStage = ''
          progress.lastStageError = ''
        })
      },
      action,
      finish: async ({ stageName: normalizedStageName, elapsedMs, error }) => {
        await updateBatchRecognitionProgress(batchId, (progress) => {
          recordStageTiming(progress, normalizedStageName, elapsedMs, { error })
        })
      },
    })
  }

  function buildTaskAbsoluteImagePath(batchId, task) {
    return path.resolve(batchDir(batchId), task.sourceImagePath || '')
  }

  function markTaskOcrFailure(task, error) {
    const previousDocTypeAuto = task.docTypeAuto
    const previousDocTypeFinal = task.docTypeFinal
    task.machineState = 'error'
    task.error = String(error?.stack || error || 'PaddleOCR failed')
    task.reviewed = false
    task.reviewedAt = ''
    task.classificationConfirmed = false
    task.ocrError = String(error?.message || error || 'PaddleOCR failed')
    task.needsReview = true
    task.reviewReasons = ['ocr_failed']
    task.docTypeAuto = DOC_TYPES.OTHER
    if (
      !String(previousDocTypeFinal || '').trim() ||
      previousDocTypeFinal === previousDocTypeAuto
    ) {
      task.docTypeFinal = DOC_TYPES.OTHER
    }
    recalcTask(task)
    touchTask(task)
  }

  function buildDocumentAnalysisForTask(batchId, task, ocrRecord, options = {}) {
    const sourcePath = task.sourceOriginalPath || buildTaskAbsoluteImagePath(batchId, task)
    return analyzeDocumentOcr({
      fileName: task.originalFileName,
      sourcePath,
      sourceKey: task.sourceKey || task.sourceFileName || task.originalFileName,
      forcedDocType: options.forcedDocType || '',
      classificationOverride: options.classificationOverride || null,
      ocrRecord: ocrRecord || {},
    })
  }

  async function classifyDocumentTypesForChunk(batchId, pendingChunk) {
    const modelClassificationMap = new Map()
    if (!documentTypeModel) {
      return modelClassificationMap
    }

    if (typeof documentTypeModel.classifyImages === 'function') {
      try {
        const imagePaths = pendingChunk.map((pendingTask) =>
          buildTaskAbsoluteImagePath(batchId, pendingTask)
        )
        const batchResults = await documentTypeModel.classifyImages({ imagePaths })
        batchResults.forEach((item, index) => {
          const pendingTask = pendingChunk[index]
          if (!pendingTask) {
            return
          }
          if (item?.classification) {
            modelClassificationMap.set(pendingTask.id, item.classification)
            return
          }
          if (item?.error) {
            console.warn(
              `[workbench] document type model failed for ${pendingTask.id}: ${item.error}`
            )
          }
        })
        return modelClassificationMap
      } catch (error) {
        console.warn(`[workbench] document type batch model failed: ${error?.message || error}`)
      }
    }

    for (const pendingTask of pendingChunk) {
      try {
        const classification = await documentTypeModel.classifyImage({
          imagePath: buildTaskAbsoluteImagePath(batchId, pendingTask),
        })
        if (classification) {
          modelClassificationMap.set(pendingTask.id, classification)
        }
      } catch (error) {
        console.warn(
          `[workbench] document type model failed for ${pendingTask.id}: ${error?.message || error}`
        )
      }
    }

    return modelClassificationMap
  }

  async function runPassportSecondPassForChunk(batchId, dirs, pendingChunk, initialAnalysisMap) {
    const secondPassConfig = getPassportSecondPassConfig()
    if (!secondPassConfig) {
      return new Map()
    }

    const passportTargets = pendingChunk
      .map((pendingTask) => {
        const initialAnalysis = initialAnalysisMap.get(pendingTask.id)
        if (!initialAnalysis || initialAnalysis.docTypeFinal !== DOC_TYPES.PASSPORT) {
          return null
        }

        return {
          taskId: pendingTask.id,
          imagePath: buildTaskAbsoluteImagePath(batchId, pendingTask),
        }
      })
      .filter(Boolean)

    if (!passportTargets.length) {
      return new Map()
    }

    try {
      console.log(
        `[workbench] passport second-pass using ${secondPassConfig.modelLabel} for ${passportTargets.length} task(s) in ${batchId}`
      )
      const secondPassResults = await runPaddleBatchOcr(
        passportTargets.map((target) => target.imagePath),
        dirs.rawJson,
        {
          ...paddleOcrOptions,
          ...secondPassConfig.options,
        }
      )
      const secondPassByImagePath = new Map(
        secondPassResults.map((record) => [path.resolve(record.image || ''), record])
      )

      return new Map(
        passportTargets
          .map((target) => [target.taskId, secondPassByImagePath.get(target.imagePath)])
          .filter(([, record]) => record && !record.error)
      )
    } catch (error) {
      console.error(`[workbench] passport second-pass failed for ${batchId}`, error)
      return new Map()
    }
  }

  async function runReceiptSecondPassForChunk(batchId, dirs, pendingChunk, initialAnalysisMap) {
    const secondPassConfig = getReceiptSecondPassConfig()
    if (!secondPassConfig) {
      return new Map()
    }

    const receiptTargets = pendingChunk
      .map((pendingTask) => {
        const initialAnalysis = initialAnalysisMap.get(pendingTask.id)
        if (!initialAnalysis || initialAnalysis.docTypeFinal !== DOC_TYPES.RECEIPT) {
          return null
        }

        return {
          taskId: pendingTask.id,
          imagePath: buildTaskAbsoluteImagePath(batchId, pendingTask),
        }
      })
      .filter(Boolean)

    if (!receiptTargets.length) {
      return new Map()
    }

    try {
      console.log(
        `[workbench] receipt second-pass using ${secondPassConfig.modelLabel} for ${receiptTargets.length} task(s) in ${batchId}`
      )
      const secondPassResults = await runPaddleBatchOcr(
        receiptTargets.map((target) => target.imagePath),
        dirs.rawJson,
        {
          ...paddleOcrOptions,
          ...secondPassConfig.options,
        }
      )
      const secondPassByImagePath = new Map(
        secondPassResults.map((record) => [path.resolve(record.image || ''), record])
      )

      return new Map(
        receiptTargets
          .map((target) => [target.taskId, secondPassByImagePath.get(target.imagePath)])
          .filter(([, record]) => record && !record.error)
      )
    } catch (error) {
      console.error(`[workbench] receipt second-pass failed for ${batchId}`, error)
      return new Map()
    }
  }

  async function writePassportFieldCrop({ sourceImagePath, outputPath, field }) {
    const meta = await sharp(sourceImagePath).metadata()
    const cropRegion = buildPaddedCropRegion(field.box, meta)
    await sharp(sourceImagePath).extract(cropRegion).png().toFile(outputPath)
  }

  async function buildFieldCropTargets({
    dirs,
    targets,
    detectionResults,
    tempDirPrefix,
    coreLabels,
    kind,
  }) {
    if (!targets.length || !detectionResults.length) {
      return { tempDir: '', cropTargets: [] }
    }

    const tempDir = path.join(
      dirs.rawJson,
      `${tempDirPrefix}_${crypto.randomBytes(4).toString('hex')}`
    )
    ensureDir(tempDir)
    const detectionByImagePath = new Map(
      detectionResults.map((item) => [path.resolve(item.imagePath || ''), item])
    )
    const cropTargets = []

    for (const target of targets) {
      const detection = detectionByImagePath.get(path.resolve(target.imagePath))
      if (!detection || detection.error || !detection.fields) {
        continue
      }

      for (const label of coreLabels) {
        const field = detection.fields[label]
        if (!field) {
          continue
        }
        const outputPath = path.join(tempDir, `${target.taskId}_${label}.png`)
        try {
          await writePassportFieldCrop({
            sourceImagePath: target.imagePath,
            outputPath,
            field,
          })
          cropTargets.push({
            taskId: target.taskId,
            label,
            imagePath: outputPath,
            detection,
            confidence: field.confidence,
          })
        } catch (error) {
          console.warn(
            `[workbench] ${kind} field crop failed for ${target.taskId}/${label}: ${error?.message || error}`
          )
        }
      }
    }

    return { tempDir, cropTargets }
  }

  async function buildPassportFieldCropTargets(batchId, dirs, targets, detectionResults) {
    return buildFieldCropTargets({
      batchId,
      dirs,
      targets,
      detectionResults,
      tempDirPrefix: 'passport_field_crops',
      coreLabels: PASSPORT_CORE_FIELD_LABELS,
      kind: 'passport',
    })
  }

  async function buildReceiptFieldCropTargets(batchId, dirs, targets, detectionResults) {
    return buildFieldCropTargets({
      batchId,
      dirs,
      targets,
      detectionResults,
      tempDirPrefix: 'receipt_field_crops',
      coreLabels: RECEIPT_CORE_FIELD_LABELS,
      kind: 'receipt',
    })
  }

  async function runFieldModelForChunk({
    batchId,
    dirs,
    pendingChunk,
    baseAnalysisMap,
    fieldModel,
    docType,
    buildCropTargets,
    cleanValue,
    mergeAnalysis,
    metaSource,
    kind,
  }) {
    if (!fieldModel) {
      return new Map()
    }

    const targets = pendingChunk
      .map((pendingTask) => {
        const baseAnalysis = baseAnalysisMap.get(pendingTask.id)
        if (!baseAnalysis || baseAnalysis.docTypeFinal !== docType) {
          return null
        }
        return {
          taskId: pendingTask.id,
          imagePath: buildTaskAbsoluteImagePath(batchId, pendingTask),
        }
      })
      .filter(Boolean)

    if (!targets.length) {
      return new Map()
    }

    let tempDir = ''
    try {
      const detectionResults = await fieldModel.detectImages({
        imagePaths: targets.map((target) => target.imagePath),
      })
      const cropBuildResult = await buildCropTargets(batchId, dirs, targets, detectionResults)
      tempDir = cropBuildResult.tempDir
      const cropTargets = cropBuildResult.cropTargets
      if (!cropTargets.length) {
        return new Map()
      }

      const cropOcrResults = await runPaddleBatchOcr(
        cropTargets.map((target) => target.imagePath),
        dirs.rawJson,
        paddleOcrOptions
      )
      const cropTargetByImagePath = new Map(
        cropTargets.map((target) => [path.resolve(target.imagePath), target])
      )
      const fieldValuesByTask = new Map()
      const modelMetaByTask = new Map()

      cropOcrResults.forEach((record) => {
        const target = cropTargetByImagePath.get(path.resolve(record.image || ''))
        if (!target || record.error) {
          return
        }
        const rawText = getOcrRecordText(record)
        const value = cleanValue(target.label, rawText)
        if (!fieldValuesByTask.has(target.taskId)) {
          fieldValuesByTask.set(target.taskId, {})
        }
        if (!modelMetaByTask.has(target.taskId)) {
          modelMetaByTask.set(target.taskId, {
            source: metaSource,
            fields: {},
            detections: Object.fromEntries(
              Object.entries(target.detection.fields || {}).map(([label, field]) => [
                label,
                {
                  confidence: field.confidence,
                  box: field.box,
                },
              ])
            ),
          })
        }
        fieldValuesByTask.get(target.taskId)[target.label] = {
          value,
          rawText,
          confidence: target.confidence,
        }
        modelMetaByTask.get(target.taskId).fields[target.label] = {
          value,
          rawText,
          confidence: target.confidence,
        }
      })

      return new Map(
        targets
          .map((target) => {
            const baseAnalysis = baseAnalysisMap.get(target.taskId)
            const fieldValues = fieldValuesByTask.get(target.taskId)
            if (!baseAnalysis || !fieldValues) {
              return null
            }
            const merged = mergeAnalysis({
              baseAnalysis,
              fieldValues,
              modelMeta: modelMetaByTask.get(target.taskId) || null,
            })
            return [target.taskId, merged]
          })
          .filter(Boolean)
      )
    } catch (error) {
      console.warn(
        `[workbench] ${kind} field model failed for ${batchId}: ${error?.message || error}`
      )
      return new Map()
    } finally {
      if (tempDir) {
        fs.rmSync(tempDir, { recursive: true, force: true })
      }
    }
  }

  async function runPassportFieldModelForChunk(batchId, dirs, pendingChunk, baseAnalysisMap) {
    return runFieldModelForChunk({
      batchId,
      dirs,
      pendingChunk,
      baseAnalysisMap,
      fieldModel: passportFieldModel,
      docType: DOC_TYPES.PASSPORT,
      buildCropTargets: buildPassportFieldCropTargets,
      cleanValue: cleanPassportFieldValue,
      mergeAnalysis: mergePassportFieldModelAnalysis,
      metaSource: 'passport_field_detection_crop_ocr',
      kind: 'passport',
    })
  }

  async function runReceiptFieldModelForChunk(batchId, dirs, pendingChunk, baseAnalysisMap) {
    return runFieldModelForChunk({
      batchId,
      dirs,
      pendingChunk,
      baseAnalysisMap,
      fieldModel: receiptFieldModel,
      docType: DOC_TYPES.RECEIPT,
      buildCropTargets: buildReceiptFieldCropTargets,
      cleanValue: cleanReceiptFieldValue,
      mergeAnalysis: mergeReceiptFieldModelAnalysis,
      metaSource: 'receipt_field_detection_crop_ocr',
      kind: 'receipt',
    })
  }

  function applyPaddleOcrToTask(batchId, dirs, task, ocrRecord, options = {}) {
    const initialAnalysis =
      options.initialAnalysis || buildDocumentAnalysisForTask(batchId, task, ocrRecord)
    const finalOcrRecord =
      options.receiptSecondPassRecord || options.passportSecondPassRecord || ocrRecord
    const forcedDocType = options.receiptSecondPassRecord
      ? DOC_TYPES.RECEIPT
      : options.passportSecondPassRecord
        ? DOC_TYPES.PASSPORT
        : ''
    const finalAnalysis =
      options.finalAnalysis ||
      (finalOcrRecord === ocrRecord
        ? initialAnalysis
        : buildDocumentAnalysisForTask(batchId, task, finalOcrRecord, { forcedDocType }))
    const rawJsonFileName = `${task.id}.json`
    const rawJsonRelative = path.join('raw_json', rawJsonFileName)
    const rawJsonAbsolute = path.join(dirs.rawJson, rawJsonFileName)
    const previousDocTypeAuto = task.docTypeAuto
    const previousDocTypeFinal = task.docTypeFinal
    const usedReceiptSecondPass = Boolean(
      options.receiptSecondPassRecord &&
      finalOcrRecord === options.receiptSecondPassRecord &&
      finalOcrRecord !== ocrRecord
    )
    const usedPassportSecondPass = Boolean(
      !usedReceiptSecondPass &&
      options.passportSecondPassRecord &&
      finalOcrRecord === options.passportSecondPassRecord &&
      finalOcrRecord !== ocrRecord
    )
    if (finalOcrRecord !== ocrRecord) {
      const initialRawJsonFileName = `${task.id}.initial.json`
      task.initialRawJsonPath = path.join('raw_json', initialRawJsonFileName)
      task.passportSecondPassUsed = usedPassportSecondPass
      task.receiptSecondPassUsed = usedReceiptSecondPass
      saveJson(path.join(dirs.rawJson, initialRawJsonFileName), ocrRecord)
    } else {
      task.initialRawJsonPath = ''
      task.passportSecondPassUsed = false
      task.receiptSecondPassUsed = false
    }
    saveJson(rawJsonAbsolute, finalOcrRecord)

    task.rawJsonPath = rawJsonRelative
    task.error = ''
    task.ocrError = ''
    task.lineCount = finalAnalysis.lineCount || initialAnalysis.lineCount || 0
    task.averageOcrScore = finalAnalysis.averageOcrScore || initialAnalysis.averageOcrScore || 0
    task.ocrPreview = finalAnalysis.ocrPreview || initialAnalysis.ocrPreview || ''
    task.ocrText = finalAnalysis.ocrText || initialAnalysis.ocrText || ''
    task.docTypeAuto = initialAnalysis.docTypeAuto
    task.docTypeConfidence = initialAnalysis.docTypeConfidence
    task.needsReview = Boolean(initialAnalysis.needsReview || finalAnalysis.needsReview)
    task.reviewReasons = uniqueReviewReasons(
      initialAnalysis.reviewReasons,
      finalAnalysis.reviewReasons
    )
    task.classificationSource = initialAnalysis.classificationSource || ''
    task.modelMeta = initialAnalysis.modelMeta || null
    task.passportFieldModelUsed = Boolean(finalAnalysis.passportFieldModelUsed)
    task.passportFieldModelMeta = finalAnalysis.passportFieldModelMeta || null
    task.receiptFieldModelUsed = Boolean(finalAnalysis.receiptFieldModelUsed)
    task.receiptFieldModelMeta = finalAnalysis.receiptFieldModelMeta || null
    task.sourceOriginalPath = initialAnalysis.sourceOriginalPath
    task.sourceFolderName = initialAnalysis.sourceFolderName
    task.sourceFileName = initialAnalysis.sourceFileName
    task.sourceKey = initialAnalysis.sourceKey
    if (
      !String(previousDocTypeFinal || '').trim() ||
      previousDocTypeFinal === previousDocTypeAuto
    ) {
      task.docTypeFinal = initialAnalysis.docTypeFinal
    }
    task.extractedNameAuto =
      finalAnalysis.extractedNameAuto || initialAnalysis.extractedNameAuto || ''
    task.chineseNameAuto = finalAnalysis.chineseNameAuto || initialAnalysis.chineseNameAuto || ''
    task.passportNoAuto = finalAnalysis.passportNoAuto || initialAnalysis.passportNoAuto || ''
    task.receiptNoAuto = finalAnalysis.receiptNoAuto || initialAnalysis.receiptNoAuto || ''
    // OCR 原串留底(带杠/字母),导出层按模式还原票号格式;审核台不展示不校验。
    task.receiptNoRawAuto = finalAnalysis.receiptNoRawAuto || initialAnalysis.receiptNoRawAuto || ''
    task.groupNoAuto = finalAnalysis.groupNoAuto || initialAnalysis.groupNoAuto || ''
    task.purchaseDateAuto = finalAnalysis.purchaseDateAuto || initialAnalysis.purchaseDateAuto || ''
    task.departureDateAuto =
      finalAnalysis.departureDateAuto || initialAnalysis.departureDateAuto || ''
    task.receiptAmountAuto =
      finalAnalysis.receiptAmountAuto || initialAnalysis.receiptAmountAuto || ''
    task.receiptStoreAuto = finalAnalysis.receiptStoreAuto || initialAnalysis.receiptStoreAuto || ''
    task.receiptDateAuto = finalAnalysis.receiptDateAuto || initialAnalysis.receiptDateAuto || ''
    task.flightNoAuto = finalAnalysis.flightNoAuto || initialAnalysis.flightNoAuto || ''
    // 百货真字段(P2):门店/品牌/上家。免税店恒空,搬运不分店(analysis 里没有就为空)。
    task.branchAuto = finalAnalysis.branchAuto || initialAnalysis.branchAuto || ''
    task.brandAuto = finalAnalysis.brandAuto || initialAnalysis.brandAuto || ''
    task.upstreamAuto = finalAnalysis.upstreamAuto || initialAnalysis.upstreamAuto || ''

    if (!String(task.receiptStoreFinal || '').trim()) {
      task.receiptStoreFinal = task.receiptStoreAuto || ''
    }
    if (!String(task.receiptNoFinal || '').trim()) {
      task.receiptNoFinal = task.receiptNoAuto || ''
    }
    if (!String(task.groupNoFinal || '').trim()) {
      task.groupNoFinal = task.groupNoAuto || ''
    }
    // 团号预匹配前移:识别一出团号就查本批次团号表(毫秒级),审核台带着模式进(触发点①)。
    // 失败不致命(预匹配纯参考),吞掉异常不打断识别流水线。
    if (groupCodePrematchService) {
      try { groupCodePrematchService.prematchTask(batchId, task) } catch { /* advisory */ }
    }
    if (!String(task.purchaseDateFinal || '').trim()) {
      task.purchaseDateFinal = task.purchaseDateAuto || ''
    }
    if (!String(task.departureDateFinal || '').trim()) {
      task.departureDateFinal = task.departureDateAuto || ''
    }
    // 百货真字段 Final 回填(与上面免税店字段同款:Final 为空才用 Auto 预填,审核员改过的不动)
    if (!String(task.receiptAmountFinal || '').trim()) {
      task.receiptAmountFinal = task.receiptAmountAuto || ''
    }
    if (!String(task.branchFinal || '').trim()) {
      task.branchFinal = task.branchAuto || ''
    }
    if (!String(task.brandFinal || '').trim()) {
      task.brandFinal = task.brandAuto || ''
    }
    if (!String(task.upstreamFinal || '').trim()) {
      task.upstreamFinal = task.upstreamAuto || ''
    }

    if (!String(task.extractedNameFinal || '').trim()) {
      task.extractedNameFinal = task.extractedNameAuto || ''
    }
    if (!String(task.passportNoFinal || '').trim()) {
      task.passportNoFinal = task.passportNoAuto || ''
    }
    if (!String(task.chineseNameFinal || '').trim()) {
      task.chineseNameFinal = task.chineseNameAuto || ''
    }

    clearSignatureRegionAsset(batchId, task)
    if (![MANUAL_SIGNATURE_SOURCE, WEBSITE_SIGNATURE_SOURCE].includes(task.finalSignatureSource)) {
      clearAutoFinalSignatureAsset(batchId, task)
    }

    task.machineState = 'completed'
    if (hasAutoConfirmedDocType(task)) {
      markClassificationConfirmed(task)
    }
    recalcTask(task)
    touchTask(task)
  }

  function applyClassificationOnlyToTask(batchId, task, analysis) {
    const previousDocTypeAuto = task.docTypeAuto
    const previousDocTypeFinal = task.docTypeFinal
    task.rawJsonPath = ''
    task.initialRawJsonPath = ''
    task.passportSecondPassUsed = false
    task.receiptSecondPassUsed = false
    task.error = ''
    task.ocrError = ''
    task.lineCount = 0
    task.averageOcrScore = 0
    task.ocrPreview = ''
    task.ocrText = ''
    task.docTypeAuto = analysis.docTypeAuto
    task.docTypeConfidence = analysis.docTypeConfidence
    task.needsReview = Boolean(analysis.needsReview)
    task.reviewReasons = uniqueReviewReasons(analysis.reviewReasons)
    task.classificationSource = analysis.classificationSource || ''
    task.modelMeta = analysis.modelMeta || null
    task.passportFieldModelUsed = false
    task.passportFieldModelMeta = null
    task.receiptFieldModelUsed = false
    task.receiptFieldModelMeta = null
    task.sourceOriginalPath = analysis.sourceOriginalPath
    task.sourceFolderName = analysis.sourceFolderName
    task.sourceFileName = analysis.sourceFileName
    task.sourceKey = analysis.sourceKey
    if (
      !String(previousDocTypeFinal || '').trim() ||
      previousDocTypeFinal === previousDocTypeAuto
    ) {
      task.docTypeFinal = analysis.docTypeFinal
    }
    clearSignatureRegionAsset(batchId, task)
    if (![MANUAL_SIGNATURE_SOURCE, WEBSITE_SIGNATURE_SOURCE].includes(task.finalSignatureSource)) {
      clearAutoFinalSignatureAsset(batchId, task)
    }
    task.machineState = 'completed'
    if (hasAutoConfirmedDocType(task)) {
      markClassificationConfirmed(task)
    }
    recalcTask(task)
    touchTask(task)
  }

  function skipStaleModelResultIfEdited(batchId, task, pendingTask) {
    if (!hasTaskVersionChanged(task, pendingTask)) {
      return false
    }

    console.warn(
      `[workbench] discarding stale OCR result for ${batchId}/${task.id}; task was edited during recognition`
    )
    markStaleModelResultSkipped(task, { recalcTask, touchTask })
    return true
  }

  async function applyModelPipelineChunkResults({
    batchId,
    dirs,
    pendingChunk,
    ocrResultMap,
    initialAnalysisMap,
    passportSecondPassMap,
    receiptSecondPassMap,
    finalAnalysisMap,
    classificationOnlyTaskIds = new Set(),
  }) {
    await withBatchWrite(batchId, async () => { // label: applyModelPipelineChunkResults
      if (!fs.existsSync(batchJsonPath(batchId))) {
        return
      }

      const latestBatch = loadBatch(batchId)
      const autoSignatureTasks = []
      pendingChunk.forEach((pendingTask) => {
        const task = resolveTask(latestBatch, pendingTask.id)
        if (!task) {
          return
        }
        if (skipStaleModelResultIfEdited(batchId, task, pendingTask)) {
          return
        }
        if (recoverCompletedStateAfterManualReview(task) || task.machineState === 'completed') {
          return
        }

        const ocrRecord = ocrResultMap.get(buildTaskAbsoluteImagePath(batchId, task))
        if (!ocrRecord) {
          const isClassificationOnly =
            typeof classificationOnlyTaskIds.has === 'function' &&
            classificationOnlyTaskIds.has(task.id)
          if (isClassificationOnly) {
            const analysis = finalAnalysisMap.get(task.id) || initialAnalysisMap.get(task.id)
            if (!analysis) {
              markTaskOcrFailure(
                task,
                new Error('Classification-only task did not produce analysis')
              )
              return
            }
            applyClassificationOnlyToTask(batchId, task, analysis)
            return
          }
          markTaskOcrFailure(task, new Error('No PaddleOCR result returned for image'))
          return
        }
        if (ocrRecord.error) {
          markTaskOcrFailure(task, new Error(ocrRecord.error))
          return
        }

        applyPaddleOcrToTask(batchId, dirs, task, ocrRecord, {
          initialAnalysis: initialAnalysisMap.get(task.id),
          passportSecondPassRecord: passportSecondPassMap.get(task.id),
          receiptSecondPassRecord: receiptSecondPassMap.get(task.id),
          finalAnalysis: finalAnalysisMap.get(task.id),
        })
        if (canAutoQueueWebsiteSignature(task)) {
          autoSignatureTasks.push(task)
        }
      })

      for (const task of autoSignatureTasks) {
        await queueAutomaticWebsiteSignature(latestBatch, task)
      }

      latestBatch.machineState = latestBatch.tasks.some((task) =>
        ['queued', 'processing'].includes(task.machineState)
      )
        ? 'processing'
        : 'completed'
      syncRecognitionProgress(latestBatch)
      await saveBatchAsync(latestBatch)
    }, { label: 'applyModelPipelineChunkResults' })
  }

  // ── 千问后端(SIGN_OCR_BACKEND=qwen):注入函数只读 sidecar(预处理已写),不调 PaddleX ──
  // 设计:复用 processChunk 编排;second-pass/字段模型返回空 Map → finalAnalysisMap = sidecar 的 analyses。
  // sidecar(<图>.qwen.json)是唯一通道:classify 阶段确保其存在(缺失就就地补一次千问并写回),
  // build 阶段只读 sidecar。无共享内存 → 并发 batch 间不互相污染(每个 sidecar 按图片路径寻址)。
  function qwenFallbackAnalysis(reason) {
    return {
      docTypeAuto: DOC_TYPES.OTHER, docTypeFinal: DOC_TYPES.OTHER, docTypeConfidence: 0,
      needsReview: true, reviewReasons: [reason],
      extractedNameAuto: '', chineseNameAuto: '', passportNoAuto: '',
      receiptNoAuto: '', groupNoAuto: '', purchaseDateAuto: '', departureDateAuto: '',
      receiptAmountAuto: '', receiptStoreAuto: '', receiptDateAuto: '', flightNoAuto: '',
      branchAuto: '', brandAuto: '', upstreamAuto: '',
      lineCount: 0, averageOcrScore: 0, ocrPreview: '', ocrText: '', ocrError: '',
      classificationSource: 'qwen',
      // 版本戳:qwen_no_document(真无证件,如航班截图)按当前版本缓存复用;
      // qwen_failed 由 isSidecarReusable 按 reason 拒绝复用,与版本无关。
      promptVersion: QWEN_PROMPT_VERSION,
      // 模型/分辨率戳(2026-07-21 部署审计 HIGH):兜底 sidecar 也要打戳,否则加了模型闸后
      // 无证件图(航班截图/包装,约 5%)每轮识别都判不可复用→永久重调 qwen。与 ensureQwenSidecar 同源。
      ocrModel: process.env.QWEN_OCR_MODEL || 'qwen-vl-max',
      ocrMaxEdge: Number(process.env.QWEN_MAX_EDGE) || 1280,
    }
  }

  // 确保该任务图有 sidecar:有且可复用则读;缺失/旧 prompt 版本/故障兜底 → 就地调千问写回。
  // 「可复用」由 isSidecarReusable 判:版本不符或 qwen_failed 的缓存一律作废重调,
  // 防旧 prompt 的错误结果和故障期空结果在队列里潜伏回放(71990 事故 + 毒 sidecar 事故双根治)。
  async function ensureQwenSidecar(batchId, task) {
    const imagePath = buildTaskAbsoluteImagePath(batchId, task)
    const existing = readSidecar(imagePath)
    // 垃圾值过滤(#5):历史缓存里可能躺着模型编造值(全0小票号/12345团号,过滤器上线前写的),
    // 读取时兜同一道 sanitize(幂等,只改内存对象不回写文件)——新调用在适配器生成处已过滤。
    // ⭐模型/分辨率戳(2026-07-21 部署审计):当前装配的模型/分辨率与 sidecar 打的戳不一致
    // (含无戳的更旧缓存)→ 作废重调,防换 qwen3-vl-plus + 高清成静默 no-op。与适配器 env 默认同源。
    const ocrOpts = {
      model: process.env.QWEN_OCR_MODEL || 'qwen-vl-max',
      maxEdge: Number(process.env.QWEN_MAX_EDGE) || 1280,
      sharpen: String(process.env.QWEN_SHARPEN || '') === '1', // 0727#8:锐化闸戳同步
    }
    if (existing && isSidecarReusable(existing, QWEN_PROMPT_VERSION, ocrOpts)) return sanitizeReceiptJunk(existing)
    let analysis
    try {
      // L482:useCache:false——ensureQwenSidecar 已先读 sidecar(文件缓存),只有 sidecar 缺失/失效
      // (换模型分辨率作废、purge-sidecar+requeue 重识别、append 未切图)才走到这里,此时必须真调 qwen,
      // 绝不能命中适配器进程内 Map 回放旧 OCR——否则审核台「重识别」/换模型后 requeue 拿到的还是旧结果
      // (进程内 Map 是 sidecar 之外的第二层缓存,存活过 sidecar 删除)。正常流程 sidecar 命中即返回,
      // 到不了这里,故 useCache:false 不增加任何 OCR 成本(sidecar 已去重),只堵住陈旧回放。
      const list = await qwenOcrBackend.extractAnalyses(imagePath, { sourceKey: task.sourceKey || '', useCache: false })
      analysis = list.find((a) => a.docTypeFinal === DOC_TYPES.PASSPORT || a.docTypeFinal === DOC_TYPES.RECEIPT)
        || list[0] || qwenFallbackAnalysis('qwen_no_document')
      // L142:同图 ≥2 张护照/小票时,append 路径无切图基建裁子图 → 标选中张转人工(multi_doc_uncut),
      // 避免同框第二张单据静默丢失无红标。flag 落进 analysis→写 sidecar→build 阶段进任务 needsReview。
      markMultiDocUncut(analysis, list)
    } catch (error) {
      // 内容审核拒绝(平台判图敏感,如护照人脸/证件)= 确定性拒绝,单独标 qwen_content_rejected,
      // 审核台提示人工录入,别当识别故障排查(2026-07-21 部署审计;2000金标实测护照 ~0.25%)。
      const reason = error && error.contentRejected ? 'qwen_content_rejected' : 'qwen_failed'
      console.error(`[workbench] qwen 兜底调用失败 task=${task.id} reason=${reason}`, error)
      analysis = qwenFallbackAnalysis(reason)
    }
    writeSidecar(imagePath, analysis) // 写回 → build 阶段同步读到,无需内存缓存
    return analysis
  }

  // 用量埋点节流戳(2026-07-21 部署审计):换 qwen3+高清首周盯 token/失败率/回退,每跨 500 次调用打一次快照
  let lastQwenUsageLoggedAt = 0
  function logQwenUsageThrottled() {
    if (!qwenOcrBackend || typeof qwenOcrBackend.getUsage !== 'function') return
    const u = qwenOcrBackend.getUsage()
    if ((u.calls || 0) - lastQwenUsageLoggedAt < 500) return
    lastQwenUsageLoggedAt = u.calls
    console.log(`[qwen_usage] model=${u.model} calls=${u.calls} promptTok=${u.promptTokens} completionTok=${u.completionTokens} errors=${u.errors} fallbacks=${u.fallbacks || 0}`)
  }

  async function qwenClassifyDocumentTypesForChunk(batchId, pendingChunk) {
    const map = new Map()
    for (const task of pendingChunk) {
      const a = await ensureQwenSidecar(batchId, task)
      // classify 的 needsReview 语义 =「分类是否需人工先确认」(决定要不要进字段提取阶段),
      // 不是字段级复核。千问一次调用已定类型、字段已写进 sidecar → 护照/小票一律放行到提取;
      // 否则 sidecar 里字段校验产生的 needsReview(小票几乎必触发)会把任务打成 classificationOnly、
      // 走 applyClassificationOnlyToTask 而丢掉已识别字段。字段级 needsReview/reviewReasons
      // 由 build→apply 从 sidecar analysis 进入任务(见 applyPaddleOcrToTask:616-620)。
      map.set(task.id, {
        docType: a.docTypeFinal || DOC_TYPES.OTHER,
        confidence: Number(a.docTypeConfidence || 0),
        scores: {},
        needsReview: false,
        reviewReasons: [],
        modelMeta: a.modelMeta || null,
      })
    }
    logQwenUsageThrottled()
    return map
  }

  // 同步:processChunk 同步调用。classify 已确保 sidecar 存在 → 这里只读。
  function qwenBuildDocumentAnalysisForTask(batchId, task) {
    // 审计H4(2026-07-16):build 是**真正把字段搬进任务**的路径(下游 applyPaddleOcrToTask 取
    // groupNoAuto/receiptNoAuto)。此前直接读原始 sidecar 绕过垃圾值过滤器——classify 侧(:889)
    // 虽 sanitize 但只取 docType/confidence,清洗过的字段被丢弃。07-03~07-06 窗口的脏 sidecar
    // (编造团号12345/全0票号,promptVersion=2 过复用闸)会裸奔进任务混绿。与 :889 对称补 sanitize:
    // 编造值置空+qwen_junk_* 标红+needsReview,不再自动过审。sanitizeReceiptJunk 幂等、只动小票、只改内存。
    const a = sanitizeReceiptJunk(readSidecar(buildTaskAbsoluteImagePath(batchId, task)) || qwenFallbackAnalysis('qwen_no_document'))
    return {
      ...a,
      sourceOriginalPath: task.sourceOriginalPath || a.sourceOriginalPath || '',
      sourceFileName: task.sourceFileName || a.sourceFileName || '',
      sourceFolderName: task.sourceFolderName || a.sourceFolderName || '',
      sourceKey: task.sourceKey || a.sourceKey || '',
    }
  }

  const qwenPipelineFns = {
    runOcr: ({ imagePaths }) => imagePaths.map((p) => ({ image: p })), // 桩:让 ocrResultMap 有项,analysis 走 sidecar
    classifyDocumentTypesForChunk: qwenClassifyDocumentTypesForChunk,
    buildDocumentAnalysisForTask: qwenBuildDocumentAnalysisForTask,
    runPassportSecondPassForChunk: async () => new Map(),
    runReceiptSecondPassForChunk: async () => new Map(),
    runPassportFieldModelForChunk: async () => new Map(),
    runReceiptFieldModelForChunk: async () => new Map(),
  }

  const paddlePipelineFns = {
    runOcr: ({ imagePaths, rawJsonDir, options }) => runPaddleBatchOcr(imagePaths, rawJsonDir, options),
    classifyDocumentTypesForChunk,
    buildDocumentAnalysisForTask,
    runPassportSecondPassForChunk,
    runReceiptSecondPassForChunk,
    runPassportFieldModelForChunk,
    runReceiptFieldModelForChunk,
  }

  const workbenchModelPipelineService = createWorkbenchModelPipelineService({
    resolveImagePath: buildTaskAbsoluteImagePath,
    runStage: runModelPipelineStage,
    applyChunkResults: applyModelPipelineChunkResults,
    docTypes: {
      passport: DOC_TYPES.PASSPORT,
      receipt: DOC_TYPES.RECEIPT,
    },
    ...(qwenOcrBackend ? qwenPipelineFns : paddlePipelineFns),
  })

  async function processBatch(batchId) {
    if (activeBatches.has(batchId)) {
      return
    }
    if (!fs.existsSync(batchJsonPath(batchId))) {
      return
    }

    activeBatches.add(batchId)
    // run-token(2026-07-08 悬死事故):看门狗强制释放守卫重跑后,悬死老协程若迟到复活,
    // 它的 finally 不得误删新一轮的守卫(否则同批次可三重并发)。
    processRunSeq += 1
    const runToken = processRunSeq
    activeRunTokens.set(batchId, runToken)
    const dirs = batchSubdirs(batchId)

    try {
      let pendingTasks = []
      await withBatchWrite(batchId, async () => { // label: processBatch
        if (!fs.existsSync(batchJsonPath(batchId))) {
          return
        }

        const latestBatch = loadBatch(batchId)
        latestBatch.tasks.forEach((task) => {
          recoverCompletedStateAfterManualReview(task)
        })
        pendingTasks = latestBatch.tasks.filter(
          (task) =>
            task.machineState !== 'completed' &&
            task.sourceType !== 'manual' &&
            task.sourceImagePath
        )
        latestBatch.machineState = pendingTasks.length ? 'processing' : 'completed'
        latestBatch.tasks
          .filter((task) => pendingTasks.some((item) => item.id === task.id))
          .forEach((task) => {
            task.machineState = 'queued'
            task.error = ''
            touchTask(task)
          })
        syncRecognitionProgress(latestBatch, { resetStartedAt: true })
        await saveBatchAsync(latestBatch)
      }, { label: 'processBatch' })

      if (!pendingTasks.length) {
        await withBatchWrite(batchId, async () => { // label: processBatchComplete
          if (!fs.existsSync(batchJsonPath(batchId))) {
            return
          }

          const latestBatch = loadBatch(batchId)
          latestBatch.machineState = 'completed'
          syncRecognitionProgress(latestBatch)
          await saveBatchAsync(latestBatch)
        }, { label: 'processBatchComplete' })
        return
      }

      // 面包屑(2026-07-08 悬死事故抓拍):生产曾出现协程在 chunk 间隙静默悬死
      // (零报错零超时,双守卫被占,批次永久"等待识别")。每个 chunk 首尾各记一行,
      // 下次案发日志里 "chunk N done" 之后没有 "chunk N+1 start" = 悬点钉死在间隙,
      // "start" 没有 "done" = 悬在 processChunk 内。量级:每6任务2行,可忽略。
      const chunkTotal = Math.ceil(pendingTasks.length / Math.max(1, paddleBatchChunkSize))
      let chunkIndex = 0
      for (const pendingChunk of chunkArray(pendingTasks, paddleBatchChunkSize)) {
        chunkIndex += 1
        console.log(`[workbench] batch ${batchId} chunk ${chunkIndex}/${chunkTotal} start (${pendingChunk.length} tasks)`)
        await withBatchWrite(batchId, async () => { // label: processBatchChunk
          if (!fs.existsSync(batchJsonPath(batchId))) {
            return
          }

          const latestBatch = loadBatch(batchId)
          pendingChunk.forEach((pendingTask) => {
            const task = resolveTask(latestBatch, pendingTask.id)
            if (!task) {
              return
            }
            if (recoverCompletedStateAfterManualReview(task) || task.machineState === 'completed') {
              return
            }

            task.machineState = 'processing'
            task.error = ''
            touchTask(task)
          })
          latestBatch.machineState = latestBatch.tasks.some((task) =>
            ['queued', 'processing'].includes(task.machineState)
          )
            ? 'processing'
            : 'completed'
          syncRecognitionProgress(latestBatch)
          await saveBatchAsync(latestBatch)
        }, { label: 'processBatchChunk' })

        try {
          await workbenchModelPipelineService.processChunk({
            batchId,
            dirs,
            pendingChunk,
            paddleOcrOptions: paddleOcrOptions,
          })
        } catch (error) {
          await withBatchWrite(batchId, async () => { // label: processBatchChunkFailure
            if (!fs.existsSync(batchJsonPath(batchId))) {
              return
            }

            const latestBatch = loadBatch(batchId)
            pendingChunk.forEach((pendingTask) => {
              const task = resolveTask(latestBatch, pendingTask.id)
              if (
                !task ||
                recoverCompletedStateAfterManualReview(task) ||
                task.machineState !== 'processing'
              ) {
                return
              }
              if (skipStaleModelResultIfEdited(batchId, task, pendingTask)) {
                return
              }
              markTaskOcrFailure(task, error)
            })
            latestBatch.machineState = latestBatch.tasks.some((task) =>
              ['queued', 'processing'].includes(task.machineState)
            )
              ? 'processing'
              : 'completed'
            syncRecognitionProgress(latestBatch)
            await saveBatchAsync(latestBatch)
          }, { label: 'processBatchChunkFailure' })
          console.error(
            `[workbench] paddle chunk failed for ${batchId} (${pendingChunk.length} tasks)`,
            error
          )
        }
        console.log(`[workbench] batch ${batchId} chunk ${chunkIndex}/${chunkTotal} done`)
      }
      console.log(`[workbench] batch ${batchId} all ${chunkTotal} chunks complete`)
    } finally {
      if (activeRunTokens.get(batchId) === runToken) {
        activeBatches.delete(batchId)
        activeRunTokens.delete(batchId)
      }
    }
  }

  return {
    buildTaskAbsoluteImagePath,
    processBatch,
    // 晚绑定注入(与 setBatchGroupCodeImportService 同模式):monthlyDb 建好后 server 调这个接线。
    setGroupCodePrematchService(service) {
      groupCodePrematchService = service
    },
  }
}

module.exports = {
  createBatchProcessingService,
  markMultiDocUncut, // L142:纯函数导出供单测(append 路径同图多单据转人工)
}
