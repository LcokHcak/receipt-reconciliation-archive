const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const exists = (file) => fs.existsSync(path.join(root, file));

test('sprint C shared primitives and mock selectors are present', () => {
  [
    'dialog', 'drawer', 'table', 'input', 'textarea', 'select',
    'label', 'tabs', 'tooltip', 'toggle',
  ].forEach((name) => assert.equal(exists(`frontend/src/components/ui/${name}.vue`), true, name));

  assert.equal(exists('frontend/src/mocks/v2/seed.js'), true);
  assert.equal(exists('frontend/src/mocks/v2/index.js'), true);

  const selectors = read('frontend/src/mocks/v2/index.js');
  ['getMonthly', 'getConflicts', 'getUnreceived', 'getRowHistory']
    .forEach((name) => assert.match(selectors, new RegExp(`export function ${name}\\b`)));
});

test('F10: sidebar is fully v2; old v1 monthly routes redirect to v2', () => {
  const router = read('frontend/src/router/index.js');
  // v2 sandbox routes still exist
  [
    '/monthly/v2/:workspaceKey/conflicts',
    '/monthly/v2/:workspaceKey/unreceived',
  ].forEach((route) => assert.equal(router.includes(route), true, route));

  ['ConflictsView.vue', 'UnreceivedView.vue']
    .forEach((file) => assert.match(router, new RegExp(file)));

  // F10: v1 monthly views deleted — should not be referenced in router anymore
  ['MonthlyOverview.vue', 'MonthlyLedgerView.vue', 'MonthlyBillsView.vue',
   'MonthlyGroupCodesView.vue', 'MonthlyDeliveryView.vue', 'MonthlyMissingView.vue',
   'MonthlyPendingReviewView.vue', 'MonthlyRemedyView.vue', 'MonthlyErrorsView.vue',
   'MonthlyAuditView.vue', 'MonthlyLogsView.vue', 'MonthlyBadcaseView.vue']
    .forEach((file) => assert.doesNotMatch(router, new RegExp(file), `${file} should be deleted`));

  // 手动录入页已下线(2026-06-12,未收补录替代)
  assert.doesNotMatch(router, /ManualEntryView/, 'manual entry view should be retired');
  assert.doesNotMatch(router, /manual-entry'/, 'manual-entry route should be retired');

  // v1 → v2 redirect still preserves legacy URLs
  assert.match(router, /redirect:\s*\(to\)\s*=>\s*`\/monthly\/v2\/\$\{to\.params\.workspaceKey\}\/ledger`/);

  const sidebar = read('frontend/src/layouts/AppSidebar.vue');
  // F10: sidebar fully v2 — v1 helper gone, v2 helper everywhere, no "v2 沙盒" group
  assert.doesNotMatch(sidebar, /v1monthly/);
  assert.doesNotMatch(sidebar, /v2 沙盒/);
  // FlaskConical 2026-06-11 起被「模型训练」(admin 训练数据回流页签)使用,不再是 v2 沙盒标志
  assert.match(sidebar, /模型训练/);
  // 2026-06 重分组改名(团号管理→数据库-团号);2026-07-28 0728#7-1 台账入口删除(路由保留)。
  ['月度首页', '账单匹配', '数据库-团号', '字段冲突', '未收清单']
    .forEach((label) => assert.match(sidebar, new RegExp(label)));
  assert.doesNotMatch(sidebar, /待补救/);
  // 旧标签不应再出现(避免回归)
  ['对账台', '团号管理', '月度流水线'].forEach((old) => assert.doesNotMatch(sidebar, new RegExp(old)));
  assert.match(sidebar, /function v2\(page\)/);
  assert.match(sidebar, /v2\('ledger'\)/);
});

test('implemented v2 pages use shared v2 mock selectors', () => {
  assert.match(read('frontend/src/views/v2/ConflictsView.vue'), /getConflicts/);
  assert.match(read('frontend/src/views/v2/UnreceivedView.vue'), /getUnreceived/);
  // ManualEntryView 已下线(2026-06-12),getManualEntries mock 一并删除

  const monthly = read('frontend/src/views/v2/MonthlyV2View.vue');
  assert.match(monthly, /@\/mocks\/v2/);
  assert.doesNotMatch(monthly, /@\/mocks\/monthlyV2/);
});
