const test = require('node:test');
const assert = require('node:assert/strict');

const { createDocumentRegionDetector } = require('../lib/document_region_detector');
const { DOC_TYPES } = require('../lib/package_constants');

test('document region detector normalizes PaddleX boxes into sorted document regions', async () => {
  const detector = createDocumentRegionDetector({
    modelConfig: {
      enabled: true,
      ready: true,
      modelDir: 'det',
      modelName: 'PP-YOLOE_plus-L',
      threshold: 0.5,
    },
    runner: {
      detectRegions: async () => ({
        boxes: [
          { label: 'receipt_region', score: 0.86, coordinate: [60, 20, 100, 80] },
          { label: 'passport_region', score: 0.91, coordinate: [10, 5, 50, 40] },
          { label: 'other_region', score: 0.2, coordinate: [0, 0, 10, 10] },
        ],
      }),
    },
  });

  const result = await detector.detectRegions({ imagePath: 'mix.jpg' });

  assert.equal(result.enabled, true);
  assert.equal(result.splitRecommended, true);
  assert.deepEqual(
    result.regions.map((region) => region.docType),
    [DOC_TYPES.PASSPORT, DOC_TYPES.RECEIPT]
  );
  assert.deepEqual(result.regions[0].box, {
    left: 10,
    top: 5,
    right: 50,
    bottom: 40,
    width: 40,
    height: 35,
  });
});

test('document region detector stays inert when the model pipeline is disabled', async () => {
  const detector = createDocumentRegionDetector({
    modelConfig: {
      enabled: false,
      ready: true,
      modelDir: 'det',
      modelName: 'PP-YOLOE_plus-L',
      threshold: 0.5,
    },
    runner: {
      detectRegions: async () => {
        throw new Error('should not run');
      },
    },
  });

  const result = await detector.detectRegions({ imagePath: 'mix.jpg' });

  assert.equal(result.enabled, false);
  assert.equal(result.splitRecommended, false);
  assert.deepEqual(result.regions, []);
});
