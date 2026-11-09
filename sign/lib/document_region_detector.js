const { DOC_TYPES } = require('./package_constants');

function toFiniteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeRegionDocType(label) {
  const normalized = String(label || '')
    .trim()
    .toLowerCase()
    .replace(/_region$/, '');
  if (normalized === DOC_TYPES.PASSPORT || normalized === DOC_TYPES.RECEIPT || normalized === DOC_TYPES.OTHER) {
    return normalized;
  }
  return '';
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

function normalizeDetectionRegions(rawResult = {}, threshold = 0.5) {
  const boxes = Array.isArray(rawResult.boxes) ? rawResult.boxes : [];
  return boxes
    .map((rawBox) => {
      const confidence = toFiniteNumber(rawBox.score ?? rawBox.confidence, 0);
      const docType = normalizeRegionDocType(rawBox.label ?? rawBox.className ?? rawBox.name);
      const box = normalizeBox(rawBox);
      if (!docType || !box || confidence < threshold) {
        return null;
      }
      return {
        label: String(rawBox.label || '').trim(),
        docType,
        confidence,
        box,
      };
    })
    .filter(Boolean)
    .sort((left, right) => (left.box.top - right.box.top) || (left.box.left - right.box.left));
}

function createDocumentRegionDetector({
  modelConfig = {},
  runner,
  minRegionCount = 2,
} = {}) {
  async function detectRegions({ imagePath } = {}) {
    const enabled = Boolean(modelConfig.enabled && modelConfig.ready && runner);
    if (!enabled) {
      return {
        enabled: false,
        splitRecommended: false,
        regions: [],
      };
    }

    const rawResult = await runner.detectRegions({
      imagePath,
      modelDir: modelConfig.modelDir,
      modelName: modelConfig.modelName,
      threshold: modelConfig.threshold,
    });
    const regions = normalizeDetectionRegions(rawResult, toFiniteNumber(modelConfig.threshold, 0.5));

    return {
      enabled: true,
      splitRecommended: regions.length >= minRegionCount,
      regions,
      modelMeta: {
        source: 'paddlex_object_detection',
        modelName: modelConfig.modelName,
        modelDir: modelConfig.modelDir,
      },
    };
  }

  return {
    detectRegions,
  };
}

module.exports = {
  createDocumentRegionDetector,
  normalizeDetectionRegions,
  normalizeRegionDocType,
};
