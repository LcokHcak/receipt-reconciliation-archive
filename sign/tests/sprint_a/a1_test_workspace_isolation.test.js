'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const { openMonthlyDatabase } = require('../../lib/storage/monthly_database');
const { createMonthlyWorkspaceRepository } = require('../../repositories/monthly_workspace_repository');
const { createGroupCodeRepository } = require('../../repositories/group_code_repository');
const { createStoreBillRepository } = require('../../repositories/store_bill_repository');
const { createMissingReceiptRepository } = require('../../repositories/missing_receipt_repository');
const { createErrorRecordRepository } = require('../../repositories/error_record_repository');
const { createReceivedReceiptRepository } = require('../../repositories/received_receipt_repository');
const { createDailyReceiptRepository } = require('../../repositories/daily_receipt_repository');
const { createBillMatchLogRepository } = require('../../repositories/bill_match_log_repository');
const { createPendingReviewRepository } = require('../../repositories/pending_review_repository');
const { createMonthlyDataRepository } = require('../../repositories/monthly_data_repository');
const { createMonthlyWorkspaceService, parseWorkspaceKey } = require('../../services/monthly/workspace_service');
const { createMonthlyReconciliationService } = require('../../services/monthly/reconciliation_service');
const { registerWorkspaceRoutes } = require('../../routes/monthly/workspace_routes');
const { registerReconciliationRoutes } = require('../../routes/monthly/reconciliation_routes');

const PROD_KEY = '2026-05';
const DEMO_KEY = 'demo-2026-05';

function makeDailyRows(workspaceKey, count, prefix) {
  return Array.from({ length: count }, (_, index) => ({
    workspaceKey,
    receiptNo: `${prefix}-${String(index + 1).padStart(4, '0')}`,
    tourNo: '71990',
    agent: '测试代理',
    name: `TEST CUSTOMER ${index + 1}`,
    passportNo: `${prefix}P${index + 1}`,
    shop: 'THE SHILLA',
    purchaseDate: '2026-05-10',
    rowHash: `${workspaceKey}-${prefix}-${index + 1}`,
    importedAt: '2026-05-21T00:00:00.000Z',
    sourceType: 'workbench',
    ledgerStatus: 'posted',
  }));
}

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a1-demo-workspace-'));
  const db = openMonthlyDatabase({ dbPath: path.join(dir, 'monthly.sqlite') });

  const workspaceRepo = createMonthlyWorkspaceRepository({ db });
  const groupCodeRepo = createGroupCodeRepository({ db });
  const storeBillRepo = createStoreBillRepository({ db });
  const missingReceiptRepo = createMissingReceiptRepository({ db });
  const errorRecordRepo = createErrorRecordRepository({ db });
  const receivedReceiptRepo = createReceivedReceiptRepository({ db });
  const dailyReceiptRepo = createDailyReceiptRepository({ db });
  const billMatchLogRepo = createBillMatchLogRepository({ db });
  const pendingReviewRepo = createPendingReviewRepository({ db });
  const monthlyDataRepo = createMonthlyDataRepository({ db });

  const workspaceService = createMonthlyWorkspaceService({ workspaceRepo });
  workspaceService.open({ workspaceKey: PROD_KEY, operator: 'acceptance' });
  workspaceService.open({ workspaceKey: DEMO_KEY, operator: 'acceptance' });

  dailyReceiptRepo.insertMany(makeDailyRows(PROD_KEY, 100, 'prod'));
  dailyReceiptRepo.insertMany(makeDailyRows(DEMO_KEY, 100, 'demo'));

  const monthlyReconciliationService = createMonthlyReconciliationService({
    db,
    dailyReceiptRepo,
    storeBillRepo,
    billMatchLogRepo,
    pendingReviewRepo,
    monthlyDataRepo,
  });

  const app = express();
  app.use(express.json());
  const guards = {
    admin: [],
    read: [],
    intake: [],
    finalReview: [],
  };
  const deps = {
    workspaceService,
    groupCodeRepo,
    storeBillRepo,
    missingReceiptRepo,
    errorRecordRepo,
    receivedReceiptRepo,
    dailyReceiptRepo,
    billMatchLogRepo,
    pendingReviewRepo,
    monthlyDataRepo,
    monthlyReconciliationService,
  };
  registerWorkspaceRoutes({ app, guards, deps });
  registerReconciliationRoutes({ app, guards, deps });

  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  t.after(() => {
    server.close();
    try { db.close?.(); } catch {
      // intentional: best-effort cleanup
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {
      // intentional: best-effort cleanup
    }
  });

  return { baseUrl, db };
}

test('A1: demo workspace keys parse without losing their demo prefix', () => {
  assert.deepEqual(parseWorkspaceKey(DEMO_KEY), {
    isDemo: true,
    year: 2026,
    month: 5,
    key: DEMO_KEY,
  });
});

test('A1: monthly workspace API defaults to production workspaces only', async (t) => {
  const { baseUrl } = await setup(t);
  const res = await fetch(`${baseUrl}/api/monthly/workspaces`);
  assert.equal(res.status, 200);
  const json = await res.json();
  const keys = json.workspaces.map((workspace) => workspace.workspaceKey);
  assert.deepEqual(keys, [PROD_KEY]);
});

test('A1: monthly workspace API can list test workspaces explicitly', async (t) => {
  const { baseUrl } = await setup(t);
  const res = await fetch(`${baseUrl}/api/monthly/workspaces?mode=test`);
  assert.equal(res.status, 200);
  const json = await res.json();
  const keys = json.workspaces.map((workspace) => workspace.workspaceKey);
  assert.deepEqual(keys, [DEMO_KEY]);
});

test('A1: monthly workspace API can list all workspaces for admin/debug callers', async (t) => {
  const { baseUrl } = await setup(t);
  const res = await fetch(`${baseUrl}/api/monthly/workspaces?mode=all`);
  assert.equal(res.status, 200);
  const json = await res.json();
  const keys = json.workspaces.map((workspace) => workspace.workspaceKey).sort();
  assert.deepEqual(keys, [DEMO_KEY, PROD_KEY].sort());
});

test('A1: overview counts stay scoped and expose isTestMode', async (t) => {
  const { baseUrl } = await setup(t);

  const prodRes = await fetch(`${baseUrl}/api/monthly/workspaces/${PROD_KEY}/overview`);
  assert.equal(prodRes.status, 200);
  const prodJson = await prodRes.json();
  assert.equal(prodJson.counts.dailyReceipts, 100);
  assert.equal(prodJson.isTestMode, false);

  const demoRes = await fetch(`${baseUrl}/api/monthly/workspaces/${DEMO_KEY}/overview`);
  assert.equal(demoRes.status, 200);
  const demoJson = await demoRes.json();
  assert.equal(demoJson.counts.dailyReceipts, 100);
  assert.equal(demoJson.isTestMode, true);
  assert.equal(demoJson.exists, true);
});

test('A1: overview for a valid-but-uncreated month returns 200 empty state (not 404)', async (t) => {
  const { baseUrl } = await setup(t);

  // 当月第一次进来 workspace 还没 open —— 应当是正常空态,不是错误,否则连切月份都做不到。
  const res = await fetch(`${baseUrl}/api/monthly/workspaces/2026-12/overview`);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.exists, false);
  assert.equal(json.workspace, null);
  assert.deepEqual(json.counts, {});
  assert.equal(json.isTestMode, false);

  // demo 前缀的未创建月份同样走空态,并标记 isTestMode
  const demoRes = await fetch(`${baseUrl}/api/monthly/workspaces/demo-2026-12/overview`);
  assert.equal(demoRes.status, 200);
  const demoJson = await demoRes.json();
  assert.equal(demoJson.exists, false);
  assert.equal(demoJson.isTestMode, true);
});

test('A1: overview for a malformed workspaceKey returns 400', async (t) => {
  const { baseUrl } = await setup(t);
  const res = await fetch(`${baseUrl}/api/monthly/workspaces/not-a-month/overview`);
  assert.equal(res.status, 400);
});

test('A1: reconciliation exposes isTestMode for demo workspaces', async (t) => {
  const { baseUrl } = await setup(t);
  const res = await fetch(`${baseUrl}/api/monthly/workspaces/${DEMO_KEY}/reconciliation`);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.workspaceKey, DEMO_KEY);
  assert.equal(json.isTestMode, true);
});

test('A1: simulated bridge writes remain in the demo workspace', async (t) => {
  const { db } = await setup(t);
  const demoRows = db.prepare(`
    SELECT workspace_key AS workspaceKey, COUNT(1) AS n
    FROM daily_receipt_export
    WHERE workspace_key = ?
    GROUP BY workspace_key
  `).get(DEMO_KEY);
  const prodRows = db.prepare(`
    SELECT workspace_key AS workspaceKey, COUNT(1) AS n
    FROM daily_receipt_export
    WHERE workspace_key = ?
    GROUP BY workspace_key
  `).get(PROD_KEY);

  assert.equal(demoRows.workspaceKey, DEMO_KEY);
  assert.equal(demoRows.n, 100);
  assert.equal(prodRows.workspaceKey, PROD_KEY);
  assert.equal(prodRows.n, 100);
});
