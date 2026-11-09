'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { compositeModeKey } = require('../lib/monthly_pipeline/mode_key');

test('compositeModeKey: 店铺·分店·返点模式 组合,区分乐天首尔/釜山', () => {
  assert.equal(compositeModeKey({ shop: '乐天', branch: '乐天明洞', modeRaw: 'SG' }), '乐天·乐天明洞·SG');
  assert.equal(compositeModeKey({ shop: '乐天', branch: '乐天釜山', modeRaw: 'SG' }), '乐天·乐天釜山·SG');
  // 关键:乐天首尔 vs 乐天釜山 的组合 key 不同(裸 SG 区分不了)
  assert.notEqual(
    compositeModeKey({ shop: '乐天', branch: '乐天明洞', modeRaw: 'SG' }),
    compositeModeKey({ shop: '乐天', branch: '乐天釜山', modeRaw: 'SG' })
  );
  assert.equal(compositeModeKey({ shop: '爱宝客', branch: '爱宝客', modeRaw: 'PKG' }), '爱宝客·爱宝客·PKG');
});

test('compositeModeKey: 空字段跳过、全空返回空串', () => {
  assert.equal(compositeModeKey({ shop: '乐天', branch: null, modeRaw: 'SG' }), '乐天·SG');
  assert.equal(compositeModeKey({ shop: '  ', branch: '', modeRaw: null }), '');
  assert.equal(compositeModeKey({}), '');
  assert.equal(compositeModeKey(), '');
});
