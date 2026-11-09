'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('G11 t1: monthly overview UI maps the backend overview contract, not mock-only fields', () => {
  const api = read('frontend/src/api/v2/monthly.js');
  const mapper = read('frontend/src/lib/v2/derive_overview.js');
  const route = read('routes/monthly/workspace_routes.js');
  const view = read('frontend/src/views/v2/MonthlyV2View.vue');

  assert.match(api, /\/monthly\/workspaces\/\$\{encodeURIComponent\(workspaceKey\)\}\/overview/);
  assert.match(route, /res\.json\(\{\s*workspace,\s*exists:\s*true,\s*counts,\s*isTestMode\s*\}\)/);

  for (const key of [
    'dailyByMatchStatus',
    'billMatchByStatus',
    'pendingByReason',
    'stageJobsRecent',
  ]) {
    assert.match(route, new RegExp(key), `backend overview must provide ${key}`);
    assert.match(mapper, new RegExp(key), `frontend overview mapper must consume ${key}`);
  }

  assert.match(route, /ledgerByStatus/);
  assert.match(mapper, /ledgerByStatus/);

  assert.match(mapper, /Boolean\(payload\?\.isTestMode\)/);
  assert.match(view, /mapOverviewToMonthlyV2\(payload, overviewFallbackData\.value\)/);
});

test('G11 t2: conflict UI consumes pending-review rows and only mutates local state after resolve succeeds', () => {
  const view = read('frontend/src/views/v2/ConflictsView.vue');
  const api = read('frontend/src/api/v2/conflicts.js');
  const route = read('routes/monthly/listing_routes.js');

  assert.match(api, /\/monthly\/workspaces\/\$\{encodeURIComponent\(workspaceKey\)\}\/pending-reviews/);
  assert.match(route, /app\.get\('\/api\/monthly\/workspaces\/:workspaceKey\/pending-reviews'/);
  assert.match(route, /pending-reviews\/:id\/resolve/);
  assert.match(view, /reasonType \|\| row\.reason_type/);
  assert.match(view, /detail\.conflicts/);
  assert.match(view, /dailyValue/);
  assert.match(view, /billValue/);

  const fn = view.slice(view.indexOf('async function applyResolution'), view.indexOf('function describeError'));
  assert.match(fn, /await resolveConflict/);
  assert.ok(fn.indexOf('await resolveConflict') < fn.indexOf('pendingItems.value.splice'));
});

test('G11 t3: unreceived UI consumes the unified 账单有台账无 source (bill-match/unreceived)', () => {
  const view = read('frontend/src/views/v2/UnreceivedView.vue');
  const billReviewApi = read('frontend/src/api/v2/billReview.js');
  const billReviewRoute = read('routes/monthly/bill_match_routes.js');

  // 单一口径: 账单有台账无 (以账单为基准,客户该补交;与导出/merge未收同源)。
  assert.match(view, /fetchUnreceivedList/);
  assert.doesNotMatch(view, /fetchOrphanBills/);
  assert.doesNotMatch(view, /fetchMissing/);
  assert.match(billReviewApi, /bill-match\/unreceived/);
  assert.match(billReviewRoute, /listUnreceived/);

  for (const key of ['receipt_no', 'purchase_date', 'mode_raw', 'net_usd', 'passport_no']) {
    assert.match(view, new RegExp(key), `UnreceivedView must normalize ${key}`);
  }
  assert.match(view, /payload\.rows \|\| payload\.items/);
});

test('G11 t4: unreceived backfill UI payload matches the backend route (manual-entry UI retired 2026-06-12)', () => {
  // 手动录入页已下线:未收补录(从账单反向补台账)取代手填。后端 manual-entries
  // 端点保留(无 UI 入口),backfill 是新的 UI↔API 契约。
  const view = read('frontend/src/views/v2/UnreceivedView.vue');
  const api = read('frontend/src/api/v2/billReview.js');
  const route = read('routes/monthly/bill_match_routes.js');
  const service = read('services/monthly/unreceived_backfill_service.js');

  assert.match(api, /bill-match\/unreceived\/backfill/);
  assert.match(route, /unreceivedBackfillService\.backfill/);
  assert.match(view, /rows\.map\(rowToItem\)/, 'UI 用未收行稳定标识(护照/姓名/小票号)作 items');
  for (const key of ['passportNo', 'name', 'receiptNo']) {
    assert.match(service, new RegExp(key), `backfill service must consume ${key}`);
  }
  // 台账行字段来自账单真实数据 + 标记可溯源
  for (const token of ['bill_backfill', 'tourMatchStatus', "ledgerStatus: 'posted'"]) {
    assert.ok(service.includes(token), `backfill service must set ${token}`);
  }
  assert.match(route, /empty_items/, 'backfill route surfaces empty_items');
});

test('G11 t5: row history drawer and backend route use the same v2 history contract', () => {
  const drawer = read('frontend/src/components/v2/RowHistoryDrawer.vue');
  const route = read('routes/monthly/listing_routes.js');

  assert.match(drawer, /\/api\/monthly\/v2\/\$\{encodeURIComponent\(props\.workspaceKey\)\}\/daily\/\$\{encodeURIComponent\(rowId\)\}\/history\?limit=50/);
  assert.match(route, /\/api\/monthly\/v2\/:workspaceKey\/daily\/:rowId\/history/);
  for (const key of ['before_value', 'after_value', 'change_source', 'conflict_id']) {
    assert.match(drawer, new RegExp(key), `RowHistoryDrawer must normalize ${key}`);
  }
  assert.match(route, /dailyFieldHistoryRepo\.list/);
  assert.match(route, /res\.json\(\{\s*items:\s*rows,/);
});

test('G11 t6: audit log filters use backend distinct endpoints', () => {
  const view = read('frontend/src/views/v2/AuditLogsView.vue');
  const api = read('frontend/src/api/v2/auditLogs.js');

  assert.match(api, /fetchDistinct\(path\)/);
  for (const pathPart of ['actions', 'users', 'workspaces', 'resource-types']) {
    assert.match(api, new RegExp(pathPart));
  }
  for (const fn of ['fetchDistinctActions', 'fetchDistinctUsers', 'fetchDistinctWorkspaces', 'fetchDistinctResourceTypes']) {
    assert.match(view, new RegExp(fn), `AuditLogsView must call ${fn}`);
  }
});

test('G11 t7: obsolete execution docs are not referenced as active plans', () => {
  for (const file of ['AGENT_SHARED_MEMORY.md', 'README.md', 'eslint.config.mjs', 'lib/storage/database.js']) {
    const src = read(file);
    assert.doesNotMatch(src, /ROADMAP\.md/);
    assert.doesNotMatch(src, /REFACTOR_PLAN\.md/);
    assert.doesNotMatch(src, /agent_docs\/NOW\.md/);
  }
});
