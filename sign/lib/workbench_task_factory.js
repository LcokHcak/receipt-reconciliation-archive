const crypto = require('node:crypto');

const { DOC_TYPES } = require('./package_constants');
const { ROOT_SOURCE_GROUP_KEY, ROOT_SOURCE_GROUP_LABEL } = require('./source_group_utils');
const { DEFAULT_SIGNATURE_STYLE, ensureSignatureFields } = require('./signature_queue');
const { createDocTypeFields } = require('./workbench_task_flow');

function buildManualTaskBase(label = '') {
  const now = new Date().toISOString();
  const suffix = crypto.randomUUID().slice(0, 6);
  const normalizedLabel = String(label || '').trim();

  return {
    id: `task_manual_${suffix}`,
    originalFileName: normalizedLabel || `manual_record_${suffix}`,
    sourceType: 'manual',
    sourceImagePath: '',
    rawJsonPath: '',
    initialRawJsonPath: '',
    sourceOriginalPath: '',
    sourceFileName: '',
    sourceFolderName: '',
    sourceFolderPath: '',
    sourceKey: '',
    machineState: 'completed',
    classificationConfirmed: false,
    passportSecondPassUsed: false,
    receiptSecondPassUsed: false,
    extractedNameAuto: '',
    extractedNameFinal: '',
    chineseNameAuto: '',
    passportNoAuto: '',
    passportNoFinal: '',
    receiptStoreAuto: '',
    receiptStoreFinal: '',
    receiptNoAuto: '',
    receiptNoFinal: '',
    groupNoAuto: '',
    groupNoFinal: '',
    purchaseDateAuto: '',
    purchaseDateFinal: '',
    departureDateAuto: '',
    departureDateFinal: '',
    receiptAmountAuto: '',
    receiptDateAuto: '',
    flightNoAuto: '',
    lineCount: 0,
    averageOcrScore: 0,
    ocrPreview: '',
    ocrText: '',
    ocrError: '',
    sourceGroupKey: ROOT_SOURCE_GROUP_KEY,
    sourceGroupLabel: ROOT_SOURCE_GROUP_LABEL,
    chineseNameFinal: '',
    signatureStyle: DEFAULT_SIGNATURE_STYLE,
    signatureJobStatus: '',
    signatureJobError: '',
    signatureGeneratedAt: '',
    signatureRegionPath: '',
    finalSignaturePath: '',
    finalSignatureSource: '',
    reviewNote: '',
    processResult: '',
    actionSuggestion: '',
    reviewed: false,
    reviewedAt: '',
    rephotoRequested: false,
    version: 1,
    createdAt: now,
    updatedAt: now,
    error: '',
  };
}

function createManualTask(label = '') {
  return ensureSignatureFields({
    ...buildManualTaskBase(label),
    ...createDocTypeFields(),
  });
}

// P2-a(0731):overrides 让调用方把新任务指到**另一张图**上。
// 唯一的用途是「源任务是切片」时把新任务改指整张原图 —— 不这么做的话,
// 补出来的票照抄切片路径,既过不了 canAcceptManualBox(不能画框)、
// 交付时又会撞 duplicate_crop_file(两条任务共用一个切片文件),两头堵死。
// 缺省不传 = 老行为一字不改。
function createManualReceiptTaskFromSource(sourceTask, label = '', overrides = {}) {
  const suffix = crypto.randomUUID().slice(0, 6);
  const base = buildManualTaskBase(label);
  const sourceOriginalPath = String(
    overrides.sourceOriginalPath ?? sourceTask?.sourceOriginalPath ?? ''
  ).trim();
  const sourceFileName = String(sourceTask?.sourceFileName || '').trim();
  const sourceGroupKey = String(sourceTask?.sourceGroupKey || '').trim() || ROOT_SOURCE_GROUP_KEY;
  const sourceGroupLabel = String(sourceTask?.sourceGroupLabel || '').trim() || ROOT_SOURCE_GROUP_LABEL;
  const customerAgentName = String(sourceTask?.customerAgentName || '').trim();
  const sourceFolderName = String(sourceTask?.sourceFolderName || '').trim();
  const sourceFolderPath = String(sourceTask?.sourceFolderPath || '').trim();
  const sourceKey = String(sourceTask?.sourceKey || '').trim();

  return ensureSignatureFields({
    ...base,
    originalFileName: String(label || '').trim() || `manual_receipt_${suffix}`,
    sourceImagePath: String(
      overrides.sourceImagePath ?? sourceTask?.sourceImagePath ?? ''
    ).trim(),
    sourceOriginalPath,
    sourceFileName,
    sourceFolderName,
    sourceFolderPath,
    sourceKey: sourceKey ? `${sourceKey}#manual_receipt_${suffix}` : `manual_receipt_${suffix}`,
    sourceGroupKey,
    sourceGroupLabel,
    customerAgentName,
    classificationConfirmed: true,
    ...createDocTypeFields({
      docTypeAuto: DOC_TYPES.RECEIPT,
      docTypeFinal: DOC_TYPES.RECEIPT,
      sourceOriginalPath,
      sourceFolderName,
      sourceFileName,
      sourceKey: sourceKey ? `${sourceKey}#manual_receipt_${suffix}` : `manual_receipt_${suffix}`,
    }),
  });
}

function createImportedImageTask({
  taskId,
  originalFileName,
  sourceImagePath,
  sourceOriginalPath,
  sourceFileName,
  sourceFolderName,
  sourceFolderPath,
  sourceGroupKey,
  sourceGroupLabel,
  customerAgentName,
  customerOwnerUserId = null,
  customerOwnerUsername = '',
  autoSplitRole = '',
  preprocessMessage = '',
  preprocessWarning = false,
}) {
  const now = new Date().toISOString();

  return ensureSignatureFields({
    id: String(taskId || '').trim() || `task_${crypto.randomUUID().slice(0, 8)}`,
    originalFileName: String(originalFileName || sourceFileName || 'uploaded_image').trim() || 'uploaded_image',
    sourceType: 'uploaded',
    sourceImagePath: String(sourceImagePath || '').trim(),
    rawJsonPath: '',
    initialRawJsonPath: '',
    sourceOriginalPath: String(sourceOriginalPath || '').trim(),
    sourceFileName: String(sourceFileName || '').trim(),
    sourceFolderName: String(sourceFolderName || '').trim(),
    sourceFolderPath: String(sourceFolderPath || '').trim(),
    sourceKey: String(sourceOriginalPath || '').trim(),
    customerOwnerUserId: customerOwnerUserId == null ? null : customerOwnerUserId,
    customerOwnerUsername: String(customerOwnerUsername || '').trim(),
    autoSplitRole: String(autoSplitRole || '').trim(),
    preprocessMessage: String(preprocessMessage || '').trim(),
    preprocessWarning: Boolean(preprocessWarning),
    machineState: 'queued',
    classificationConfirmed: false,
    passportSecondPassUsed: false,
    receiptSecondPassUsed: false,
    extractedNameAuto: '',
    extractedNameFinal: '',
    chineseNameAuto: '',
    passportNoAuto: '',
    passportNoFinal: '',
    receiptStoreAuto: '',
    receiptStoreFinal: '',
    receiptNoAuto: '',
    receiptNoFinal: '',
    groupNoAuto: '',
    groupNoFinal: '',
    purchaseDateAuto: '',
    purchaseDateFinal: '',
    departureDateAuto: '',
    departureDateFinal: '',
    receiptAmountAuto: '',
    receiptDateAuto: '',
    flightNoAuto: '',
    lineCount: 0,
    averageOcrScore: 0,
    ocrPreview: '',
    ocrText: '',
    ocrError: '',
    ...createDocTypeFields({
      sourceOriginalPath: String(sourceOriginalPath || '').trim(),
      sourceFolderName: String(sourceFolderName || '').trim(),
      sourceFileName: String(sourceFileName || '').trim(),
      sourceKey: String(sourceOriginalPath || '').trim(),
    }),
    sourceGroupKey: String(sourceGroupKey || ROOT_SOURCE_GROUP_KEY).trim() || ROOT_SOURCE_GROUP_KEY,
    sourceGroupLabel: String(sourceGroupLabel || ROOT_SOURCE_GROUP_LABEL).trim() || ROOT_SOURCE_GROUP_LABEL,
    customerAgentName: String(customerAgentName || '').trim(),
    chineseNameFinal: '',
    signatureStyle: DEFAULT_SIGNATURE_STYLE,
    signatureJobStatus: '',
    signatureJobError: '',
    signatureGeneratedAt: '',
    signatureRegionPath: '',
    finalSignaturePath: '',
    finalSignatureSource: '',
    reviewNote: '',
    processResult: '',
    actionSuggestion: '',
    reviewed: false,
    reviewedAt: '',
    rephotoRequested: false,
    version: 1,
    createdAt: now,
    updatedAt: now,
    error: '',
  });
}

module.exports = {
  createImportedImageTask,
  createManualReceiptTaskFromSource,
  createManualTask,
};
