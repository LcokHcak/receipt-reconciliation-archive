'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FIELD_LABELS,
  cleanReceiptFieldValue,
  mergeReceiptFieldModelAnalysis,
  normalizeForCompare,
  normalizeReceiptFieldDetections,
} = require('../lib/receipt_field_model');

// 团号口径统一回归锁(2026-07-03 体检收口):此文件曾有两处自写正则漂移副本——
// cleanGroupNo 与中央 normalizeGroupNo 规则不一致、normalizeForCompare 纯剥数字吃掉字母团号。
test('团号清洗/比对统一走中央口径:字母团号保留、标签剥前缀、"无"透传', () => {
  // 字母团号(乐天R团)不能被剥成纯数字——旧 compare 口径 replace(/\D/g,'') 的回归锁
  assert.equal(cleanReceiptFieldValue(FIELD_LABELS.GROUP_NO, 'R2299001'), 'R2299001');
  assert.equal(normalizeForCompare(FIELD_LABELS.GROUP_NO, 'R2299001'), 'R2299001');
  // 票面标签前缀剥掉(与中央 normalizeGroupNo 一致)
  assert.equal(cleanReceiptFieldValue(FIELD_LABELS.GROUP_NO, 'G 25184'), '25184');
  assert.equal(normalizeForCompare(FIELD_LABELS.GROUP_NO, 'G-12345'), '12345');
  // 机场票"无"透传,不清成空串
  assert.equal(cleanReceiptFieldValue(FIELD_LABELS.GROUP_NO, '无'), '无');
  // 纯文字噪声(定位模型框错)不当团号
  assert.equal(cleanReceiptFieldValue(FIELD_LABELS.GROUP_NO, 'CORNER'), '');
});

test('normalizeReceiptFieldDetections keeps one best box per receipt field', () => {
  const result = normalizeReceiptFieldDetections(
    {
      boxes: [
        { label: FIELD_LABELS.RECEIPT_NO, score: 0.31, coordinate: [10, 10, 110, 30] },
        { label: FIELD_LABELS.RECEIPT_NO, score: 0.88, coordinate: [12, 12, 112, 32] },
        { label: FIELD_LABELS.PURCHASE_DATE, score: 0.82, coordinate: [20, 40, 180, 65] },
        { label: FIELD_LABELS.GROUP_NO, score: 0.25, coordinate: [20, 70, 120, 95] },
        { label: 'not_a_receipt_field', score: 0.99, coordinate: [0, 0, 10, 10] },
      ],
    },
    0.3
  );

  assert.deepEqual(Object.keys(result.fields).sort(), [
    FIELD_LABELS.PURCHASE_DATE,
    FIELD_LABELS.RECEIPT_NO,
  ].sort());
  assert.equal(result.fields[FIELD_LABELS.RECEIPT_NO].confidence, 0.88);
  assert.equal(result.fields[FIELD_LABELS.RECEIPT_NO].box.left, 12);
  assert.equal(result.all.length, 3);
});

test('cleanReceiptFieldValue normalizes dates and receipt numbers', () => {
  assert.equal(cleanReceiptFieldValue(FIELD_LABELS.PURCHASE_DATE, '2026.05.11'), '2026-05-11');
  assert.equal(cleanReceiptFieldValue(FIELD_LABELS.DEPARTURE_DATE, '26/05/11'), '2026-05-11');
  assert.equal(cleanReceiptFieldValue(FIELD_LABELS.RECEIPT_NO, ' NO. 03-261-635-0019-5 '), '03-261-635-0019-5');
  assert.equal(cleanReceiptFieldValue(FIELD_LABELS.GROUP_NO, 'TG71993'), 'TG71993');
  assert.equal(cleanReceiptFieldValue(FIELD_LABELS.STORE_FAMILY, 'theshilla'), 'THE SHILLA');
  assert.equal(cleanReceiptFieldValue(FIELD_LABELS.STORE_FAMILY, 'shillaipark'), 'SHILLA IPARK');
  // 无效日期保留空
  assert.equal(cleanReceiptFieldValue(FIELD_LABELS.PURCHASE_DATE, 'no-date-here'), '');
});

test('mergeReceiptFieldModelAnalysis prefers model values and flags conflicts', () => {
  const merged = mergeReceiptFieldModelAnalysis({
    baseAnalysis: {
      docTypeFinal: 'receipt',
      receiptNoAuto: 'R999',
      groupNoAuto: '',
      purchaseDateAuto: '2026-05-01',
      departureDateAuto: '',
      receiptStoreAuto: '',
      needsReview: false,
      reviewReasons: [],
    },
    fieldValues: {
      [FIELD_LABELS.RECEIPT_NO]: { value: 'NO. 03-261-635-0019-5', confidence: 0.88 },
      [FIELD_LABELS.GROUP_NO]: { value: 'TG71993', confidence: 0.82 },
      [FIELD_LABELS.PURCHASE_DATE]: { value: '2026.05.11', confidence: 0.81 },
      [FIELD_LABELS.DEPARTURE_DATE]: { value: '2026/05/15', confidence: 0.75 },
    },
  });

  // 值取自模型
  assert.equal(merged.receiptNoAuto, '03-261-635-0019-5');
  assert.equal(merged.groupNoAuto, 'TG71993');
  assert.equal(merged.purchaseDateAuto, '2026-05-11');
  assert.equal(merged.departureDateAuto, '2026-05-15');
  // 只有 receiptNo + purchaseDate 冲突了
  assert.equal(merged.needsReview, true);
  assert.deepEqual(merged.reviewReasons.sort(), [
    'receipt_field_model_purchase_date_conflict',
    'receipt_field_model_receipt_no_conflict',
  ].sort());
  assert.equal(merged.receiptFieldModelUsed, true);
});

test('mergeReceiptFieldModelAnalysis is a no-op for non-receipt documents', () => {
  const merged = mergeReceiptFieldModelAnalysis({
    baseAnalysis: {
      docTypeFinal: 'passport',
      passportNoAuto: 'EA1234567',
      needsReview: false,
      reviewReasons: [],
    },
    fieldValues: {
      [FIELD_LABELS.RECEIPT_NO]: { value: 'R001', confidence: 0.9 },
    },
  });
  // 原样返回
  assert.equal(merged.passportNoAuto, 'EA1234567');
  assert.equal(merged.receiptFieldModelUsed, undefined);
});

test('mergeReceiptFieldModelAnalysis keeps existing when cleaner rejects model value', () => {
  const merged = mergeReceiptFieldModelAnalysis({
    baseAnalysis: {
      docTypeFinal: 'receipt',
      purchaseDateAuto: '2026-05-01',
      needsReview: false,
      reviewReasons: [],
    },
    fieldValues: {
      [FIELD_LABELS.PURCHASE_DATE]: { value: 'garbage 99-99-99', confidence: 0.95 },
    },
  });
  assert.equal(merged.purchaseDateAuto, '2026-05-01');
  assert.equal(merged.receiptFieldModelUsed, false);
});
