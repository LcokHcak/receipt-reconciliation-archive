const fs = require('node:fs');
const path = require('node:path');

const { DOC_TYPES } = require('./package_constants');

function normalizeDocType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'ticket') {
    return DOC_TYPES.OTHER;
  }
  return [DOC_TYPES.PASSPORT, DOC_TYPES.RECEIPT, DOC_TYPES.OTHER].includes(normalized) ? normalized : '';
}

function normalizeReviewNote(value) {
  return String(value || '').trim();
}

function buildSourceKey(inputDir, sourcePath) {
  const root = path.resolve(String(inputDir || ''));
  const absoluteSource = path.resolve(String(sourcePath || ''));
  const relative = path.relative(root, absoluteSource);

  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return path.basename(absoluteSource);
  }

  return relative.split(path.sep).join('/');
}

function toOverrideMapEntries(payload) {
  if (!payload) {
    return [];
  }

  if (Array.isArray(payload)) {
    return payload;
  }

  if (Array.isArray(payload.entries)) {
    return payload.entries;
  }

  if (payload.overrides && typeof payload.overrides === 'object') {
    return Object.entries(payload.overrides).map(([sourceKey, value]) => ({
      sourceKey,
      ...value,
    }));
  }

  if (typeof payload === 'object') {
    return Object.entries(payload).map(([sourceKey, value]) => ({
      sourceKey,
      ...value,
    }));
  }

  return [];
}

function normalizeOverrideRecord(record) {
  if (!record || typeof record !== 'object') {
    return null;
  }

  const sourceKey = String(record.sourceKey || record.sourcePath || '').trim();
  const docTypeFinal = normalizeDocType(record.docTypeFinal || record.docType);
  const reviewNote = normalizeReviewNote(record.reviewNote);

  if (!sourceKey || !docTypeFinal) {
    return null;
  }

  return {
    sourceKey,
    docTypeFinal,
    reviewNote,
  };
}

function loadManualOverrides(input) {
  if (!input) {
    return new Map();
  }

  let payload = input;
  if (typeof input === 'string') {
    const filePath = path.resolve(input);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Manual override file not found: ${filePath}`);
    }
    payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }

  const overrides = new Map();
  for (const record of toOverrideMapEntries(payload)) {
    const normalized = normalizeOverrideRecord(record);
    if (!normalized) {
      continue;
    }
    overrides.set(normalized.sourceKey, {
      docTypeFinal: normalized.docTypeFinal,
      reviewNote: normalized.reviewNote,
    });
  }

  return overrides;
}

function applyManualOverride(entry, overrides) {
  const override = overrides.get(entry.sourceKey) || overrides.get(entry.sourcePath) || null;
  const docTypeAuto = normalizeDocType(entry.docTypeAuto || entry.predictedDocType || DOC_TYPES.OTHER) || DOC_TYPES.OTHER;
  const docTypeFinal = override?.docTypeFinal || docTypeAuto;

  return {
    ...entry,
    docTypeAuto,
    docTypeFinal,
    manualOverride: Boolean(override),
    manualReviewNote: override?.reviewNote || '',
  };
}

function summarizeDocTypes(entries, fieldName = 'docTypeFinal') {
  return entries.reduce((counts, entry) => {
    const key = normalizeDocType(entry?.[fieldName]);
    if (!key) {
      return counts;
    }
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

module.exports = {
  applyManualOverride,
  buildSourceKey,
  loadManualOverrides,
  normalizeDocType,
  summarizeDocTypes,
};
