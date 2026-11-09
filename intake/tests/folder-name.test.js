'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseCustomerFolderName } = require('../src/parsing/folder-name');

test('解析字母+数字护照尾号的文件夹名', () => {
  const r = parseCustomerFolderName('BAI FANGRUIYAN EM93');
  assert.equal(r.name, 'BAI FANGRUIYAN');
  assert.equal(r.passportToken, 'EM93');
  assert.equal(r.valid, true);
});

test('解析纯数字尾号的文件夹名', () => {
  const r = parseCustomerFolderName('CHEN YANGNI 3678');
  assert.equal(r.name, 'CHEN YANGNI');
  assert.equal(r.passportToken, '3678');
  assert.equal(r.valid, true);
});

test('同名不同护照尾号应各自解析（重名场景）', () => {
  const a = parseCustomerFolderName('CHEN XIU EQ28');
  const b = parseCustomerFolderName('CHEN XIU EK93');
  assert.equal(a.name, 'CHEN XIU');
  assert.equal(b.name, 'CHEN XIU');
  assert.notEqual(a.passportToken, b.passportToken);
});

test('无可识别尾号时整体作姓名且标记 invalid', () => {
  const r = parseCustomerFolderName('UNKNOWN CUSTOMER');
  assert.equal(r.valid, false);
  assert.equal(r.passportToken, '');
});

test('空输入安全返回', () => {
  const r = parseCustomerFolderName('');
  assert.equal(r.valid, false);
  assert.equal(r.name, '');
});
