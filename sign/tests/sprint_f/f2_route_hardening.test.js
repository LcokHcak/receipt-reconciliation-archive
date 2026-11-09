'use strict';

/**
 * f2_route_hardening — Sprint F F2: 未注入服务时返回 503 (而非 404)
 *
 * 覆盖三个端点族:
 *   1. POST /manual-entries           未注入 manualEntryService → 503
 *   2. GET  /v2/.../orphans/bills      未注入 orphanAggregationService → 503
 *   3. GET  /v2/.../orphans/rows       未注入 orphanAggregationService → 503
 *   4. GET  /pending-reviews           未注入 pendingReviewRepo → 503
 *   5. POST /pending-reviews/:id/resolve 未注入 pendingReviewRepo → 503
 *   6. POST /pending-reviews/:id/resolve decision 携带但 service 缺 → 503
 *                                       code = resolution_service_unavailable
 *   7. POST /pending-reviews/:id/resolve 无 decision、有 repo → 状态更新成功
 *      (验证 hoist 出 if-block 没破坏旧 fallback 路径)
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');

const { registerManualEntryRoutes } = require('../../routes/monthly/manual_entry_routes');
const { registerV2OrphanRoutes } = require('../../routes/monthly/v2_orphan_routes');
const { registerListingRoutes } = require('../../routes/monthly/listing_routes');
const { buildProtect } = require('../../routes/monthly/route_utils');

async function withServer(t, app) {
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

function makeApp(deps = {}) {
  const app = express();
  app.use(express.json());
  const ctx = { app, guards: buildProtect(null), deps };
  registerManualEntryRoutes(ctx);
  registerV2OrphanRoutes(ctx);
  registerListingRoutes(ctx);
  return app;
}

// ─── 1: manual-entries 503 ──────────────────────────────────────────────────
test('F2 t1: manual-entries 未注入 service → 503 service_unavailable', async (t) => {
  const baseUrl = await withServer(t, makeApp({ /* no manualEntryService */ }));
  const res = await fetch(`${baseUrl}/api/monthly/workspaces/2026-05/manual-entries`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'T1', customerNo: 'X', customerName: 'X', purchaseDate: '2026-05-10', grossKrw: 1, exchangeRate: 1200 }),
  });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.code, 'service_unavailable');
  assert.equal(body.service, 'manual_entry_service');
});

// ─── 2 + 3: orphan bills / rows 503 ─────────────────────────────────────────
test('F2 t2: orphans/bills 未注入 service → 503', async (t) => {
  const baseUrl = await withServer(t, makeApp({ /* no orphanAggregationService */ }));
  const res = await fetch(`${baseUrl}/api/monthly/v2/2026-05/orphans/bills`);
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.code, 'service_unavailable');
  assert.equal(body.service, 'orphan_aggregation_service');
});

test('F2 t3: orphans/rows 未注入 service → 503', async (t) => {
  const baseUrl = await withServer(t, makeApp({ /* no orphanAggregationService */ }));
  const res = await fetch(`${baseUrl}/api/monthly/v2/2026-05/orphans/rows`);
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.code, 'service_unavailable');
});

// ─── 4 + 5: pending-reviews GET / resolve POST 缺 repo 503 ──────────────────
test('F2 t4: pending-reviews GET 未注入 repo → 503', async (t) => {
  const baseUrl = await withServer(t, makeApp({ /* no pendingReviewRepo */ }));
  const res = await fetch(`${baseUrl}/api/monthly/workspaces/2026-05/pending-reviews`);
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.code, 'service_unavailable');
  assert.equal(body.service, 'pending_review_repo');
});

test('F2 t5: resolve POST 未注入 repo → 503', async (t) => {
  const baseUrl = await withServer(t, makeApp({ /* no pendingReviewRepo */ }));
  const res = await fetch(`${baseUrl}/api/monthly/workspaces/2026-05/pending-reviews/42/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'resolved' }),
  });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.service, 'pending_review_repo');
});

// ─── 6: 静默降级被显式拒绝 ─────────────────────────────────────────────────
test('F2 t6: resolve 带 decision 但缺 resolution service → 503 resolution_service_unavailable', async (t) => {
  // 有 pendingReviewRepo 但没有 pendingReviewResolutionService。
  const pendingReviewRepo = {
    findById: () => ({ id: 42 }),
    resolve: () => 1,
  };
  const baseUrl = await withServer(t, makeApp({
    pendingReviewRepo,
    workspaceService: {
      // ensureWorkspaceWritable 路径需要这俩 — 但 503 必须在它们被调用前返回
      getOrThrow: () => ({ status: 'active' }),
    },
  }));
  const res = await fetch(`${baseUrl}/api/monthly/workspaces/2026-05/pending-reviews/42/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: { writeBack: { name: '张三' } } }),
  });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.code, 'resolution_service_unavailable');
  assert.equal(body.service, 'pending_review_resolution_service');
});

// ─── 7: 无 decision、有 repo → 旧 fallback 路径仍工作 ──────────────────────
test('F2 t7: resolve POST 无 decision + repo 已注入 → 状态更新成功 (无回归)', async (t) => {
  let resolvedCalled = false;
  const pendingReviewRepo = {
    findById: () => ({ id: 42 }),
    resolve: (args) => {
      resolvedCalled = true;
      assert.equal(args.id, 42);
      assert.equal(args.status, 'resolved');
      return 1;
    },
  };
  const baseUrl = await withServer(t, makeApp({
    pendingReviewRepo,
    workspaceService: { getOrThrow: () => ({ status: 'active' }) },
  }));
  const res = await fetch(`${baseUrl}/api/monthly/workspaces/2026-05/pending-reviews/42/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'resolved' /* decision 未传 */ }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.changes, 1);
  assert.equal(resolvedCalled, true);
});
