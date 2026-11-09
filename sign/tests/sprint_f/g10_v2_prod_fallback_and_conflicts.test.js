'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('G10 t1: ConflictsView does not move an item to resolved when resolve API fails', () => {
  const src = read('frontend/src/views/v2/ConflictsView.vue');
  const start = src.indexOf('async function applyResolution');
  const end = src.indexOf('function normalizeConflict');
  assert.ok(start >= 0 && end > start, 'applyResolution function found');
  const fn = src.slice(start, end);
  const catchStart = fn.indexOf('} catch');
  const moveStart = fn.indexOf('const index = pendingItems');
  assert.ok(catchStart >= 0 && moveStart > catchStart, 'catch happens before local resolved mutation');
  const catchBlock = fn.slice(catchStart, moveStart);
  assert.match(catchBlock, /\breturn\b/, 'catch block must stop before local resolved mutation');
  assert.match(src, /resolutionError/, 'view should surface resolve failures to the operator');
});

test('G10 t2: production mock fallback is gated in v2 live-data views', () => {
  const files = [
    'frontend/src/views/v2/MonthlyV2View.vue',
    'frontend/src/views/v2/ConflictsView.vue',
    'frontend/src/views/v2/UnreceivedView.vue',
    'frontend/src/components/v2/RowHistoryDrawer.vue',
  ];

  for (const file of files) {
    const src = read(file);
    assert.match(src, /allowV2MockFallback/, `${file} must gate mock fallback by environment`);
    assert.doesNotMatch(src, />mock 回退</, `${file} must not hard-code silent mock fallback badge`);
  }
});

test('G10 t3: MonthlyV2View does not always fall back to mock data when API data is missing', () => {
  const src = read('frontend/src/views/v2/MonthlyV2View.vue');
  assert.doesNotMatch(src, /apiData\.value\s*\|\|\s*fallbackData\.value/);
  assert.match(src, /v-if="data"/, 'main dashboard should render only when real data or allowed mock data exists');
});

test('G10 t4: shared memory no longer contains the stale npm test sprint_b item', () => {
  const sharedMemory = read('AGENT_SHARED_MEMORY.md');
  const pkg = JSON.parse(read('package.json'));
  assert.doesNotMatch(sharedMemory, /tests\/sprint_b\/\*/);
  assert.match(pkg.scripts.test, /tests\/sprint_b\/\*\.test\.js/);
});

test('G10 t5: Monthly overview does not reuse mock financial summary in production', () => {
  const src = read('frontend/src/views/v2/MonthlyV2View.vue');
  assert.match(src, /productionFallbackData/);
  assert.match(src, /netKrw:\s*null/);
  assert.match(src, /summaryUnavailable/);
});

test('G16 t1: Monthly overview does not reuse mock alerts or activities after a successful API response', () => {
  const mapper = read('frontend/src/lib/v2/derive_overview.js');
  assert.doesNotMatch(mapper, /alerts:\s*alerts\.length\s*\?\s*alerts\s*:\s*fallback\.alerts/);
  assert.doesNotMatch(mapper, /activities:\s*activities\.length\s*\?\s*activities\s*:\s*fallback\.activities/);
  assert.match(mapper, /\n\s*alerts,\r?\n/);
  assert.match(mapper, /\n\s*activities,\r?\n/);
});

test('G16 t2: 首页阻塞聚合对 TM_* 镜像错误去重(同一失败行 pending+error 双写,只计 pending)', async () => {
  // tour_match 对同一失败行同时写 pending_review(tour_not_found...)和
  // error_record(TM_TOUR_NOT_FOUND...),首页两边相加会让阻塞数翻倍(shared 已知未决#2)。
  const { deriveAlerts } = await import('../../frontend/src/lib/v2/derive_overview.js');
  const alerts = deriveAlerts({
    pendingByReason: [{ reason: 'tour_not_found', n: 3 }],
    errorsByType: [
      { error_type: 'TM_TOUR_NOT_FOUND', count: 3 },          // 镜像 → 去重
      { error_type: 'CC_DEPARTURE_SYNC', count: 2 },          // 非镜像 → 保留
      { error_type: 'TM_DATE_OUT_OF_WINDOW', count: 1, status: 'open' }, // 镜像 → 去重
    ],
  });
  const total = alerts.reduce((sum, a) => sum + a.count, 0);
  assert.equal(total, 5, '3(pending) + 2(CC) — TM_* 镜像不重复计');
  assert.ok(!alerts.some((a) => String(a.label).startsWith('TM_')));
});
