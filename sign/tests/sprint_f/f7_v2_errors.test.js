'use strict';

/**
 * f7_v2_errors — Sprint F F7 contract tests
 *
 * 1. api/v2/errors.js 提供 5 个 endpoint wrappers,走 axios client
 * 2. 路由 /monthly/v2/:ws/errors 已注册;限定 admin+reviewer
 * 3. ErrorsView 复用 DataTable + Drawer + StatusBadge
 * 4. 7 类 cross-check 规则全部显式列出
 * 5. 3 个 action 按钮齐全 (cross-check / cross-check+sync / departure-sync)
 *    + 单点 actionLoading 互斥 + departure-sync 有 confirm 弹窗
 * 6. 标记解决走 Drawer + resolveError(ws, id, note)
 * 7. 审计面板 toggle 显隐 + loadAudit 只在显示时拉
 * 8. decodeError 识别 3 个核心 code (含 F2 service_unavailable)
 * 9. 规则汇总卡点击切换 errorType (相同 id 切换为清空)
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const exists = (file) => fs.existsSync(path.join(root, file));

test('F7 t1: api/v2/errors.js exports 5 wrappers via axios client', () => {
  assert.equal(exists('frontend/src/api/v2/errors.js'), true);
  const src = read('frontend/src/api/v2/errors.js');
  ['fetchErrors', 'runCrossCheck', 'runDepartureSync', 'fetchDepartureSyncAudit', 'resolveError']
    .forEach((name) => assert.match(src, new RegExp(`export function ${name}\\b`), name));
  assert.match(src, /from ['"]\.\.\/client['"]/);
  // 端点拼接对齐 v1
  assert.match(src, /\/cross-check/);
  assert.match(src, /\/departure-sync/);
  assert.match(src, /\/errors\/\$\{id\}\/resolve/);
});

test('F7 t2: /monthly/v2/:ws/errors route registered + admin/reviewer guarded', () => {
  const router = read('frontend/src/router/index.js');
  assert.ok(router.includes('/monthly/v2/:workspaceKey/errors'));
  assert.ok(router.includes("name: 'v2-monthly-errors'"));
  assert.match(router, /ErrorsView\.vue/);
  // roles: ['admin', 'reviewer'] — write action 必须收口
  assert.match(router, /v2-monthly-errors[\s\S]*?roles:\s*\[['"]admin['"]\s*,\s*['"]reviewer['"]\]/);
});

test('F7 t3: ErrorsView reuses DataTable + Drawer + StatusBadge', () => {
  assert.equal(exists('frontend/src/views/v2/ErrorsView.vue'), true);
  const view = read('frontend/src/views/v2/ErrorsView.vue');
  assert.match(view, /from ['"]@\/components\/v2\/DataTable\.vue['"]/);
  assert.match(view, /from ['"]@\/components\/ui\/drawer\.vue['"]/);
  assert.match(view, /from ['"]@\/components\/ui\/status-badge\.vue['"]/);
  assert.match(view, /from ['"]@\/api\/v2\/errors['"]/);
});

test('F7 t4: all 7 cross-check rule types listed', () => {
  const view = read('frontend/src/views/v2/ErrorsView.vue');
  ['GC_DATE_WINDOW', 'GC_RECEIPT_LEN', 'GC_TOUR_LEN', 'BILL_MODE_ENUM',
   'BILL_SHOP_ENUM', 'CC_DEPARTURE_SYNC', 'CC_NAME_PASSPORT']
    .forEach((id) => assert.ok(view.includes(id), id));
});

test('F7 t5: 3 action buttons + single actionLoading + departure-sync confirms', () => {
  const view = read('frontend/src/views/v2/ErrorsView.vue');
  // 3 个 handler
  assert.match(view, /handleCrossCheck\(\{[^}]*withDepartureSync:\s*false/);
  assert.match(view, /handleCrossCheck\(\{[^}]*withDepartureSync:\s*true/);
  assert.match(view, /handleDepartureSync/);
  // 互斥禁用 — 三个按钮都用 :disabled="!!actionLoading"
  const guards = view.match(/:disabled=["']!!actionLoading["']/g) || [];
  assert.ok(guards.length >= 3, `expect >=3 actionLoading guards, got ${guards.length}`);
  // 三种 actionLoading 值都出现 (可能在三元里或直接赋值)
  ['cross-check', 'cross-check-sync', 'departure-sync']
    .forEach((kind) => assert.match(view, new RegExp(`['"]${kind}['"]`), kind));
  // departure-sync 有 confirm 弹窗
  assert.match(view, /handleDepartureSync[\s\S]{0,400}window\.confirm/);
});

test('F7 t6: resolve goes through Drawer + resolveError(ws, id, note)', () => {
  const view = read('frontend/src/views/v2/ErrorsView.vue');
  assert.match(view, /resolveTarget\s*=\s*ref\(null\)/);
  assert.match(view, /resolveError\(workspaceKey\.value,\s*id,\s*resolveNote\.value/);
  assert.match(view, /<Drawer\s+:open=["']!!resolveTarget["']/);
  // resolve 按钮在每行 actions 列被 actionLoading.resolve:id guard
  assert.match(view, /actionLoading\s*===\s*`resolve:\$\{row\.id\}`/);
});

test('F7 t7: audit panel lazy-loads on toggle', () => {
  const view = read('frontend/src/views/v2/ErrorsView.vue');
  assert.match(view, /showAudit\s*=\s*ref\(false\)/);
  assert.match(view, /function toggleAudit/);
  // 第一次打开才拉 audit
  assert.match(view, /if\s*\(showAudit\.value\s*&&\s*!audit\.rows\.length\)\s*await loadAudit\(\)/);
  // 审计列用 fetchDepartureSyncAudit
  assert.match(view, /fetchDepartureSyncAudit\(/);
});

test('F7 t8: decodeError covers WORKSPACE_LOCKED + PIPELINE_LOCKED + service_unavailable', () => {
  const view = read('frontend/src/views/v2/ErrorsView.vue');
  ['WORKSPACE_LOCKED', 'PIPELINE_LOCKED', 'service_unavailable']
    .forEach((code) => assert.match(view, new RegExp(code), code));
});

test('F7 t9: rule summary cards toggle errorType on click', () => {
  const view = read('frontend/src/views/v2/ErrorsView.vue');
  assert.match(view, /function filterByType/);
  // 点同一个 id → 清空(toggle 行为)
  assert.match(view, /errorType\.value\s*=\s*errorType\.value\s*===\s*id\s*\?\s*['"]{2}\s*:\s*id/);
  // active 卡片 ring 高亮
  assert.match(view, /errorType === rule\.id/);
});
