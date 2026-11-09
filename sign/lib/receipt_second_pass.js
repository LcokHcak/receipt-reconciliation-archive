const fs = require('node:fs');
const path = require('node:path');
const { readJsonFile } = require('./json_file_utils');

const WORKSPACE_ROOT = path.resolve(__dirname, '..', '..');
const ACTIVE_CONFIG_PATH = path.join(WORKSPACE_ROOT, 'ppocrlabel', 'training', 'receipt_ocr_active.json');
const DEFAULT_INFERENCE_DIR_NAME = 'inference';

function resolveInferenceDir(explicitDir, modelDir) {
  const normalizedExplicitDir = String(explicitDir || '').trim();
  if (normalizedExplicitDir) {
    return normalizedExplicitDir;
  }

  const normalizedModelDir = String(modelDir || '').trim();
  if (!normalizedModelDir) {
    return '';
  }

  return path.join(normalizedModelDir, DEFAULT_INFERENCE_DIR_NAME);
}

function hasInferenceArtifacts(inferenceDir) {
  if (!inferenceDir || !fs.existsSync(inferenceDir)) {
    return false;
  }

  return ['inference.pdmodel', 'inference.pdiparams'].every((fileName) => (
    fs.existsSync(path.join(inferenceDir, fileName))
  ));
}

function getReceiptSecondPassConfig() {
  if (!fs.existsSync(ACTIVE_CONFIG_PATH)) {
    return null;
  }

  const config = readJsonFile(ACTIVE_CONFIG_PATH);
  if (config.usage !== 'receipt_second_pass_custom_det_rec') {
    return null;
  }

  const detInferenceDir = resolveInferenceDir(config.active_det_inference_dir, config.active_det_model_dir);
  const recInferenceDir = resolveInferenceDir(config.active_rec_inference_dir, config.active_rec_model_dir);
  if (!hasInferenceArtifacts(detInferenceDir) || !hasInferenceArtifacts(recInferenceDir)) {
    return null;
  }

  const detLabel = path.basename(String(config.active_det_model_dir || detInferenceDir));
  const recLabel = path.basename(String(config.active_rec_model_dir || recInferenceDir));

  return {
    manifestPath: ACTIVE_CONFIG_PATH,
    detInferenceDir,
    recInferenceDir,
    modelLabel: `${detLabel} + ${recLabel}`,
    options: {
      detModelDir: detInferenceDir,
      recModelDir: recInferenceDir,
      recCharDictPath: String(config.rec_char_dict_path || '').trim() || undefined,
      recAlgorithm: String(config.rec_algorithm || '').trim() || undefined,
      recImageShape: String(config.rec_image_shape || '').trim() || undefined,
      maxTextLength: Number.isFinite(Number(config.max_text_length))
        ? Number(config.max_text_length)
        : undefined,
    },
  };
}

module.exports = {
  ACTIVE_CONFIG_PATH,
  getReceiptSecondPassConfig,
};
