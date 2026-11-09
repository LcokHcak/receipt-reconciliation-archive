'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  detectFamily,
  detectBranch,
  isDetailSheet,
} = require('../lib/monthly_pipeline/store_family_detector');

test('detectFamily reads the family from the file name', () => {
  assert.equal(detectFamily({ fileName: '1月乐天H 客人账单.xlsx' }).family, '乐天');
  assert.equal(detectFamily({ fileName: '新罗V团+济州/x.xlsx' }).family, '新罗');
  assert.equal(detectFamily({ fileName: '爱宝客 PKG 账单.xlsx' }).family, '爱宝客');
});

test('detectFamily returns receiptLen and tourLen per family', () => {
  assert.deepEqual(detectFamily({ fileName: '乐天.xlsx' }), {
    family: '乐天', receiptLen: 14, tourLen: 8,
  });
  assert.deepEqual(detectFamily({ fileName: '新罗.xlsx' }), {
    family: '新罗', receiptLen: 13, tourLen: 5,
  });
  assert.deepEqual(detectFamily({ fileName: '爱宝客.xlsx' }), {
    family: '爱宝客', receiptLen: 13, tourLen: 5,
  });
});

test('detectFamily falls back to the sheet or hints', () => {
  assert.equal(detectFamily({ fileName: 'x.xlsx', sheetName: '乐天明细' }).family, '乐天');
  assert.equal(detectFamily({ fileName: 'x.xlsx', hints: ['롯데면세점'] }).family, '乐天');
});

test('detectBranch resolves common branches', () => {
  assert.equal(detectBranch({ fileName: '乐天明洞.xlsx' }), '乐天明洞');
  assert.equal(detectBranch({ row: { 免税分店: '乐天釜山' } }), '乐天釜山');
  assert.equal(detectBranch({ row: { 免税分店: '新罗济州' } }), '新罗济州');
});

test('isDetailSheet matches Sprint-1 whitelist', () => {
  assert.equal(isDetailSheet('明细'), true);
  assert.equal(isDetailSheet('卖出明细'), true);
  assert.equal(isDetailSheet('Sheet1'), true);
  assert.equal(isDetailSheet('sheet1'), true);
  assert.equal(isDetailSheet('入账'), false);
  assert.equal(isDetailSheet('Sheet3'), false);
  assert.equal(isDetailSheet('打票'), false);
  assert.equal(isDetailSheet('做账单'), false);
  assert.equal(isDetailSheet('小票'), false);
});
