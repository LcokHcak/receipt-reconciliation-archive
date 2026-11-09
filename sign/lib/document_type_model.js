const { DOC_TYPES } = require('./package_constants');

function toFiniteScore(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(6)) : 0;
}

function normalizeDocTypeLabel(label) {
  const normalized = String(label || '').trim().toLowerCase();
  if (normalized === DOC_TYPES.PASSPORT || normalized === DOC_TYPES.RECEIPT || normalized === DOC_TYPES.OTHER) {
    return normalized;
  }
  return DOC_TYPES.OTHER;
}

function normalizeClassification(rawResult = {}) {
  const classes = Array.isArray(rawResult.classes) ? rawResult.classes : [];
  const normalizedClasses = classes
    .map((item) => ({
      label: normalizeDocTypeLabel(item.label ?? item.name ?? item.className),
      score: toFiniteScore(item.score ?? item.confidence),
      classId: Number.isFinite(Number(item.classId ?? item.cls_id)) ? Number(item.classId ?? item.cls_id) : null,
    }))
    .sort((left, right) => right.score - left.score);

  const scores = {
    [DOC_TYPES.PASSPORT]: 0,
    [DOC_TYPES.RECEIPT]: 0,
    [DOC_TYPES.OTHER]: 0,
  };
  normalizedClasses.forEach((item) => {
    scores[item.label] = Math.max(scores[item.label] || 0, item.score);
  });

  return { classes: normalizedClasses, scores };
}

function createDocumentTypeModel({
  modelConfig = {},
  runner,
} = {}) {
  function buildClassification(rawResult = {}) {
    const normalized = normalizeClassification(rawResult);
    const best = normalized.classes[0];
    if (!best) {
      return {
        docType: DOC_TYPES.OTHER,
        confidence: 0,
        scores: normalized.scores,
        needsReview: true,
        reviewReasons: ['model_no_prediction'],
        modelMeta: {
          source: 'paddlex_image_classification',
          modelName: modelConfig.modelName,
          modelDir: modelConfig.modelDir,
          classes: [],
        },
      };
    }

    const second = normalized.classes[1] || { score: 0 };
    const minConfidence = toFiniteScore(modelConfig.minConfidence ?? 0.7);
    const minMargin = toFiniteScore(modelConfig.minMargin ?? 0.12);
    const reviewReasons = [];
    if (best.score < minConfidence) {
      reviewReasons.push('low_model_confidence');
    }
    if ((best.score - second.score) < minMargin) {
      reviewReasons.push('ambiguous_model_scores');
    }

    return {
      docType: best.label,
      confidence: best.score,
      scores: normalized.scores,
      needsReview: reviewReasons.length > 0,
      reviewReasons,
      modelMeta: {
        source: 'paddlex_image_classification',
        modelName: modelConfig.modelName,
        modelDir: modelConfig.modelDir,
        classes: normalized.classes,
      },
    };
  }

  async function classifyImage({ imagePath } = {}) {
    if (!modelConfig.enabled || !modelConfig.ready || !runner) {
      return null;
    }

    const rawResult = await runner.classifyImage({
      imagePath,
      modelDir: modelConfig.modelDir,
      modelName: modelConfig.modelName,
    });
    return buildClassification(rawResult);
  }

  async function classifyImages({ imagePaths = [] } = {}) {
    if (!modelConfig.enabled || !modelConfig.ready || !runner) {
      return [];
    }

    if (!Array.isArray(imagePaths) || !imagePaths.length || typeof runner.classifyImages !== 'function') {
      return [];
    }

    const rawResult = await runner.classifyImages({
      imagePaths,
      modelDir: modelConfig.modelDir,
      modelName: modelConfig.modelName,
    });
    const results = Array.isArray(rawResult.results) ? rawResult.results : [];
    return results.map((item) => ({
      imagePath: item.image,
      error: item.error || '',
      classification: item.error ? null : buildClassification(item),
    }));
  }

  return {
    classifyImages,
    classifyImage,
  };
}

module.exports = {
  createDocumentTypeModel,
  normalizeClassification,
  normalizeDocTypeLabel,
};
