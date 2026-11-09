'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { normalizeMode, STANDARD_MODES } = require('../lib/monthly_pipeline/mode_normalizer');

test('normalizeMode recognises the 7 standard codes', () => {
  for (const code of STANDARD_MODES) {
    assert.deepEqual(normalizeMode(code), { code, isKnown: true });
  }
});

test('normalizeMode recognises common Chinese variants', () => {
  assert.equal(normalizeMode('乐天H').code, 'H');
  assert.equal(normalizeMode('H团').code, 'H');
  assert.equal(normalizeMode('乐天B').code, 'B');
  assert.equal(normalizeMode('B团').code, 'B');
  assert.equal(normalizeMode('新罗济州V').code, 'V');
  assert.equal(normalizeMode('V团').code, 'V');
  assert.equal(normalizeMode('F团').code, 'F');
  assert.equal(normalizeMode('爱宝客SG').code, 'SG');
  assert.equal(normalizeMode('乐天SG-本司').code, 'SG');
  assert.equal(normalizeMode('散客 FIT').code, 'FIT');
  assert.equal(normalizeMode('PKG').code, 'PKG');
});

test('normalizeMode returns UNKNOWN for empty or unknown', () => {
  assert.deepEqual(normalizeMode(''), { code: 'UNKNOWN', isKnown: false });
  assert.deepEqual(normalizeMode(null), { code: 'UNKNOWN', isKnown: false });
  assert.deepEqual(normalizeMode('???'), { code: 'UNKNOWN', isKnown: false });
});
