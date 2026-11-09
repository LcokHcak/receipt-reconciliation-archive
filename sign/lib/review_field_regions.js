const { DOC_TYPES } = require('./package_constants');

const PASSPORT_REGION_MAPPINGS = Object.freeze([
  {
    modelLabel: 'english_name_region',
    key: 'extractedNameFinal',
    label: '\u82f1\u6587\u540d',
  },
  {
    modelLabel: 'passport_no_region',
    key: 'passportNoFinal',
    label: '\u62a4\u7167\u53f7',
  },
  {
    modelLabel: 'chinese_name_region',
    key: 'chineseNameFinal',
    label: '\u4e2d\u6587\u7b7e\u5b57\u540d',
  },
]);

const RECEIPT_REGION_MAPPINGS = Object.freeze([
  {
    modelLabel: 'store_family_region',
    key: 'receiptStoreFinal',
    label: '\u514d\u7a0e\u5e97',
  },
  {
    modelLabel: 'receipt_no_region',
    key: 'receiptNoFinal',
    label: '\u5c0f\u7968\u53f7',
  },
  {
    modelLabel: 'group_no_region',
    key: 'groupNoFinal',
    label: '\u56e2\u53f7',
  },
  {
    modelLabel: 'purchase_date_region',
    key: 'purchaseDateFinal',
    label: '\u8d2d\u4e70\u65e5\u671f',
  },
  {
    modelLabel: 'departure_date_region',
    key: 'departureDateFinal',
    label: '\u51fa\u5883\u65e5\u671f',
  },
]);

function normalizeNumber(value) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function normalizeBox(box = {}) {
  if (!box || typeof box !== 'object') {
    return null;
  }

  const left = normalizeNumber(box.left);
  const top = normalizeNumber(box.top);
  const widthFromBox = normalizeNumber(box.width);
  const heightFromBox = normalizeNumber(box.height);
  const right = normalizeNumber(box.right);
  const bottom = normalizeNumber(box.bottom);
  const width = widthFromBox ?? (right !== null && left !== null ? right - left : null);
  const height = heightFromBox ?? (bottom !== null && top !== null ? bottom - top : null);

  if (left === null || top === null || width === null || height === null || width <= 0 || height <= 0) {
    return null;
  }

  return { left, top, width, height };
}

function pickFieldValue(meta = {}, modelLabel) {
  const field = meta.fields?.[modelLabel];
  return String(field?.value ?? field?.rawText ?? '').trim();
}

function buildRegionsFromMeta({ meta, mappings, fallbackSource }) {
  if (!meta || typeof meta !== 'object') {
    return [];
  }
  const detections = meta.detections && typeof meta.detections === 'object' ? meta.detections : {};
  const source = String(meta.source || fallbackSource || '').trim();
  return mappings
    .map((mapping) => {
      const detection = detections[mapping.modelLabel];
      const box = normalizeBox(detection?.box);
      if (!box) {
        return null;
      }
      return {
        key: mapping.key,
        label: mapping.label,
        modelLabel: mapping.modelLabel,
        confidence: normalizeNumber(detection?.confidence),
        source,
        value: pickFieldValue(meta, mapping.modelLabel),
        box,
      };
    })
    .filter(Boolean);
}

function buildTaskFieldRegions(task = {}) {
  const docType = String(task.docTypeFinal || task.docTypeAuto || task.docType || '').trim();
  if (docType === DOC_TYPES.PASSPORT) {
    return buildRegionsFromMeta({
      meta: task.passportFieldModelMeta,
      mappings: PASSPORT_REGION_MAPPINGS,
      fallbackSource: 'passport_field_model',
    });
  }
  if (docType === DOC_TYPES.RECEIPT) {
    return buildRegionsFromMeta({
      meta: task.receiptFieldModelMeta,
      mappings: RECEIPT_REGION_MAPPINGS,
      fallbackSource: 'receipt_field_model',
    });
  }
  return [];
}

module.exports = {
  buildTaskFieldRegions,
  normalizeBox,
};
