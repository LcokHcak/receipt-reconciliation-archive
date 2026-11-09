'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('G15 t9: monthly home links to bill-match instead of exposing one-click reconcile', () => {
  const src = read('frontend/src/views/v2/MonthlyV2View.vue');
  assert.doesNotMatch(src, /@click="handleReconcile"/);
  assert.match(src, /v2-monthly-bill-match/);
});

test('G15 t10: BillMatchView owns one-click reconcile and still exposes tour-match', () => {
  const src = read('frontend/src/views/v2/BillMatchView.vue');
  assert.match(src, /await runTourMatch\(workspaceKey\.value\)[\s\S]*await runBillMatch\(workspaceKey\.value\)/);
  assert.match(src, /reconcileSteps/);
  assert.match(src, /先跑团号匹配|鍏堣窇鍥㈠彿/);
});
