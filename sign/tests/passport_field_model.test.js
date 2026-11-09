const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FIELD_LABELS,
  mergePassportFieldModelAnalysis,
  normalizePassportFieldDetections,
} = require('../lib/passport_field_model');

test('normalizePassportFieldDetections keeps one best box per passport field', () => {
  const result = normalizePassportFieldDetections(
    {
      boxes: [
        { label: FIELD_LABELS.PASSPORT_NO, score: 0.31, coordinate: [10, 10, 110, 30] },
        { label: FIELD_LABELS.PASSPORT_NO, score: 0.88, coordinate: [12, 12, 112, 32] },
        { label: FIELD_LABELS.ENGLISH_NAME, score: 0.8, coordinate: [20, 40, 180, 65] },
        { label: FIELD_LABELS.CHINESE_NAME, score: 0.29, coordinate: [20, 70, 120, 95] },
        { label: 'not_a_passport_field', score: 0.99, coordinate: [0, 0, 10, 10] },
      ],
    },
    0.3
  );

  assert.deepEqual(Object.keys(result.fields).sort(), [
    FIELD_LABELS.ENGLISH_NAME,
    FIELD_LABELS.PASSPORT_NO,
  ].sort());
  assert.equal(result.fields[FIELD_LABELS.PASSPORT_NO].confidence, 0.88);
  assert.equal(result.fields[FIELD_LABELS.PASSPORT_NO].box.left, 12);
  assert.equal(result.all.length, 3);
});

test('mergePassportFieldModelAnalysis prefers valid core model fields and flags conflicts', () => {
  const merged = mergePassportFieldModelAnalysis({
    baseAnalysis: {
      docTypeFinal: 'passport',
      extractedNameAuto: 'WRONG NAME',
      chineseNameAuto: '',
      passportNoAuto: 'EJ0000000',
      needsReview: false,
      reviewReasons: [],
    },
    fieldValues: {
      [FIELD_LABELS.ENGLISH_NAME]: {
        value: 'ZHANG SAN',
        confidence: 0.84,
      },
      [FIELD_LABELS.CHINESE_NAME]: {
        value: '张三',
        confidence: 0.81,
      },
      [FIELD_LABELS.PASSPORT_NO]: {
        value: 'EJ1234567',
        confidence: 0.91,
      },
    },
  });

  assert.equal(merged.extractedNameAuto, 'ZHANG SAN');
  assert.equal(merged.chineseNameAuto, '张三');
  assert.equal(merged.passportNoAuto, 'EJ1234567');
  assert.equal(merged.needsReview, true);
  assert.deepEqual(merged.reviewReasons, [
    'passport_field_model_passport_no_conflict',
    'passport_field_model_extracted_name_conflict',
  ]);
  assert.equal(merged.passportFieldModelUsed, true);
});

test('mergePassportFieldModelAnalysis keeps old value when model value is invalid', () => {
  const merged = mergePassportFieldModelAnalysis({
    baseAnalysis: {
      docTypeFinal: 'passport',
      extractedNameAuto: 'LI SI',
      chineseNameAuto: '李四',
      passportNoAuto: 'EA1234567',
      needsReview: false,
      reviewReasons: [],
    },
    fieldValues: {
      [FIELD_LABELS.ENGLISH_NAME]: { value: '123', confidence: 0.95 },
      [FIELD_LABELS.CHINESE_NAME]: { value: 'NAME', confidence: 0.95 },
      [FIELD_LABELS.PASSPORT_NO]: { value: '123', confidence: 0.95 },
    },
  });

  assert.equal(merged.extractedNameAuto, 'LI SI');
  assert.equal(merged.chineseNameAuto, '李四');
  assert.equal(merged.passportNoAuto, 'EA1234567');
  assert.equal(merged.passportFieldModelUsed, false);
});
