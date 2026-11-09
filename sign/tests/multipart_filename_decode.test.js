'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { decodeMultipartFilename } = require('../routes/monthly/route_utils');

test('decodeMultipartFilename: 还原 busboy latin1 误码的中文名', () => {
  const original = '乐天首尔账单.xlsx';
  // 模拟 busboy 默认 latin1 解码:把 UTF-8 字节逐个当 latin1 字符
  const garbled = Buffer.from(original, 'utf8').toString('latin1');
  assert.notEqual(garbled, original); // 确实乱了
  assert.equal(decodeMultipartFilename(garbled), original);
});

test('decodeMultipartFilename: 还原韩文名', () => {
  const original = '신라면세점.xlsx';
  const garbled = Buffer.from(original, 'utf8').toString('latin1');
  assert.equal(decodeMultipartFilename(garbled), original);
});

test('decodeMultipartFilename: 纯 ASCII 名保持不变', () => {
  assert.equal(decodeMultipartFilename('store-bill.xlsx'), 'store-bill.xlsx');
});

test('decodeMultipartFilename: 已是正确 UTF-8(含宽字符)不二次解码', () => {
  const name = '爱宝客.xlsx';
  assert.equal(decodeMultipartFilename(name), name);
});

test('decodeMultipartFilename: 空值安全', () => {
  assert.equal(decodeMultipartFilename(''), '');
  assert.equal(decodeMultipartFilename(null), '');
  assert.equal(decodeMultipartFilename(undefined), '');
});
