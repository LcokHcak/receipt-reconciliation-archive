'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { formatMonthlyReceiptNo } = require('../services/monthly/final_delivery_export_service');

// 月结打票表票号:台账统一去杠存纯数字,现代要补杠(2-6-3-5),其余原样(2026-07-07)
test('月结票号:现代(mode_raw)干净16位 → 补杠2-6-3-5', () => {
  assert.equal(formatMonthlyReceiptNo({ receipt_no: '0126070534900117', mode_raw: '现代-JEOCU' }), '01-260705-349-00117');
});
test('月结票号:现代(shop=HYUNDAI)干净16位 → 补杠', () => {
  assert.equal(formatMonthlyReceiptNo({ receipt_no: '0126062613600163', shop: 'HYUNDAI' }), '01-260626-136-00163');
});
test('月结票号:现代已带杠 → 原样', () => {
  assert.equal(formatMonthlyReceiptNo({ receipt_no: '01-260703-121-00139', mode_raw: '现代-JEOCU' }), '01-260703-121-00139');
});
test('月结票号:乐天/新罗系纯数字 → 不动', () => {
  assert.equal(formatMonthlyReceiptNo({ receipt_no: '90623426001803', mode_raw: '乐天SG-本司' }), '90623426001803');
  assert.equal(formatMonthlyReceiptNo({ receipt_no: '0326444200255', mode_raw: '新罗PKG-孙恩子', shop: 'THE SHILLA' }), '0326444200255');
});
test('月结票号:空票号/非16位现代 → 原样不误伤', () => {
  assert.equal(formatMonthlyReceiptNo({ receipt_no: '', mode_raw: '现代-JEOCU' }), '');
  assert.equal(formatMonthlyReceiptNo({ receipt_no: '12345', mode_raw: '现代-JEOCU' }), '12345');
});
