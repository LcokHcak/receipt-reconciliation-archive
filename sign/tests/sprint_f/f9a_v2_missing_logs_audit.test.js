'use strict';

/**
 * f9a_v2_missing_logs_audit — Sprint F F9a contract tests
 *
 * 三个只读 / dashboard 类页面:
 *   1. api/v2/listings.js 暴露 5 个端点 wrapper
 *   2. 3 条路由全部注册
 *   3. MissingView 复用 DataTable + fetchMissing
 *   4. LogsView 复用 DataTable + fetchStageJobs + fetchRunningStageJobs
 *      + stageJobLogUrl 提供下载直链
 *   5. AuditDashboardView 复用 fetchMonthlyOverview + fetchReconciliation
 *      + 暴露 4 个口径 + 2 条闭合公式
 *   6. 三个 view 都解码 service_unavailable (F2)
 *   7. AuditDashboardView 提供跳到 v2-audit-logs 的链接 (区分两个 audit)
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const exists = (file) => fs.existsSync(path.join(root, file));

test('F9a t1: api/v2/listings.js exports 5 wrappers via axios client', () => {
  assert.equal(exists('frontend/src/api/v2/listings.js'), true);
  const src = read('frontend/src/api/v2/listings.js');
  ['fetchMissing', 'fetchStageJobs', 'fetchRunningStageJobs', 'fetchReconciliation']
    .forEach((name) => assert.match(src, new RegExp(`export function ${name}\\b`), name));
  // stageJobLogUrl 是同步 URL 拼接,无 axios
  assert.match(src, /export function stageJobLogUrl\b/);
  assert.match(src, /from ['"]\.\.\/client['"]/);
  // 端点对齐 v1
  assert.match(src, /\/missing/);
  assert.match(src, /\/stage-jobs/);
  assert.match(src, /\/reconciliation/);
});

test('F9a t2: missing route redirects and logs/audit routes stay registered', () => {
  const router = read('frontend/src/router/index.js');
  assert.ok(router.includes('/monthly/v2/:workspaceKey/missing'));
  assert.match(router, /monthly\/v2\/:workspaceKey\/missing[\s\S]+unreceived/);
  assert.ok(router.includes('/monthly/v2/:workspaceKey/logs'));
  assert.ok(router.includes("name: 'v2-monthly-logs'"));
  assert.ok(router.includes('/monthly/v2/:workspaceKey/audit'));
  assert.ok(router.includes("name: 'v2-monthly-audit'"));
  assert.doesNotMatch(router, /MissingView\.vue/);
  ['LogsView.vue', 'AuditDashboardView.vue']
    .forEach((f) => assert.match(router, new RegExp(f), f));
});

test('F9a t3: UnreceivedView uses the unified 账单有台账无 source (fetchUnreceivedList)', () => {
  assert.equal(exists('frontend/src/views/v2/MissingView.vue'), false);
  const view = read('frontend/src/views/v2/UnreceivedView.vue');
  assert.match(view, /fetchUnreceivedList\(workspaceKey\.value/);
  assert.match(view, /from ['"]@\/api\/v2\/billReview['"]/);
  assert.match(view, /unreceivedRows/);
});

test('F9a t4: LogsView pulls stage jobs + running indicator + log download', () => {
  assert.equal(exists('frontend/src/views/v2/LogsView.vue'), true);
  const view = read('frontend/src/views/v2/LogsView.vue');
  assert.match(view, /from ['"]@\/components\/v2\/DataTable\.vue['"]/);
  ['fetchStageJobs', 'fetchRunningStageJobs', 'stageJobLogUrl']
    .forEach((name) => assert.match(view, new RegExp(name), name));
  // running 横条
  assert.match(view, /v-if=["']running\.length["']/);
  // 日志直链
  assert.match(view, /stageJobLogUrl\(workspaceKey[^,]*,\s*row\.id\)/);
});

test('F9a t5: AuditDashboardView pulls overview + reconciliation; 4 metrics + 2 formulas', () => {
  assert.equal(exists('frontend/src/views/v2/AuditDashboardView.vue'), true);
  const view = read('frontend/src/views/v2/AuditDashboardView.vue');
  assert.match(view, /fetchMonthlyOverview/);
  assert.match(view, /fetchReconciliation/);
  // 4 个口径 id
  ['storeBills', 'posted', 'unreceived', 'pendingReview']
    .forEach((id) => assert.match(view, new RegExp(`id:\\s*['"]${id}['"]`), id));
  // 2 条公式
  ['bill-closure', 'monthly-output']
    .forEach((id) => assert.match(view, new RegExp(`id:\\s*['"]${id}['"]`), id));
  // 公式 balanced 计算
  assert.match(view, /balanced:/);
});

test('F9a t6: read-only views decode service_unavailable (F2 alignment)', () => {
  ['frontend/src/views/v2/LogsView.vue',
   'frontend/src/views/v2/AuditDashboardView.vue']
    .forEach((p) => assert.match(read(p), /service_unavailable/, p));
});

test('F9a t7: AuditDashboardView links to v2-audit-logs (distinguishes 2 audits)', () => {
  const view = read('frontend/src/views/v2/AuditDashboardView.vue');
  assert.match(view, /name:\s*['"]v2-audit-logs['"]/);
  // 说明性文案区分两件事
  assert.match(view, /audit_log/);
});
