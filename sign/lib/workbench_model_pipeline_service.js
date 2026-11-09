const path = require('path');

function createWorkbenchModelPipelineService({
  resolveImagePath,
  runStage,
  runOcr,
  classifyDocumentTypesForChunk,
  buildDocumentAnalysisForTask,
  runPassportSecondPassForChunk,
  runReceiptSecondPassForChunk,
  runPassportFieldModelForChunk,
  runReceiptFieldModelForChunk,
  applyChunkResults,
  docTypes,
}) {
  function shouldExtractAfterClassification(classification) {
    if (!classification || classification.needsReview) {
      return false;
    }
    return classification.docType === docTypes.passport || classification.docType === docTypes.receipt;
  }

  async function processChunk({ batchId, dirs, pendingChunk, paddleOcrOptions }) {
    const modelClassificationMap = await runStage(batchId, 'classification', () => (
      classifyDocumentTypesForChunk(batchId, pendingChunk)
    ));
    const extractionChunk = pendingChunk.filter((pendingTask) => {
      const classification = modelClassificationMap.get(pendingTask.id);
      return classification ? shouldExtractAfterClassification(classification) : true;
    });
    const extractionTaskIds = new Set(extractionChunk.map((task) => task.id));
    const classificationOnlyTaskIds = new Set(
      pendingChunk
        .filter((task) => !extractionTaskIds.has(task.id) && modelClassificationMap.has(task.id))
        .map((task) => task.id)
    );
    const extractionImagePaths = extractionChunk.map((task) => resolveImagePath(batchId, task));
    const ocrResults = extractionImagePaths.length
      ? await runStage(batchId, 'ocr', () => (
        runOcr({
          imagePaths: extractionImagePaths,
          rawJsonDir: dirs.rawJson,
          options: paddleOcrOptions,
        })
      ))
      : [];
    const ocrResultMap = new Map(ocrResults.map((record) => [path.resolve(record.image || ''), record]));
    const initialAnalysisMap = new Map();

    extractionChunk.forEach((pendingTask) => {
      // key 与查找都过 path.resolve,保持对称(生产路径已是绝对、resolve 幂等不变行为;
      // 但若 resolveImagePath 返回相对路径,不对称会查不到 → 静默丢分析结果)
      const ocrRecord = ocrResultMap.get(path.resolve(resolveImagePath(batchId, pendingTask)));
      if (!ocrRecord || ocrRecord.error) {
        return;
      }
      initialAnalysisMap.set(
        pendingTask.id,
        buildDocumentAnalysisForTask(batchId, pendingTask, ocrRecord, {
          classificationOverride: modelClassificationMap.get(pendingTask.id),
        })
      );
    });
    pendingChunk.forEach((pendingTask) => {
      const classification = modelClassificationMap.get(pendingTask.id);
      if (!classification || shouldExtractAfterClassification(classification)) {
        return;
      }
      initialAnalysisMap.set(
        pendingTask.id,
        buildDocumentAnalysisForTask(batchId, pendingTask, null, {
          classificationOverride: classification,
        })
      );
    });

    const passportSecondPassMap = await runStage(batchId, 'passport_second_pass', () => (
      runPassportSecondPassForChunk(
        batchId,
        dirs,
        extractionChunk,
        initialAnalysisMap
      )
    ));
    const receiptSecondPassMap = await runStage(batchId, 'receipt_second_pass', () => (
      runReceiptSecondPassForChunk(
        batchId,
        dirs,
        extractionChunk,
        initialAnalysisMap
      )
    ));
    const finalAnalysisMap = new Map(initialAnalysisMap);

    pendingChunk.forEach((pendingTask) => {
      const passportSecondPassRecord = passportSecondPassMap.get(pendingTask.id);
      if (!passportSecondPassRecord) {
        return;
      }
      finalAnalysisMap.set(
        pendingTask.id,
        buildDocumentAnalysisForTask(batchId, pendingTask, passportSecondPassRecord, {
          forcedDocType: docTypes.passport,
        })
      );
    });
    pendingChunk.forEach((pendingTask) => {
      const receiptSecondPassRecord = receiptSecondPassMap.get(pendingTask.id);
      if (!receiptSecondPassRecord) {
        return;
      }
      finalAnalysisMap.set(
        pendingTask.id,
        buildDocumentAnalysisForTask(batchId, pendingTask, receiptSecondPassRecord, {
          forcedDocType: docTypes.receipt,
        })
      );
    });

    const passportFieldAnalysisMap = await runStage(batchId, 'passport_field_model', () => (
      runPassportFieldModelForChunk(
        batchId,
        dirs,
        extractionChunk,
        finalAnalysisMap
      )
    ));
    passportFieldAnalysisMap.forEach((analysis, taskId) => {
      finalAnalysisMap.set(taskId, analysis);
    });

    if (typeof runReceiptFieldModelForChunk === 'function') {
      const receiptFieldAnalysisMap = await runStage(batchId, 'receipt_field_model', () => (
        runReceiptFieldModelForChunk(
          batchId,
          dirs,
          extractionChunk,
          finalAnalysisMap
        )
      ));
      receiptFieldAnalysisMap.forEach((analysis, taskId) => {
        finalAnalysisMap.set(taskId, analysis);
      });
    }

    await runStage(batchId, 'apply_results', () => applyChunkResults({
      batchId,
      dirs,
      pendingChunk,
      ocrResultMap,
      initialAnalysisMap,
      passportSecondPassMap,
      receiptSecondPassMap,
      finalAnalysisMap,
      extractionTaskIds,
      classificationOnlyTaskIds,
    }));
  }

  return {
    processChunk,
  };
}

module.exports = {
  createWorkbenchModelPipelineService,
};
