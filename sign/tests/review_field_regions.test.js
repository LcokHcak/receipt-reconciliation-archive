const test = require('node:test');
const assert = require('node:assert/strict');

const { DOC_TYPES } = require('../lib/package_constants');
const { buildTaskFieldRegions } = require('../lib/review_field_regions');

test('buildTaskFieldRegions maps passport model boxes to review field keys', () => {
  const regions = buildTaskFieldRegions({
    docTypeFinal: DOC_TYPES.PASSPORT,
    passportFieldModelMeta: {
      source: 'passport_field_detection_crop_ocr',
      fields: {
        passport_no_region: { value: 'E12345678', rawText: 'E12345678' },
      },
      detections: {
        passport_no_region: {
          confidence: 0.91,
          box: { left: 12, top: 20, right: 112, bottom: 45, width: 100, height: 25 },
        },
      },
    },
  });

  assert.equal(regions.length, 1);
  assert.deepEqual(regions[0], {
    key: 'passportNoFinal',
    label: '\u62a4\u7167\u53f7',
    modelLabel: 'passport_no_region',
    confidence: 0.91,
    source: 'passport_field_detection_crop_ocr',
    value: 'E12345678',
    box: { left: 12, top: 20, width: 100, height: 25 },
  });
});

test('buildTaskFieldRegions maps receipt model boxes in business review order', () => {
  const regions = buildTaskFieldRegions({
    docTypeFinal: DOC_TYPES.RECEIPT,
    receiptFieldModelMeta: {
      source: 'receipt_field_detection_crop_ocr',
      fields: {
        receipt_no_region: { value: '0326163500229' },
        store_family_region: { value: 'THE SHILLA' },
      },
      detections: {
        receipt_no_region: {
          confidence: 0.83,
          box: { left: 50, top: 220, right: 240, bottom: 250 },
        },
        store_family_region: {
          confidence: 0.77,
          box: { left: 40, top: 12, right: 210, bottom: 48 },
        },
      },
    },
  });

  assert.deepEqual(regions.map((region) => region.key), ['receiptStoreFinal', 'receiptNoFinal']);
  assert.equal(regions[0].label, '\u514d\u7a0e\u5e97');
  assert.equal(regions[1].value, '0326163500229');
});

test('buildTaskFieldRegions ignores invalid boxes and unrelated document types', () => {
  assert.deepEqual(buildTaskFieldRegions({ docTypeFinal: DOC_TYPES.OTHER }), []);
  assert.deepEqual(buildTaskFieldRegions({
    docTypeFinal: DOC_TYPES.RECEIPT,
    receiptFieldModelMeta: {
      detections: {
        receipt_no_region: { confidence: 0.8, box: { left: 20, top: 20, width: 0, height: 10 } },
      },
    },
  }), []);
});
