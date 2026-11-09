const test = require('node:test');
const assert = require('node:assert/strict');

const { createDocumentTypeModel } = require('../lib/document_type_model');
const { DOC_TYPES } = require('../lib/package_constants');

test('document type model maps the top PaddleX class into a document classification', async () => {
  const model = createDocumentTypeModel({
    modelConfig: {
      enabled: true,
      ready: true,
      modelDir: 'cls',
      modelName: 'PP-HGNetV2-B6',
      minConfidence: 0.7,
      minMargin: 0.15,
    },
    runner: {
      classifyImage: async () => ({
        classes: [
          { label: 'receipt', score: 0.91, classId: 1 },
          { label: 'other', score: 0.05, classId: 2 },
          { label: 'passport', score: 0.04, classId: 0 },
        ],
      }),
    },
  });

  const result = await model.classifyImage({ imagePath: 'receipt.jpg' });

  assert.equal(result.docType, DOC_TYPES.RECEIPT);
  assert.equal(result.confidence, 0.91);
  assert.equal(result.needsReview, false);
  assert.deepEqual(result.scores, {
    passport: 0.04,
    receipt: 0.91,
    other: 0.05,
  });
  assert.equal(result.modelMeta.source, 'paddlex_image_classification');
});

test('document type model marks weak or ambiguous model predictions for review', async () => {
  const model = createDocumentTypeModel({
    modelConfig: {
      enabled: true,
      ready: true,
      modelDir: 'cls',
      modelName: 'PP-HGNetV2-B6',
      minConfidence: 0.7,
      minMargin: 0.2,
    },
    runner: {
      classifyImage: async () => ({
        classes: [
          { label: 'passport', score: 0.55, classId: 0 },
          { label: 'receipt', score: 0.48, classId: 1 },
        ],
      }),
    },
  });

  const result = await model.classifyImage({ imagePath: 'weak.jpg' });

  assert.equal(result.docType, DOC_TYPES.PASSPORT);
  assert.equal(result.needsReview, true);
  assert.deepEqual(result.reviewReasons, ['low_model_confidence', 'ambiguous_model_scores']);
});

test('document type model stays inert when the classifier is unavailable', async () => {
  const model = createDocumentTypeModel({
    modelConfig: {
      enabled: true,
      ready: false,
      modelDir: 'cls',
      modelName: 'PP-HGNetV2-B6',
    },
    runner: {
      classifyImage: async () => {
        throw new Error('should not run');
      },
    },
  });

  const result = await model.classifyImage({ imagePath: 'receipt.jpg' });

  assert.equal(result, null);
});
