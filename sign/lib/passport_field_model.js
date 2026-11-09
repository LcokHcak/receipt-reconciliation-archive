const { DOC_TYPES } = require('./package_constants');
const {
  cleanEnglishName,
  extractPassportLikeTokens,
  normalizeAlnum,
  normalizeSpaces,
} = require('./paddle_passport_parser');

const FIELD_LABELS = Object.freeze({
  PASSPORT_NO: 'passport_no_region',
  ENGLISH_NAME: 'english_name_region',
  CHINESE_NAME: 'chinese_name_region',
  MRZ_LINE1: 'mrz_line1_region',
  MRZ_LINE2: 'mrz_line2_region',
});

const CORE_FIELD_LABELS = Object.freeze([
  FIELD_LABELS.PASSPORT_NO,
  FIELD_LABELS.ENGLISH_NAME,
  FIELD_LABELS.CHINESE_NAME,
]);

const FIELD_TO_ANALYSIS_KEY = Object.freeze({
  [FIELD_LABELS.PASSPORT_NO]: 'passportNoAuto',
  [FIELD_LABELS.ENGLISH_NAME]: 'extractedNameAuto',
  [FIELD_LABELS.CHINESE_NAME]: 'chineseNameAuto',
});

function toFiniteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeBox(rawBox = {}) {
  const coordinate = Array.isArray(rawBox.coordinate)
    ? rawBox.coordinate
    : (Array.isArray(rawBox.bbox) ? rawBox.bbox : rawBox.box);
  if (!Array.isArray(coordinate) || coordinate.length < 4) {
    return null;
  }

  const left = toFiniteNumber(coordinate[0]);
  const top = toFiniteNumber(coordinate[1]);
  const right = toFiniteNumber(coordinate[2]);
  const bottom = toFiniteNumber(coordinate[3]);
  const width = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);
  if (width <= 0 || height <= 0) {
    return null;
  }

  return { left, top, right, bottom, width, height };
}

function normalizePassportFieldDetections(rawResult = {}, threshold = 0.3) {
  const validLabels = new Set(Object.values(FIELD_LABELS));
  const minScore = toFiniteNumber(threshold, 0.3);
  const all = (Array.isArray(rawResult.boxes) ? rawResult.boxes : [])
    .map((rawBox) => {
      const label = String(rawBox.label ?? rawBox.className ?? rawBox.name ?? '').trim();
      const confidence = toFiniteNumber(rawBox.score ?? rawBox.confidence, 0);
      const box = normalizeBox(rawBox);
      if (!validLabels.has(label) || !box || confidence < minScore) {
        return null;
      }
      return {
        label,
        confidence,
        box,
      };
    })
    .filter(Boolean)
    .sort((left, right) => (
      right.confidence - left.confidence
      || left.box.top - right.box.top
      || left.box.left - right.box.left
    ));

  const fields = {};
  all.forEach((item) => {
    if (!fields[item.label]) {
      fields[item.label] = item;
    }
  });

  return { fields, all };
}

function cleanChineseName(value) {
  const cjkOnly = String(value || '').replace(/[^\u3400-\u9fff]/gu, '');
  return cjkOnly.length >= 2 && cjkOnly.length <= 10 ? cjkOnly : '';
}

function cleanPassportNumber(value) {
  const token = extractPassportLikeTokens(value)[0] || normalizeAlnum(value);
  return /^[A-Z]{1,2}\d{7,8}$/.test(token) ? token : '';
}

function cleanPassportFieldValue(label, value) {
  if (label === FIELD_LABELS.PASSPORT_NO) {
    return cleanPassportNumber(value);
  }
  if (label === FIELD_LABELS.ENGLISH_NAME) {
    const cleaned = cleanEnglishName(value);
    return /^(?=.{2,50}$)[A-Z]+(?: [A-Z]+)*$/.test(cleaned) ? cleaned : '';
  }
  if (label === FIELD_LABELS.CHINESE_NAME) {
    return cleanChineseName(value);
  }
  return normalizeSpaces(value);
}

function normalizeForCompare(label, value) {
  if (label === FIELD_LABELS.CHINESE_NAME) {
    return cleanChineseName(value);
  }
  if (label === FIELD_LABELS.PASSPORT_NO) {
    return cleanPassportNumber(value) || normalizeAlnum(value);
  }
  if (label === FIELD_LABELS.ENGLISH_NAME) {
    return cleanEnglishName(value);
  }
  return normalizeSpaces(value);
}

function mergeReviewReasons(existingReasons = [], addedReasons = []) {
  return [...new Set([
    ...(Array.isArray(existingReasons) ? existingReasons : []),
    ...addedReasons,
  ].map((item) => String(item || '').trim()).filter(Boolean))];
}

function mergePassportFieldModelAnalysis({
  baseAnalysis = {},
  fieldValues = {},
  modelMeta = null,
} = {}) {
  if (baseAnalysis.docTypeFinal && baseAnalysis.docTypeFinal !== DOC_TYPES.PASSPORT) {
    return baseAnalysis;
  }

  const merged = { ...baseAnalysis };
  const conflictReasons = [];
  let used = false;

  CORE_FIELD_LABELS.forEach((label) => {
    const targetKey = FIELD_TO_ANALYSIS_KEY[label];
    const rawFieldValue = fieldValues[label];
    const rawValue = typeof rawFieldValue === 'object' && rawFieldValue !== null
      ? rawFieldValue.value
      : rawFieldValue;
    const cleanedValue = cleanPassportFieldValue(label, rawValue);
    if (!cleanedValue) {
      return;
    }

    const existingValue = normalizeSpaces(merged[targetKey]);
    if (existingValue && normalizeForCompare(label, existingValue) !== normalizeForCompare(label, cleanedValue)) {
      conflictReasons.push(`passport_field_model_${targetKey.replace(/Auto$/, '').replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`).replace(/^_/, '')}_conflict`);
    }
    merged[targetKey] = cleanedValue;
    used = true;
  });

  if (used) {
    merged.passportFieldModelUsed = true;
    merged.passportFieldModelMeta = modelMeta || null;
  } else {
    merged.passportFieldModelUsed = false;
    merged.passportFieldModelMeta = modelMeta || null;
  }

  if (conflictReasons.length) {
    merged.needsReview = true;
    merged.reviewReasons = mergeReviewReasons(merged.reviewReasons, conflictReasons);
  }

  return merged;
}

function createPassportFieldModel({
  modelConfig = {},
  runner,
} = {}) {
  async function detectImage({ imagePath } = {}) {
    if (!modelConfig.enabled || !modelConfig.ready || !runner) {
      return null;
    }

    const rawResult = await runner.detectRegions({
      imagePath,
      modelDir: modelConfig.modelDir,
      modelName: modelConfig.modelName,
      threshold: modelConfig.threshold,
    });

    const normalized = normalizePassportFieldDetections(rawResult, modelConfig.threshold);
    return {
      imagePath,
      ...normalized,
      modelMeta: {
        source: 'paddlex_passport_field_detection',
        modelName: modelConfig.modelName,
        modelDir: modelConfig.modelDir,
        threshold: modelConfig.threshold,
      },
    };
  }

  async function detectImages({ imagePaths = [] } = {}) {
    if (!modelConfig.enabled || !modelConfig.ready || !runner || !Array.isArray(imagePaths) || !imagePaths.length) {
      return [];
    }
    if (typeof runner.detectRegionsForImages !== 'function') {
      const results = [];
      for (const imagePath of imagePaths) {
        try {
          results.push(await detectImage({ imagePath }));
        } catch (error) {
          results.push({ imagePath, error: String(error?.message || error) });
        }
      }
      return results;
    }

    const rawResult = await runner.detectRegionsForImages({
      imagePaths,
      modelDir: modelConfig.modelDir,
      modelName: modelConfig.modelName,
      threshold: modelConfig.threshold,
    });
    return (Array.isArray(rawResult.results) ? rawResult.results : []).map((item) => {
      if (item.error) {
        return {
          imagePath: item.image,
          error: item.error,
        };
      }
      const normalized = normalizePassportFieldDetections(item, modelConfig.threshold);
      return {
        imagePath: item.image,
        ...normalized,
        modelMeta: {
          source: 'paddlex_passport_field_detection',
          modelName: modelConfig.modelName,
          modelDir: modelConfig.modelDir,
          threshold: modelConfig.threshold,
        },
      };
    });
  }

  return {
    detectImage,
    detectImages,
  };
}

module.exports = {
  CORE_FIELD_LABELS,
  FIELD_LABELS,
  cleanPassportFieldValue,
  createPassportFieldModel,
  mergePassportFieldModelAnalysis,
  normalizePassportFieldDetections,
};
