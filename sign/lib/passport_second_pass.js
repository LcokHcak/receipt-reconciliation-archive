const fs = require('node:fs');
const path = require('node:path');
const { readJsonFile } = require('./json_file_utils');

const WORKSPACE_ROOT = path.resolve(__dirname, '..', '..');
const ACTIVE_CONFIG_PATH = path.join(WORKSPACE_ROOT, 'ppocrlabel', 'training', 'passport_rec_active.json');
const DEFAULT_INFERENCE_DIR_NAME = 'inference';

function resolveInferenceDir(config = {}) {
  const explicitDir = String(config.active_inference_dir || '').trim();
  if (explicitDir) {
    return explicitDir;
  }

  const modelDir = String(config.active_model_dir || '').trim();
  if (!modelDir) {
    return '';
  }

  return path.join(modelDir, DEFAULT_INFERENCE_DIR_NAME);
}

function hasInferenceArtifacts(inferenceDir) {
  if (!inferenceDir || !fs.existsSync(inferenceDir)) {
    return false;
  }

  return ['inference.pdmodel', 'inference.pdiparams'].every((fileName) => (
    fs.existsSync(path.join(inferenceDir, fileName))
  ));
}

function getPassportSecondPassConfig() {
  if (!fs.existsSync(ACTIVE_CONFIG_PATH)) {
    return null;
  }

  const config = readJsonFile(ACTIVE_CONFIG_PATH);
  if (config.usage !== 'passport_second_pass_rec_only') {
    return null;
  }

  const inferenceDir = resolveInferenceDir(config);
  if (!hasInferenceArtifacts(inferenceDir)) {
    return null;
  }

  return {
    manifestPath: ACTIVE_CONFIG_PATH,
    inferenceDir,
    modelLabel: path.basename(String(config.active_model_dir || inferenceDir)),
    options: {
      recModelDir: inferenceDir,
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
  getPassportSecondPassConfig,
};
