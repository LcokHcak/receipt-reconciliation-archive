const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createModelArtifactRegistry } = require('../lib/model_artifact_registry');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'model-registry-'));
}

function touchArtifactSet(modelDir) {
  fs.mkdirSync(modelDir, { recursive: true });
  fs.writeFileSync(path.join(modelDir, 'inference.yml'), 'Global:\n  model_name: test\n');
  fs.writeFileSync(path.join(modelDir, 'inference.json'), '{}\n');
  fs.writeFileSync(path.join(modelDir, 'inference.pdiparams'), 'params');
}

test('createModelArtifactRegistry builds default PaddleX model locations', () => {
  const projectRoot = 'D:\\app\\sign';
  const registry = createModelArtifactRegistry({
    projectRoot,
    env: {},
  });

  assert.equal(registry.enabled, true);
  assert.equal(registry.pythonExe, path.resolve(projectRoot, '..', '_pdx_runtime', 'Scripts', 'python.exe'));
  assert.equal(registry.detection.modelName, 'PP-YOLOE_plus-L');
  assert.equal(
    registry.detection.modelDir,
    path.join(projectRoot, 'model', 'mix', 'model', 'general_object_detection_module')
  );
  assert.equal(registry.classification.modelName, 'PP-HGNetV2-B6');
  assert.equal(
    registry.classification.modelDir,
    path.join(projectRoot, 'model', 'analyse', 'model', 'general_image_classification_module')
  );
  assert.equal(registry.passportFieldDetection.modelName, 'PP-YOLOE_plus-L');
  assert.equal(registry.passportFieldDetection.threshold, 0.3);
  assert.equal(
    registry.passportFieldDetection.modelDir,
    path.join(projectRoot, 'model', 'passport_find2', 'model', 'general_object_detection_module')
  );
  assert.equal(registry.receiptFieldDetection.modelName, 'PP-YOLOE_plus-S');
  assert.equal(registry.receiptFieldDetection.threshold, 0.3);
  assert.equal(
    registry.receiptFieldDetection.modelDir,
    path.join(projectRoot, 'model', 'receipt_find2', 'model', 'general_object_detection_module')
  );
  assert.equal(registry.detection.ready, false);
  assert.equal(registry.classification.ready, false);
  assert.equal(registry.passportFieldDetection.ready, false);
  assert.equal(registry.receiptFieldDetection.ready, false);
});

test('createModelArtifactRegistry honors explicit runtime and model overrides', () => {
  const tempRoot = makeTempDir();

  try {
    const detectionDir = path.join(tempRoot, 'det');
    const classificationDir = path.join(tempRoot, 'cls');
    const passportFieldDir = path.join(tempRoot, 'passport-field');
    const receiptFieldDir = path.join(tempRoot, 'receipt-field');
    touchArtifactSet(detectionDir);
    touchArtifactSet(classificationDir);
    touchArtifactSet(passportFieldDir);
    touchArtifactSet(receiptFieldDir);

    const registry = createModelArtifactRegistry({
      projectRoot: tempRoot,
      env: {
        SIGN_ENABLE_MODEL_PIPELINE: 'true',
        SIGN_PADDLEX_PYTHON_EXE: 'C:\\runtime\\python.exe',
        SIGN_SPLIT_DET_MODEL_DIR: detectionDir,
        SIGN_SPLIT_DET_MODEL_NAME: 'CustomDet',
        SIGN_DOC_CLS_MODEL_DIR: classificationDir,
        SIGN_DOC_CLS_MODEL_NAME: 'CustomCls',
        SIGN_PASSPORT_FIELD_DET_MODEL_DIR: passportFieldDir,
        SIGN_PASSPORT_FIELD_DET_MODEL_NAME: 'CustomPassportDet',
        SIGN_PASSPORT_FIELD_DET_THRESHOLD: '0.42',
        SIGN_RECEIPT_FIELD_DET_MODEL_DIR: receiptFieldDir,
        SIGN_RECEIPT_FIELD_DET_MODEL_NAME: 'CustomReceiptDet',
        SIGN_RECEIPT_FIELD_DET_THRESHOLD: '0.37',
        SIGN_SPLIT_DET_THRESHOLD: '0.62',
        SIGN_DOC_CLS_MIN_CONFIDENCE: '0.71',
      },
    });

    assert.equal(registry.pythonExe, 'C:\\runtime\\python.exe');
    assert.equal(registry.detection.modelDir, detectionDir);
    assert.equal(registry.detection.modelName, 'CustomDet');
    assert.equal(registry.detection.threshold, 0.62);
    assert.equal(registry.detection.ready, true);
    assert.equal(registry.classification.modelDir, classificationDir);
    assert.equal(registry.classification.modelName, 'CustomCls');
    assert.equal(registry.classification.minConfidence, 0.71);
    assert.equal(registry.classification.ready, true);
    assert.equal(registry.passportFieldDetection.modelDir, passportFieldDir);
    assert.equal(registry.passportFieldDetection.modelName, 'CustomPassportDet');
    assert.equal(registry.passportFieldDetection.threshold, 0.42);
    assert.equal(registry.passportFieldDetection.ready, true);
    assert.equal(registry.receiptFieldDetection.modelDir, receiptFieldDir);
    assert.equal(registry.receiptFieldDetection.modelName, 'CustomReceiptDet');
    assert.equal(registry.receiptFieldDetection.threshold, 0.37);
    assert.equal(registry.receiptFieldDetection.ready, true);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('createModelArtifactRegistry can disable model pipeline explicitly', () => {
  const registry = createModelArtifactRegistry({
    projectRoot: 'D:\\app\\sign',
    env: {
      SIGN_ENABLE_MODEL_PIPELINE: 'false',
    },
  });

  assert.equal(registry.enabled, false);
  assert.equal(registry.detection.enabled, false);
  assert.equal(registry.classification.enabled, false);
  assert.equal(registry.passportFieldDetection.enabled, false);
  assert.equal(registry.receiptFieldDetection.enabled, false);
});
