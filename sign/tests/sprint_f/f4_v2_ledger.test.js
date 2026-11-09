'use strict';

/**
 * G13 F4 ledger contract tests.
 *
 * The v2 ledger is now stateless: rows are already posted when bridged,
 * so this view must not expose "mark ready", "publish", or selectable
 * ledger-status workflows. Operators can still filter by match state,
 * edit fields, and delete bad rows.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const exists = (file) => fs.existsSync(path.join(root, file));

test('F4 t1: api/v2/ledger.js keeps read/edit/delete endpoints only', () => {
  assert.equal(exists('frontend/src/api/v2/ledger.js'), true);
  const src = read('frontend/src/api/v2/ledger.js');
  ['fetchLedger', 'fetchLedgerStatusCounts', 'updateLedgerFields', 'deleteLedgerRow']
    .forEach((name) => assert.match(src, new RegExp(`export function ${name}\\b`), name));
  ['setLedgerStatus', 'publishLedger'].forEach((name) => assert.doesNotMatch(src, new RegExp(`export function ${name}\\b`), name));
  assert.match(src, /from ['"]\.\.\/client['"]/);
});

test('F4 t2: /monthly/v2/:workspaceKey/ledger route registered', () => {
  const router = read('frontend/src/router/index.js');
  assert.ok(router.includes('/monthly/v2/:workspaceKey/ledger'));
  assert.ok(router.includes("name: 'v2-monthly-ledger'"));
  assert.match(router, /LedgerView\.vue/);
});

test('F4 t3: LedgerView imports stateless APIs, batch modes, and LedgerTable', () => {
  const view = read('frontend/src/views/v2/LedgerView.vue');
  assert.match(view, /from ['"]@\/api\/v2\/ledger['"]/);
  ['fetchLedger', 'updateLedgerFields', 'deleteLedgerRow'].forEach((name) => assert.match(view, new RegExp(name)));
  assert.doesNotMatch(view, /setLedgerStatus/);
  assert.doesNotMatch(view, /publishLedger/);
  assert.match(view, /fetchBatchGroupCodeModes/);
  assert.match(view, /from ['"]@\/components\/v2\/LedgerTable\.vue['"]/);
});

test('F4 t4: load() fetches ledger rows and does not load ledger-status counts', () => {
  const view = read('frontend/src/views/v2/LedgerView.vue');
  assert.match(view, /const ledger = await fetchLedger\(/);
  assert.doesNotMatch(view, /fetchLedgerStatusCounts\(/);
  assert.doesNotMatch(view, /statusCounts/);
});

test('F4 t5: buildParams propagates folder + source + tour/bill match filters only', () => {
  const view = read('frontend/src/views/v2/LedgerView.vue');
  assert.match(view, /function buildParams/);
  ['from', 'to', 'modeFolder', 'sourceType', 'tourMatchStatus', 'billMatchStatus']
    .forEach((field) => assert.match(view, new RegExp(`p\\.${field}\\s*=\\s*filter\\.${field}`), field));
  assert.doesNotMatch(view, /p\.ledgerStatus\s*=/);
});

test('F4 t6: top KPI cards are total, tour unmatched, and bill unmatched', () => {
  const view = read('frontend/src/views/v2/LedgerView.vue');
  assert.match(view, /总行数/);
  assert.match(view, /团号未匹配/);
  assert.match(view, /账单未匹配/);
  ['in_review', 'ready_to_post', 'locked'].forEach((legacy) => assert.doesNotMatch(view, new RegExp(legacy)));
});

test('F4 t7: edit Drawer supports purchaseDate / tourNo / agent / modeRaw', () => {
  const view = read('frontend/src/views/v2/LedgerView.vue');
  assert.match(view, /Drawer/);
  assert.match(view, /updateLedgerFields\(/);
  assert.match(view, /editForm\s*=\s*reactive\(\{[^}]*purchaseDate[^}]*tourNo[^}]*agent[^}]*modeRaw/);
  assert.match(view, /payload\.purchaseDate\s*=/);
  assert.match(view, /payload\.tourNo\s*=/);
  assert.match(view, /payload\.agent\s*=/);
  assert.match(view, /payload\.modeRaw\s*=/);
  assert.match(view, /list="ledger-mode-raw-options"/);
});

test('F4 t8: LedgerView has no bulk publish or status mutation functions', () => {
  const view = read('frontend/src/views/v2/LedgerView.vue');
  ['publishSelected', 'publishAll', 'runPublish', 'changeStatus', 'selectedIds', 'toggleSelect']
    .forEach((name) => assert.doesNotMatch(view, new RegExp(name), name));
  assert.doesNotMatch(view, /一键入月|入月选中|标记待入月/);
});

test('F4 t9: LedgerTable has no checkbox/selectable/status quick actions', () => {
  const tbl = read('frontend/src/components/v2/LedgerTable.vue');
  ['selectedIds', 'toggle-select', 'toggle-select-all', 'quick-status', 'isSelectable', 'ready_to_post']
    .forEach((name) => assert.doesNotMatch(tbl, new RegExp(name), name));
  assert.doesNotMatch(tbl, /type="checkbox"/);
  assert.match(tbl, /tourMatchStatus/);
  assert.match(tbl, /billMatchStatus/);
  assert.match(tbl, /modeFolder/);
  assert.match(tbl, />归类</);
});

test('F4 t10: decodeError no longer exposes WORKSPACE_LOCKED copy', () => {
  const view = read('frontend/src/views/v2/LedgerView.vue');
  assert.match(view, /function decodeError/);
  assert.doesNotMatch(view, /WORKSPACE_LOCKED/);
  assert.match(view, /service_unavailable/);
});
