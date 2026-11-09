const crypto = require('crypto')
const fs = require('fs')

const { DOC_TYPES } = require('./package_constants')
const {
  ROOT_SOURCE_GROUP_KEY,
  ROOT_SOURCE_GROUP_LABEL,
  normalizeSourceGroups,
} = require('./source_group_utils')
const {
  DEFAULT_SIGNATURE_STYLE,
  ensureSignatureFields,
  normalizeSignatureStyle,
} = require('./signature_queue')
const { createDocTypeFields, normalizeDocType } = require('./workbench_task_flow')
const { getDeletableTaskArtifactRelativePaths } = require('./workbench_task_artifacts')
const { getTaskVersion } = require('./workbench_task_versioning')
const { normalizeStageTimings } = require('./model_pipeline_orchestrator')

const AUTO_CONFIRM_DOC_TYPE_CONFIDENCE = 0.75

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.rmSync(filePath, { force: true })
  }
}

function touchTask(task) {
  task.updatedAt = new Date().toISOString()
}

function normalizeFieldValue(value) {
  return String(value || '').trim()
}

function hasKnownDocTypeValue(value) {
  const normalized = normalizeFieldValue(value).toLowerCase()
  return (
    normalized === 'ticket' ||
    [DOC_TYPES.PASSPORT, DOC_TYPES.RECEIPT, DOC_TYPES.OTHER].includes(normalized)
  )
}

function hasAutoConfirmedDocType(task) {
  const confidence = Number(task?.docTypeConfidence || 0)
  return (
    normalizeFieldValue(task?.machineState) === 'completed' &&
    confidence > AUTO_CONFIRM_DOC_TYPE_CONFIDENCE &&
    hasKnownDocTypeValue(task?.docTypeFinal || task?.docTypeAuto)
  )
}

function inferClassificationConfirmed(task) {
  if (task?.classificationConfirmed === true || hasAutoConfirmedDocType(task)) {
    return true
  }

  if (task?.classificationConfirmed === false) {
    return false
  }

  return Boolean(
    task?.reviewed ||
    task?.rephotoRequested ||
    normalizeFieldValue(task?.extractedNameFinal) ||
    normalizeFieldValue(task?.passportNoFinal) ||
    normalizeFieldValue(task?.chineseNameFinal) ||
    normalizeFieldValue(task?.receiptStoreFinal) ||
    normalizeFieldValue(task?.receiptNoFinal) ||
    normalizeFieldValue(task?.groupNoFinal) ||
    normalizeFieldValue(task?.purchaseDateFinal) ||
    normalizeFieldValue(task?.departureDateFinal) ||
    normalizeFieldValue(task?.finalSignaturePath)
  )
}

function markClassificationConfirmed(task) {
  task.classificationConfirmed = true
  task.needsReview = false
  task.reviewReasons = []
}

function getCoreEditableSnapshot(task) {
  return {
    docTypeFinal: normalizeDocType(task?.docTypeFinal),
    extractedNameFinal: normalizeFieldValue(task?.extractedNameFinal),
    chineseNameFinal: normalizeFieldValue(task?.chineseNameFinal),
    passportNoFinal: normalizeFieldValue(task?.passportNoFinal),
    receiptStoreFinal: normalizeFieldValue(task?.receiptStoreFinal),
    receiptNoFinal: normalizeFieldValue(task?.receiptNoFinal),
    groupNoFinal: normalizeFieldValue(task?.groupNoFinal),
    purchaseDateFinal: normalizeFieldValue(task?.purchaseDateFinal),
    departureDateFinal: normalizeFieldValue(task?.departureDateFinal),
    // 百货真字段(P2):改金额/门店/品牌/上家也算"编辑过"(reviewed 需重置重审)
    receiptAmountFinal: normalizeFieldValue(task?.receiptAmountFinal),
    branchFinal: normalizeFieldValue(task?.branchFinal),
    brandFinal: normalizeFieldValue(task?.brandFinal),
    upstreamFinal: normalizeFieldValue(task?.upstreamFinal),
    signatureStyle: normalizeSignatureStyle(task?.signatureStyle),
    finalSignaturePath: normalizeFieldValue(task?.finalSignaturePath),
  }
}

function didEditableWorkflowChange(previousTask, nextTask) {
  const previousSnapshot = getCoreEditableSnapshot(previousTask)
  const nextSnapshot = getCoreEditableSnapshot(nextTask)

  return Object.keys(previousSnapshot).some((key) => previousSnapshot[key] !== nextSnapshot[key])
}

function buildBatchSkeleton(batchId, name, scenario) {
  const now = new Date().toISOString()
  return {
    id: batchId,
    name,
    scenario,
    createdAt: now,
    updatedAt: now,
    machineState: 'queued',
    recognitionProgress: {},
    sourceGroups: [],
    tasks: [],
  }
}

function normalizeProgressNumber(value) {
  const numberValue = Number(value)
  return Number.isFinite(numberValue) && numberValue > 0 ? Math.round(numberValue) : 0
}

function normalizeRecognitionProgress(progress = {}) {
  const source = progress && typeof progress === 'object' ? progress : {}
  return {
    startedAt: normalizeFieldValue(source.startedAt),
    updatedAt: normalizeFieldValue(source.updatedAt),
    completedAt: normalizeFieldValue(source.completedAt),
    total: normalizeProgressNumber(source.total),
    finished: normalizeProgressNumber(source.finished),
    remaining: normalizeProgressNumber(source.remaining),
    queued: normalizeProgressNumber(source.queued),
    processing: normalizeProgressNumber(source.processing),
    completed: normalizeProgressNumber(source.completed),
    error: normalizeProgressNumber(source.error),
    percent: Math.min(100, normalizeProgressNumber(source.percent)),
    elapsedMs: normalizeProgressNumber(source.elapsedMs),
    etaMs: normalizeProgressNumber(source.etaMs),
    currentStage: normalizeFieldValue(source.currentStage),
    lastCompletedStage: normalizeFieldValue(source.lastCompletedStage),
    failedStage: normalizeFieldValue(source.failedStage),
    lastStageError: normalizeFieldValue(source.lastStageError),
    stageTimings: normalizeStageTimings(source.stageTimings),
  }
}

function buildRecognitionProgressSnapshot(batch, counts, { resetStartedAt = false } = {}) {
  const previous = normalizeRecognitionProgress(batch.recognitionProgress)
  const total = normalizeProgressNumber(counts.total)
  const queued = normalizeProgressNumber(counts.queued)
  const processing = normalizeProgressNumber(counts.processing)
  const completed = normalizeProgressNumber(counts.completed)
  const error = normalizeProgressNumber(counts.error)
  const finished = completed + error
  const remaining = Math.max(0, total - finished)
  const percent = total > 0 ? Math.min(100, Math.round((finished / total) * 100)) : 0
  const running =
    ['queued', 'processing'].includes(batch.machineState) || queued > 0 || processing > 0
  const now = new Date()
  const nowIso = now.toISOString()
  const startedAt = resetStartedAt
    ? nowIso
    : !previous.startedAt && running
      ? nowIso
      : previous.startedAt
  const startedMs = Date.parse(startedAt)
  const elapsedMs = Number.isFinite(startedMs) ? Math.max(0, now.getTime() - startedMs) : 0
  const etaMs =
    running && finished > 0 && remaining > 0 && elapsedMs > 0
      ? Math.round((elapsedMs / finished) * remaining)
      : 0

  return {
    startedAt,
    updatedAt: nowIso,
    completedAt: running ? '' : previous.completedAt || (startedAt ? nowIso : ''),
    total,
    finished,
    remaining,
    queued,
    processing,
    completed,
    error,
    percent,
    elapsedMs,
    etaMs,
  }
}

function syncRecognitionProgress(batch, options = {}) {
  const counts = {
    total: Array.isArray(batch.tasks) ? batch.tasks.length : 0,
    queued: (batch.tasks || []).filter((task) => task.machineState === 'queued').length,
    processing: (batch.tasks || []).filter((task) => task.machineState === 'processing').length,
    completed: (batch.tasks || []).filter((task) => task.machineState === 'completed').length,
    error: (batch.tasks || []).filter((task) => task.machineState === 'error').length,
  }
  batch.recognitionProgress = buildRecognitionProgressSnapshot(batch, counts, options)
  return batch.recognitionProgress
}

function toStorageUrl(batchId, relativePath) {
  if (!relativePath) {
    return ''
  }

  const normalized = relativePath
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join('/')

  return `/storage/${encodeURIComponent(batchId)}/${normalized}`
}

function createWorkbenchNormalizers({ defaultScenario = 'FullProcess' } = {}) {
  function normalizeTask(task) {
    const now = new Date().toISOString()
    return ensureSignatureFields({
      id: task.id || `task_${crypto.randomUUID().slice(0, 8)}`,
      originalFileName: task.originalFileName || task.recordLabel || 'manual_record',
      sourceType: task.sourceType || (task.sourceImagePath ? 'uploaded' : 'manual'),
      sourceImagePath: task.sourceImagePath || '',
      rawJsonPath: task.rawJsonPath || '',
      initialRawJsonPath: task.initialRawJsonPath || '',
      sourceOriginalPath: task.sourceOriginalPath || '',
      // 任务级 owner:批次可能混入他人客户(admin 追加),按 task owner 判归属。白名单过去漏了 → 存盘被抹。
      customerOwnerUserId: task.customerOwnerUserId ?? null,
      customerOwnerUsername: task.customerOwnerUsername || null,
      // 客户代理名(customer.agentName 经桥接注入):代理视图分组/确认站代理比对用。
      // 白名单不带=存盘即抹(owner 三件套事故同款),生产任务上此字段全空即此因。
      customerAgentName: task.customerAgentName || '',
      sourceFileName: task.sourceFileName || '',
      sourceFolderName: task.sourceFolderName || '',
      sourceFolderPath: task.sourceFolderPath || '',
      sourceKey: task.sourceKey || '',
      machineState: task.machineState || 'completed',
      classificationConfirmed: inferClassificationConfirmed(task),
      // 预处理产物三件套+识别来源(2026-07-16 同步一致性审计B1):投影 isOriginalLikeTask 靠
      // autoSplitRole/preprocessMessage 判"原图不计数",前端靠它显示"原图/切图"——白名单漏=
      // 批次重存即抹 → 覆盖层计数漂移 + rebuild(读原始JSON)与增量(读归一化)两路径分叉(owner 事故铁律)。
      autoSplitRole: task.autoSplitRole || '',
      preprocessMessage: task.preprocessMessage || '',
      preprocessWarning: Boolean(task.preprocessWarning), // 写方是布尔(task_factory),别把 false 漂成 ''
      classificationSource: task.classificationSource || '',
      modelMeta: task.modelMeta || null,
      // 文档框相关(0730 第2期):这一层是**字段白名单**,不在名单里的字段读不回前端。
      // 手画框那次实测:框已经落盘,但响应里没有 → 操作员画完看不到任何确认。
      // 白名单漏字段不会报错,只会让功能看起来没生效。
      detectionBox: Array.isArray(task.detectionBox) ? task.detectionBox : null,
      manualBox: Array.isArray(task.manualBox) ? task.manualBox : null,
      docBoxSource: task.docBoxSource || '',
      passportSecondPassUsed: Boolean(task.passportSecondPassUsed),
      passportFieldModelUsed: Boolean(task.passportFieldModelUsed),
      passportFieldModelMeta: task.passportFieldModelMeta || null,
      receiptSecondPassUsed: Boolean(task.receiptSecondPassUsed),
      receiptFieldModelUsed: Boolean(task.receiptFieldModelUsed),
      receiptFieldModelMeta: task.receiptFieldModelMeta || null,
      extractedNameAuto: task.extractedNameAuto || '',
      extractedNameFinal: task.extractedNameFinal || '',
      chineseNameAuto: task.chineseNameAuto || '',
      passportNoAuto: task.passportNoAuto || '',
      passportNoFinal: task.passportNoFinal || '',
      receiptStoreAuto: task.receiptStoreAuto || '',
      receiptStoreFinal: task.receiptStoreFinal || '',
      receiptNoAuto: task.receiptNoAuto || '',
      // OCR 原串留底(带杠/字母):导出层按模式还原票号格式用。白名单不带=存盘即抹(owner 事故铁律)。
      receiptNoRawAuto: task.receiptNoRawAuto || '',
      receiptNoFinal: task.receiptNoFinal || '',
      groupNoAuto: task.groupNoAuto || '',
      groupNoFinal: task.groupNoFinal || '',
      // 团号预匹配(审核前出模式):识别完/改团号时查批次团号表的结果。白名单必须带上,否则存盘即抹。
      modeRawPre: task.modeRawPre || '',
      groupNoMatchStatus: task.groupNoMatchStatus || '',
      groupNoMatchedAt: task.groupNoMatchedAt || '',
      // 票级表态(2026-07-10 票级两步流):每张小票必须表态团号状况才解锁字段审核。
      // tourStance: 'matched'(匹配了号)|'none'(人看图确认票上无团号)|''(未表态=锁定)。
      // sActivityFlag: S活动是票面属性、查团号查不出 → 人工标记(强制升S处理车道)。
      // modeManualPick: 同团号多模式且按店消歧不了时人选的模式(仅影响审核侧车道/回执,
      //   结算权威终匹配照旧自查表,选错不污染台账)。白名单漏=存盘即抹(owner 事故铁律)。
      tourStance: task.tourStance || '',
      tourStancedAt: task.tourStancedAt || '',
      tourStancedBy: task.tourStancedBy || '',
      sActivityFlag: Boolean(task.sActivityFlag),
      modeManualPick: task.modeManualPick || '',
      modeManualPickTour: task.modeManualPickTour || '', // 人工选模式时绑定的团号:号一变选择自动作废
      groupNoSuggestion: task.groupNoSuggestion || '', // 近似纠错建议(fuzzy_candidate 时的表内团号)
      modeStoreMismatch: task.modeStoreMismatch || '', // 店不符提示(store_mismatch 时表内候选模式串)
      // 任务级团号确认回执(确认站盖章时写,撤销清空):分车道审核的资格凭据之一,
      // 缺它=fail-safe 全审。白名单不带=存盘即抹(铁律)。
      tourConfirmedAt: task.tourConfirmedAt || '',
      purchaseDateAuto: task.purchaseDateAuto || task.receiptDateAuto || '',
      purchaseDateFinal: task.purchaseDateFinal || '',
      departureDateAuto: task.departureDateAuto || '',
      departureDateFinal: task.departureDateFinal || '',
      receiptAmountAuto: task.receiptAmountAuto || '',
      // 百货真字段(P2,2026-07-06):金额Final/门店/品牌/上家。铁律:落盘字段必进白名单,
      // 否则存盘即抹(owner 三件套事故同款)。免税店恒空,零影响。
      receiptAmountFinal: task.receiptAmountFinal || '',
      branchAuto: task.branchAuto || '',
      branchFinal: task.branchFinal || '',
      brandAuto: task.brandAuto || '',
      brandFinal: task.brandFinal || '',
      upstreamAuto: task.upstreamAuto || '',
      upstreamFinal: task.upstreamFinal || '',
      receiptDateAuto: task.receiptDateAuto || '',
      flightNoAuto: task.flightNoAuto || '',
      lineCount: Number.isFinite(Number(task.lineCount)) ? Number(task.lineCount) : 0,
      averageOcrScore: Number.isFinite(Number(task.averageOcrScore))
        ? Number(task.averageOcrScore)
        : 0,
      ocrPreview: task.ocrPreview || '',
      ocrText: task.ocrText || '',
      ocrError: task.ocrError || '',
      ...createDocTypeFields(task),
      sourceGroupKey:
        String(task.sourceGroupKey || ROOT_SOURCE_GROUP_KEY).trim() || ROOT_SOURCE_GROUP_KEY,
      sourceGroupLabel:
        String(task.sourceGroupLabel || ROOT_SOURCE_GROUP_LABEL).trim() || ROOT_SOURCE_GROUP_LABEL,
      chineseNameFinal: task.chineseNameFinal || '',
      signatureStyle: task.signatureStyle || DEFAULT_SIGNATURE_STYLE,
      signatureJobStatus: task.signatureJobStatus || '',
      signatureJobError: task.signatureJobError || '',
      signatureGeneratedAt: task.signatureGeneratedAt || '',
      signatureRegionPath: task.signatureRegionPath || '',
      finalSignaturePath: task.finalSignaturePath || '',
      finalSignatureSource: task.finalSignatureSource || '',
      reviewNote: task.reviewNote || '',
      processResult: task.processResult || '',
      actionSuggestion: task.actionSuggestion || '',
      reviewed: Boolean(task.reviewed),
      reviewedAt: task.reviewedAt || '',
      rephotoRequested: Boolean(task.rephotoRequested),
      // 重拍原因分键(0727反馈#10):blurry=模糊/missing=缺/other=其他。白名单不带=存盘即抹(铁律)。
      rephotoReason: task.rephotoReason || '',
      version: getTaskVersion(task),
      createdAt: task.createdAt || now,
      updatedAt: task.updatedAt || now,
      error: task.error || '',
    })
  }

  function normalizeBatch(batch) {
    const normalized = {
      id: batch.id,
      name: batch.name || batch.id,
      scenario: batch.scenario || defaultScenario,
      monthlyWorkspaceKey: normalizeFieldValue(batch.monthlyWorkspaceKey),
      // owner 归属:多账号隔离靠这三个字段(reviewer 只看自己的批次)。
      // 过去白名单漏了它们 → 每次存盘被抹 → operator 看不到自己批次(狂建重复批次)。必须保留。
      ownerUserId: batch.ownerUserId ?? null,
      ownerUsername: batch.ownerUsername || null,
      createdBy: batch.createdBy || null,
      // 已删路径墓碑:审核台删掉的图,补图/追加时不再自动加回(删了又回到待处理 bug)。
      deletedSourcePaths: Array.isArray(batch.deletedSourcePaths) ? batch.deletedSourcePaths : [],
      // 导出留痕(P1,2026-07-18 拍板#3):任一导出动作盖章(最后一次为准);
      // 首页「今日导出/导出状态/待导出」全靠这三个字段——漏白名单=存盘即抹(owner 前车之鉴)。
      exportedAt: batch.exportedAt || '',
      exportedBy: batch.exportedBy || null,
      exportKind: batch.exportKind || '',
      // 导出失败留痕(2026-07-26 待管理事项·导出失败):失败盖戳、下次成功由 markBatchExported 清;
      // 同样必须进白名单,否则存盘即抹、首页永远看不到失败批次。
      exportFailedAt: batch.exportFailedAt || '',
      exportFailedKind: batch.exportFailedKind || '',
      exportFailedError: batch.exportFailedError || '',
      exportFailedBy: batch.exportFailedBy || null,
      groupCodeImport: batch.groupCodeImport && typeof batch.groupCodeImport === 'object'
        ? { ...batch.groupCodeImport }
        : null,
      createdAt: batch.createdAt || new Date().toISOString(),
      updatedAt: batch.updatedAt || new Date().toISOString(),
      machineState: batch.machineState || 'completed',
      recognitionProgress: normalizeRecognitionProgress(batch.recognitionProgress),
      sourceGroups: normalizeSourceGroups(batch.sourceGroups || []),
      tasks: Array.isArray(batch.tasks) ? batch.tasks.map(normalizeTask) : [],
    }

    if (
      normalized.tasks.some(
        (task) => task.machineState === 'queued' || task.machineState === 'processing'
      )
    ) {
      normalized.machineState = 'processing'
    }

    return normalized
  }

  return {
    normalizeTask,
    normalizeBatch,
  }
}

function createWorkbenchArtifactHelpers({
  resolveBatchRelativePath,
  removeFile = removeFileIfExists,
}) {
  function removeTaskArtifacts(batchId, task, remainingTasks = []) {
    const relativePaths = getDeletableTaskArtifactRelativePaths(task, remainingTasks)

    relativePaths.forEach((relativePath) => {
      removeFile(resolveBatchRelativePath(batchId, relativePath))
    })
  }

  function clearTaskSignatureArtifacts(batchId, task) {
    const relativePaths = new Set(
      [task?.signatureRegionPath, task?.finalSignaturePath].filter(Boolean)
    )
    relativePaths.forEach((relativePath) => {
      removeFile(resolveBatchRelativePath(batchId, relativePath))
    })

    task.signatureRegionPath = ''
    task.finalSignaturePath = ''
    task.finalSignatureSource = ''
    task.signatureGeneratedAt = ''
    task.signatureJobError = ''
    task.signatureJobStatus = ''
  }

  return {
    clearTaskSignatureArtifacts,
    removeTaskArtifacts,
  }
}

module.exports = {
  buildBatchSkeleton,
  buildRecognitionProgressSnapshot,
  createWorkbenchArtifactHelpers,
  createWorkbenchNormalizers,
  didEditableWorkflowChange,
  hasAutoConfirmedDocType,
  markClassificationConfirmed,
  normalizeFieldValue,
  normalizeProgressNumber,
  normalizeRecognitionProgress,
  removeFileIfExists,
  syncRecognitionProgress,
  toStorageUrl,
  touchTask,
}
