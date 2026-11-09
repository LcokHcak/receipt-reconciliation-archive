const path = require('node:path');

const { classifyDocument } = require('./document_classifier');
const { createDocTypeFields } = require('./workbench_task_flow');
const { DOC_TYPES } = require('./package_constants');
const { extractPassportFieldsFromOcr } = require('./paddle_passport_parser');
const { extractReceiptFieldsFromOcr } = require('./paddle_receipt_parser');
const { validateAll: validateAllRuleFields } = require('./validation/field_rules');
const { normalizeOcrFieldsForDocType } = require('./workbench_field_normalizer');

function mergeReviewReasonsUnique(existingReasons = [], addedReasons = []) {
  return [...new Set([
    ...(Array.isArray(existingReasons) ? existingReasons : []),
    ...(Array.isArray(addedReasons) ? addedReasons : []),
  ].map((item) => String(item || '').trim()).filter(Boolean))];
}

function buildPreview(lines, fallbackText) {
  const previewLines = Array.isArray(lines)
    ? lines.map((line) => String(line?.text || '').trim()).filter(Boolean).slice(0, 8)
    : [];
  if (previewLines.length) {
    return previewLines.join('\n');
  }
  return String(fallbackText || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 8).join('\n');
}

function normalizeOverrideDocType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (
    normalized === DOC_TYPES.PASSPORT ||
    normalized === DOC_TYPES.RECEIPT ||
    normalized === DOC_TYPES.OTHER
  ) {
    return normalized;
  }
  return '';
}

function normalizeClassificationOverride(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const docType = normalizeOverrideDocType(value.docType);
  if (!docType) {
    return null;
  }
  const confidence = Number(value.confidence);
  return {
    docType,
    confidence: Number.isFinite(confidence) ? confidence : 0,
    scores: value.scores && typeof value.scores === 'object' ? value.scores : {},
    needsReview: Boolean(value.needsReview),
    reviewReasons: Array.isArray(value.reviewReasons) ? value.reviewReasons : [],
    modelMeta: value.modelMeta && typeof value.modelMeta === 'object' ? value.modelMeta : null,
  };
}

function runFieldValidation({ docType, base }) {
  // For passports: validate 3 passport-specific fields
  if (docType === DOC_TYPES.PASSPORT) {
    const { reasons } = validateAllRuleFields({
      chineseName: base.chineseNameAuto,
      englishName: base.extractedNameAuto,
      passportNo: base.passportNoAuto,
      // storeFamily / receiptNo / tourNo / dates — not applicable, skip
      storeFamily: 'LOTTE', // pretend a valid enum so receipt/tour validators don't fire
      receiptNo: 'placeholder',  // will still be length-mismatched below, so special case:
      tourNo: 'placeholder',
      purchaseDate: '',
      departureDate: '',
    });
    // Filter out the false positives from the placeholder fields.
    // 2026-06-30 中文名下线:不再因中文名 OCR 异常把任务推进复核队列(审核台已不审中文名)。
    return reasons.filter((r) => (
      r === 'field_english_name_invalid'
      || r === 'field_passport_no_invalid'
    ));
  }

  // For receipts: validate the full 8-field rule set
  if (docType === DOC_TYPES.RECEIPT) {
    const { reasons } = validateAllRuleFields({
      chineseName: base.chineseNameAuto,
      englishName: base.extractedNameAuto,
      passportNo: base.passportNoAuto,
      storeFamily: base.receiptStoreAuto,
      receiptNo: base.receiptNoAuto,
      tourNo: base.groupNoAuto, // daily_receipt "团号" maps to tourNo in monthly pipeline
      purchaseDate: base.purchaseDateAuto,
      departureDate: base.departureDateAuto,
    });
    return reasons;
  }

  return [];
}

function analyzeDocumentOcr({
  fileName = '',
  sourcePath = '',
  sourceKey = '',
  forcedDocType = '',
  classificationOverride = null,
  ocrRecord = {},
} = {}) {
  const joinedText = String(ocrRecord.joined_text || ocrRecord.joinedText || '');
  const lines = Array.isArray(ocrRecord.lines) ? ocrRecord.lines : [];
  const ruleClassification = classifyDocument({
    fileName: fileName || path.basename(sourcePath || ocrRecord.image || ''),
    ocrText: joinedText,
  });
  const modelClassification = normalizeClassificationOverride(classificationOverride);
  const classification = modelClassification || ruleClassification;
  const effectiveDocType = forcedDocType || classification.docType;
  const effectiveConfidence = forcedDocType ? Math.max(classification.confidence || 0, 0.99) : classification.confidence;
  const effectiveNeedsReview = forcedDocType ? false : classification.needsReview;
  const effectiveReviewReasons = forcedDocType ? [] : classification.reviewReasons;
  const classificationSource = forcedDocType ? 'forced' : (modelClassification ? 'model' : 'ocr_rules');

  const docTypeFields = createDocTypeFields({
    docTypeAuto: effectiveDocType,
    docTypeFinal: effectiveDocType,
    docTypeConfidence: effectiveConfidence,
    needsReview: effectiveNeedsReview,
    reviewReasons: effectiveReviewReasons,
    sourceOriginalPath: sourcePath,
    sourceFolderName: sourcePath ? path.basename(path.dirname(sourcePath)) : '',
    sourceFileName: sourcePath ? path.basename(sourcePath) : (fileName || ''),
    sourceKey,
  });

  const base = {
    ...docTypeFields,
    lineCount: Number(ocrRecord.line_count || lines.length || 0),
    averageOcrScore: Number(ocrRecord.average_score || 0),
    ocrPreview: buildPreview(lines, joinedText),
    ocrText: joinedText,
    ocrError: String(ocrRecord.error || '').trim(),
    extractedNameAuto: '',
    chineseNameAuto: '',
    passportNoAuto: '',
    receiptNoAuto: '',
    groupNoAuto: '',
    purchaseDateAuto: '',
    departureDateAuto: '',
    receiptAmountAuto: '',
    receiptStoreAuto: '',
    receiptDateAuto: '',
    flightNoAuto: '',
    classificationSource,
    modelMeta: modelClassification?.modelMeta || null,
  };

  if (docTypeFields.docTypeFinal === DOC_TYPES.PASSPORT) {
    const passportFields = extractPassportFieldsFromOcr({ lines });
    base.extractedNameAuto = passportFields.englishName || '';
    base.chineseNameAuto = passportFields.chineseName || '';
    base.passportNoAuto = passportFields.passportNo || '';
  } else if (docTypeFields.docTypeFinal === DOC_TYPES.RECEIPT) {
    const receiptFields = extractReceiptFieldsFromOcr({ lines, joinedText });
    base.extractedNameAuto = receiptFields.englishName || '';
    base.passportNoAuto = receiptFields.passportNo || '';
    base.receiptNoAuto = receiptFields.receiptNo || '';
    base.groupNoAuto = receiptFields.groupNo || '';
    base.purchaseDateAuto = receiptFields.purchaseDate || receiptFields.saleDate || '';
    base.departureDateAuto = receiptFields.departureDate || '';
    base.receiptAmountAuto = receiptFields.amount || '';
    base.receiptStoreAuto = receiptFields.storeFamily || receiptFields.storeName || '';
    base.receiptDateAuto = receiptFields.saleDate || '';
    base.flightNoAuto = receiptFields.flightNo || '';
  }

  Object.assign(base, normalizeOcrFieldsForDocType(docTypeFields.docTypeFinal, base));

  // Rule-set v2 (2026-05-11): run the strict field validators and surface
  // every violation as a review reason so the human reviewer can see the
  // specific broken rule (e.g. receipt_no length doesn't match store family).
  // Field validation is best-effort — if a field is still empty (OCR failed
  // to recognise it) the validator will flag it too, which is the desired
  // behaviour for "reviewer must confirm every record".
  const validationReasons = runFieldValidation({ docType: docTypeFields.docTypeFinal, base });
  if (validationReasons.length) {
    base.needsReview = true;
    base.reviewReasons = mergeReviewReasonsUnique(base.reviewReasons, validationReasons);
  }

  return base;
}

module.exports = {
  analyzeDocumentOcr,
  normalizeClassificationOverride,
};
