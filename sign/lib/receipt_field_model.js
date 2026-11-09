'use strict';

/**
 * 小票字段定位模型（receipt_find2）封装。
 *
 * 设计上镜像 passport_field_model.js，让调用方（passport_review_workbench）
 * 可以用一模一样的接口拿到 `detectImage` / `detectImages`，只是标签集换成
 * 小票字段集。
 *
 * 标签来源：model/receipt_find2/.../inference.yml 的 label_list
 *   - store_family_region      免税店大类（乐天/新罗/爱宝客…）
 *   - receipt_no_region        小票号
 *   - group_no_region          团号
 *   - purchase_date_region     购买日期
 *   - departure_date_region    出境日期
 *
 * 与 passport 的关键差别：
 *   - 每个字段的清洗规则不一样：receipt_no 是字母数字串、date 要能规整为
 *     YYYY-MM-DD、store_family 是一个枚举（乐天/新罗/HDC…）
 *   - mergeReceiptFieldModelAnalysis 的 target key 对齐现有
 *     analyzeDocumentOcr 里的 *Auto 字段（receiptNoAuto / groupNoAuto / …）
 *
 * 故意**不**取代 extractReceiptFieldsFromOcr：定位模型给出 cleaner 值，
 * 正则仍然作为 fallback。冲突时把 needsReview 置 true，让人工 review。
 */

const { DOC_TYPES } = require('./package_constants');
const { normalizeSpaces } = require('./paddle_passport_parser');
const { detectReceiptStoreFamily } = require('./receipt_store_family');
const { normalizeStoreFamily } = require('./validation/field_rules');
const { normalizeGroupNo, normalizeReceiptNo, normalizeReceiptNoDigits } = require('./workbench_field_normalizer');

const FIELD_LABELS = Object.freeze({
  STORE_FAMILY: 'store_family_region',
  RECEIPT_NO: 'receipt_no_region',
  GROUP_NO: 'group_no_region',
  PURCHASE_DATE: 'purchase_date_region',
  DEPARTURE_DATE: 'departure_date_region',
});

const CORE_FIELD_LABELS = Object.freeze([
  FIELD_LABELS.STORE_FAMILY,
  FIELD_LABELS.RECEIPT_NO,
  FIELD_LABELS.GROUP_NO,
  FIELD_LABELS.PURCHASE_DATE,
  FIELD_LABELS.DEPARTURE_DATE,
]);

const FIELD_TO_ANALYSIS_KEY = Object.freeze({
  [FIELD_LABELS.STORE_FAMILY]: 'receiptStoreAuto',
  [FIELD_LABELS.RECEIPT_NO]: 'receiptNoAuto',
  [FIELD_LABELS.GROUP_NO]: 'groupNoAuto',
  [FIELD_LABELS.PURCHASE_DATE]: 'purchaseDateAuto',
  [FIELD_LABELS.DEPARTURE_DATE]: 'departureDateAuto',
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
  if (width <= 0 || height <= 0) return null;
  return { left, top, right, bottom, width, height };
}

/**
 * 把 PaddleX 返回的 boxes 规整成按 label 的 map。
 * 置信度最高的那一条赢。
 */
function normalizeReceiptFieldDetections(rawResult = {}, threshold = 0.3) {
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
      return { label, confidence, box };
    })
    .filter(Boolean)
    .sort((left, right) => (
      right.confidence - left.confidence
      || left.box.top - right.box.top
      || left.box.left - right.box.left
    ));

  const fields = {};
  all.forEach((item) => {
    if (!fields[item.label]) fields[item.label] = item;
  });

  return { fields, all };
}

// ───────────────────── field cleaners ─────────────────────
// 每个字段从 OCR 出来的原始字符串里抓出规范值。和正则 fallback 相比，
// 这里因为已经知道"是哪个字段"，规则可以更紧。

function cleanReceiptNo(value) {
  // 存储口径委托中央 normalizeReceiptNo(保字母+横线)——曾是数字投影漂移副本,merge 层直接
  // 覆盖 receiptNoAuto 落盘,90G… 类字母票号被剥(2026-07-10 审计收口,与 cleanGroupNo 同款)。
  return normalizeReceiptNo(value);
  // 小票号常见格式：字母+数字，长度 6-16，允许 -. /
}

function cleanGroupNo(value) {
  // 团号清洗统一委托中央 normalizeGroupNo(剥标签前缀 G 25184、保字母团号 R2299001、"无"透传)。
  // 曾是本地自写正则的漂移副本——与中央口径对字母团号/标签的处理不一致(2026-07-03 体检收口)。
  const normalized = normalizeGroupNo(value);
  if (normalized === '无') return normalized;
  // 定位模型可能框到纯文字噪声:不含数字的串不当团号,返回空=合并层跳过
  return /\d/.test(normalized) ? normalized : '';
}

function cleanDate(value) {
  const raw = String(value || '');
  // 抓 YYYY-MM-DD / YYYY.MM.DD / YYYY/MM/DD / YY.MM.DD（韩国 ERP 风格）
  const patterns = [
    /([12]\d{3})[./-](\d{1,2})[./-](\d{1,2})/,
    /(\d{2})[./-](\d{1,2})[./-](\d{1,2})/,
  ];
  for (const p of patterns) {
    const m = raw.match(p);
    if (!m) continue;
    let year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (m[1].length === 2) year += 2000;
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  return '';
}

function cleanStoreFamily(value) {
  // 走现有的 detectReceiptStoreFamily，再把结果规整为统一字符串。
  // 这个函数内部已经处理了「乐天/新罗/爱宝客」等别名。
  const raw = String(value || '');
  const detection = detectReceiptStoreFamily({
    joinedText: raw,
    lines: [{ text: raw }],
  });
  if (detection && detection.displayName) return detection.displayName;
  return normalizeStoreFamily(raw) || normalizeSpaces(raw).toUpperCase();
}

function cleanReceiptFieldValue(label, value) {
  switch (label) {
    case FIELD_LABELS.RECEIPT_NO: return cleanReceiptNo(value);
    case FIELD_LABELS.GROUP_NO: return cleanGroupNo(value);
    case FIELD_LABELS.PURCHASE_DATE: return cleanDate(value);
    case FIELD_LABELS.DEPARTURE_DATE: return cleanDate(value);
    case FIELD_LABELS.STORE_FAMILY: return cleanStoreFamily(value);
    default: return normalizeSpaces(value);
  }
}

function normalizeForCompare(label, value) {
  if (label === FIELD_LABELS.STORE_FAMILY) return cleanStoreFamily(value);
  if (label === FIELD_LABELS.PURCHASE_DATE || label === FIELD_LABELS.DEPARTURE_DATE) {
    return cleanDate(value);
  }
  if (label === FIELD_LABELS.RECEIPT_NO) return normalizeReceiptNoDigits(value);
  // 团号比对走中央口径:旧的 replace(/\D/g,'') 会把字母团号 R2299001 剥成 2299001,
  // 造成"模型值 vs 正则值"假冲突/假一致(与团号表匹配失败是同一个旧 bug 的复现)。
  if (label === FIELD_LABELS.GROUP_NO) return normalizeGroupNo(value);
  return String(value || '').toUpperCase().replace(/\s+/g, '').replace(/[^A-Z0-9/-]/g, '');
}

function mergeReviewReasons(existingReasons = [], addedReasons = []) {
  return [...new Set([
    ...(Array.isArray(existingReasons) ? existingReasons : []),
    ...addedReasons,
  ].map((item) => String(item || '').trim()).filter(Boolean))];
}

/**
 * 把定位模型出来的字段，合并进 analyzeDocumentOcr 产出的 base 上。
 *
 * 策略（选项 A + C）：
 *   - 值优先取定位模型清洗后的值（精度更高）
 *   - 定位模型值和原正则值不一致时，打上 needsReview 并记录冲突原因
 *   - 定位模型出不来的字段不动（保留正则结果）
 *   - 不处理 non-receipt 文档
 */
function mergeReceiptFieldModelAnalysis({
  baseAnalysis = {},
  fieldValues = {},
  modelMeta = null,
} = {}) {
  if (baseAnalysis.docTypeFinal && baseAnalysis.docTypeFinal !== DOC_TYPES.RECEIPT) {
    return baseAnalysis;
  }

  const merged = { ...baseAnalysis };
  const conflictReasons = [];
  let used = false;

  CORE_FIELD_LABELS.forEach((label) => {
    const targetKey = FIELD_TO_ANALYSIS_KEY[label];
    if (!targetKey) return;

    const rawFieldValue = fieldValues[label];
    const rawValue = typeof rawFieldValue === 'object' && rawFieldValue !== null
      ? rawFieldValue.value
      : rawFieldValue;
    const cleanedValue = cleanReceiptFieldValue(label, rawValue);
    if (!cleanedValue) return;

    const existingValue = normalizeSpaces(merged[targetKey]);
    if (existingValue && normalizeForCompare(label, existingValue) !== normalizeForCompare(label, cleanedValue)) {
      conflictReasons.push(`receipt_field_model_${targetKey.replace(/Auto$/, '').replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`).replace(/^_/, '')}_conflict`);
    }
    merged[targetKey] = cleanedValue;
    used = true;
  });

  if (used) {
    merged.receiptFieldModelUsed = true;
    merged.receiptFieldModelMeta = modelMeta || null;
  } else {
    merged.receiptFieldModelUsed = false;
    merged.receiptFieldModelMeta = modelMeta || null;
  }

  if (conflictReasons.length) {
    merged.needsReview = true;
    merged.reviewReasons = mergeReviewReasons(merged.reviewReasons, conflictReasons);
  }

  return merged;
}

function createReceiptFieldModel({
  modelConfig = {},
  runner,
} = {}) {
  async function detectImage({ imagePath } = {}) {
    if (!modelConfig.enabled || !modelConfig.ready || !runner) return null;

    const rawResult = await runner.detectRegions({
      imagePath,
      modelDir: modelConfig.modelDir,
      modelName: modelConfig.modelName,
      threshold: modelConfig.threshold,
    });

    const normalized = normalizeReceiptFieldDetections(rawResult, modelConfig.threshold);
    return {
      imagePath,
      ...normalized,
      modelMeta: {
        source: 'paddlex_receipt_field_detection',
        modelName: modelConfig.modelName,
        modelDir: modelConfig.modelDir,
        threshold: modelConfig.threshold,
      },
    };
  }

  async function detectImages({ imagePaths = [] } = {}) {
    if (!modelConfig.enabled || !modelConfig.ready || !runner
        || !Array.isArray(imagePaths) || !imagePaths.length) {
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
        return { imagePath: item.image, error: item.error };
      }
      const normalized = normalizeReceiptFieldDetections(item, modelConfig.threshold);
      return {
        imagePath: item.image,
        ...normalized,
        modelMeta: {
          source: 'paddlex_receipt_field_detection',
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
  cleanReceiptFieldValue,
  createReceiptFieldModel,
  mergeReceiptFieldModelAnalysis,
  normalizeForCompare, // 导出仅为测试锁口径(团号比对曾有剥字母漂移副本)
  normalizeReceiptFieldDetections,
};
