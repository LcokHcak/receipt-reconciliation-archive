const fs = require('node:fs');
const path = require('node:path');

function envFlag(value, fallback = false) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    return fallback;
  }
  return /^(1|true|yes|on)$/i.test(normalized);
}

function numberFromEnv(value, fallback) {
  const parsed = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function hasCompleteModelArtifacts(modelDir) {
  const resolvedDir = String(modelDir || '').trim();
  if (!resolvedDir) {
    return false;
  }
  return ['inference.yml', 'inference.json', 'inference.pdiparams']
    .every((fileName) => fs.existsSync(path.join(resolvedDir, fileName)));
}

function createModelArtifactRegistry({
  projectRoot,
  env = process.env,
} = {}) {
  if (!projectRoot) {
    throw new Error('projectRoot is required');
  }

  const enabled = envFlag(env.SIGN_ENABLE_MODEL_PIPELINE, true);
  const pythonExe = String(env.SIGN_PADDLEX_PYTHON_EXE || '').trim()
    || path.resolve(projectRoot, '..', '_pdx_runtime', 'Scripts', 'python.exe');
  const detectionModelDir = String(env.SIGN_SPLIT_DET_MODEL_DIR || env.SIGN_MIX_DET_MODEL_DIR || '').trim()
    || path.join(projectRoot, 'model', 'mix', 'model', 'general_object_detection_module');
  const classificationModelDir = String(env.SIGN_DOC_CLS_MODEL_DIR || env.SIGN_ANALYSE_CLS_MODEL_DIR || '').trim()
    || path.join(projectRoot, 'model', 'analyse', 'model', 'general_image_classification_module');
  const passportFieldDetectionModelDir = String(env.SIGN_PASSPORT_FIELD_DET_MODEL_DIR || '').trim()
    || path.join(projectRoot, 'model', 'passport_find2', 'model', 'general_object_detection_module');
  const receiptFieldDetectionModelDir = String(env.SIGN_RECEIPT_FIELD_DET_MODEL_DIR || '').trim()
    || path.join(projectRoot, 'model', 'receipt_find2', 'model', 'general_object_detection_module');

  return Object.freeze({
    enabled,
    pythonExe,
    detection: Object.freeze({
      enabled,
      modelDir: detectionModelDir,
      modelName: String(env.SIGN_SPLIT_DET_MODEL_NAME || 'PP-YOLOE_plus-L').trim() || 'PP-YOLOE_plus-L',
      threshold: numberFromEnv(env.SIGN_SPLIT_DET_THRESHOLD, 0.45),
      ready: hasCompleteModelArtifacts(detectionModelDir),
    }),
    classification: Object.freeze({
      enabled,
      modelDir: classificationModelDir,
      modelName: String(env.SIGN_DOC_CLS_MODEL_NAME || 'PP-HGNetV2-B6').trim() || 'PP-HGNetV2-B6',
      minConfidence: numberFromEnv(env.SIGN_DOC_CLS_MIN_CONFIDENCE, 0.7),
      minMargin: numberFromEnv(env.SIGN_DOC_CLS_MIN_MARGIN, 0.12),
      ready: hasCompleteModelArtifacts(classificationModelDir),
    }),
    passportFieldDetection: Object.freeze({
      enabled,
      modelDir: passportFieldDetectionModelDir,
      modelName: String(env.SIGN_PASSPORT_FIELD_DET_MODEL_NAME || 'PP-YOLOE_plus-L').trim() || 'PP-YOLOE_plus-L',
      threshold: numberFromEnv(env.SIGN_PASSPORT_FIELD_DET_THRESHOLD, 0.3),
      ready: hasCompleteModelArtifacts(passportFieldDetectionModelDir),
    }),
    receiptFieldDetection: Object.freeze({
      enabled,
      modelDir: receiptFieldDetectionModelDir,
      modelName: String(env.SIGN_RECEIPT_FIELD_DET_MODEL_NAME || 'PP-YOLOE_plus-S').trim() || 'PP-YOLOE_plus-S',
      threshold: numberFromEnv(env.SIGN_RECEIPT_FIELD_DET_THRESHOLD, 0.3),
      ready: hasCompleteModelArtifacts(receiptFieldDetectionModelDir),
    }),
  });
}

module.exports = {
  createModelArtifactRegistry,
  envFlag,
  hasCompleteModelArtifacts,
};
