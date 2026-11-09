const crypto = require('node:crypto');

const { DOC_TYPES } = require('./package_constants');
const { DEFAULT_SIGNATURE_STYLE, SIGNATURE_STYLE_OPTIONS } = require('./workbench_definition');

const WEBSITE_SIGNATURE_SOURCE = 'website_generated';
const MANUAL_SIGNATURE_SOURCE = 'manual_drawn';

function normalizeTrimmed(value) {
  return String(value || '').trim();
}

function normalizeSignatureStyle(style) {
  const normalized = normalizeTrimmed(style);
  return SIGNATURE_STYLE_OPTIONS.includes(normalized) ? normalized : DEFAULT_SIGNATURE_STYLE;
}

function deriveSignatureJobStatus(task) {
  const chineseName = normalizeTrimmed(task.chineseNameFinal);
  if (!chineseName) {
    return 'pending_name';
  }

  if (
    task.finalSignatureSource === WEBSITE_SIGNATURE_SOURCE &&
    normalizeTrimmed(task.finalSignaturePath)
  ) {
    return 'done';
  }

  if (['queued', 'generating', 'failed'].includes(task.signatureJobStatus)) {
    return task.signatureJobStatus;
  }

  return 'idle';
}

function ensureSignatureFields(task = {}) {
  const normalized = {
    ...task,
    chineseNameFinal: normalizeTrimmed(task.chineseNameFinal),
    signatureStyle: normalizeSignatureStyle(task.signatureStyle),
    signatureJobError: normalizeTrimmed(task.signatureJobError),
    signatureGeneratedAt: normalizeTrimmed(task.signatureGeneratedAt),
  };

  normalized.signatureJobStatus = deriveSignatureJobStatus(normalized);

  if (normalized.signatureJobStatus !== 'failed') {
    normalized.signatureJobError = '';
  }

  if (normalized.signatureJobStatus !== 'done') {
    normalized.signatureGeneratedAt =
      normalized.finalSignatureSource === WEBSITE_SIGNATURE_SOURCE ? normalized.signatureGeneratedAt : '';
  }

  return normalized;
}

function syncWebsiteSignatureAfterFieldChange(previousTask, nextTask) {
  const previousChinese = normalizeTrimmed(previousTask?.chineseNameFinal);
  const nextChinese = normalizeTrimmed(nextTask?.chineseNameFinal);
  const previousStyle = normalizeSignatureStyle(previousTask?.signatureStyle);
  const nextStyle = normalizeSignatureStyle(nextTask?.signatureStyle);

  nextTask.chineseNameFinal = nextChinese;
  nextTask.signatureStyle = nextStyle;

  const changed = previousChinese !== nextChinese || previousStyle !== nextStyle;
  if (!changed) {
    return false;
  }

  const websiteOwnedOutput =
    previousTask?.finalSignatureSource === WEBSITE_SIGNATURE_SOURCE &&
    normalizeTrimmed(previousTask?.finalSignaturePath);
  const websiteJobInFlight = ['queued', 'generating', 'failed'].includes(previousTask?.signatureJobStatus);

  if (!websiteOwnedOutput && !websiteJobInFlight) {
    return false;
  }

  nextTask.finalSignaturePath = '';
  nextTask.finalSignatureSource = '';
  nextTask.signatureGeneratedAt = '';
  nextTask.signatureJobError = '';
  nextTask.signatureJobStatus = nextChinese ? 'idle' : 'pending_name';
  return true;
}

function isEligibleForWebsiteGeneration(task = {}) {
  return !getWebsiteSignatureEligibilityIssue(task);
}

function getWebsiteSignatureEligibilityIssue(task = {}) {
  const normalized = ensureSignatureFields(task);
  const machineState = normalizeTrimmed(normalized.machineState);
  const docTypeFinal = normalizeTrimmed(normalized.docTypeFinal || DOC_TYPES.PASSPORT).toLowerCase();

  if (docTypeFinal !== DOC_TYPES.PASSPORT) {
    return '非护照记录不需要生成网站签字';
  }

  if (!normalized.classificationConfirmed) {
    return '先确认分类并保存当前字段，再生成网站签字';
  }

  if (!normalized.chineseNameFinal) {
    return '先补中文签字名，再生成网站签字';
  }

  if (!['completed', 'manual'].includes(machineState) && normalized.sourceType !== 'manual') {
    return '当前记录还没有处理完成，稍后再生成网站签字';
  }

  if (normalized.finalSignatureSource === MANUAL_SIGNATURE_SOURCE) {
    return '当前是手写补签，如需网站签字请先删除手写签字';
  }

  if (
    normalized.finalSignatureSource === WEBSITE_SIGNATURE_SOURCE &&
    normalizeTrimmed(normalized.finalSignaturePath)
  ) {
    return '网站签字已经生成，无需重复生成';
  }

  return '';
}

function buildSignatureCacheKey(chineseName, style) {
  const normalizedName = normalizeTrimmed(chineseName);
  const normalizedStyle = normalizeSignatureStyle(style);
  const digest = crypto
    .createHash('sha1')
    .update(`${normalizedName}::${normalizedStyle}`)
    .digest('hex');
  return `${digest}.png`;
}

module.exports = {
  DEFAULT_SIGNATURE_STYLE,
  MANUAL_SIGNATURE_SOURCE,
  SIGNATURE_STYLE_OPTIONS,
  WEBSITE_SIGNATURE_SOURCE,
  buildSignatureCacheKey,
  deriveSignatureJobStatus,
  ensureSignatureFields,
  getWebsiteSignatureEligibilityIssue,
  isEligibleForWebsiteGeneration,
  normalizeSignatureStyle,
  syncWebsiteSignatureAfterFieldChange,
};
