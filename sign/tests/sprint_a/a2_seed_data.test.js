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
const { createMonthlyWorkspaceService } = require('../../services/monthly/workspace_service');
const { createMonthlyWorkspaceResetService } = require('../../services/monthly/workspace_reset_service');
const { createMonthlySeedService } = require('../../services/monthly/seed_service');
const { registerWorkspaceRoutes } = require('../../routes/monthly/workspace_routes');

const PROD_KEY = '2026-05';
const DEMO_KEY = 'demo-2026-05';
const SCENARIOS = [
  'all_matched',
  'field_conflict',
  'unmatched_unreceived',
  'cross_month',
  'large_volume',
];

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2-seed-'));
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

  const workspaceResetService = createMonthlyWorkspaceResetService({
    db,
    workspaceRepo,
    exportRoot: path.join(dir, 'exports'),
  });
  const monthlySeedService = createMonthlySeedService({
    workspaceService,
    workspaceResetService,
    dailyReceiptRepo,
    storeBillRepo,
    groupCodeRepo,
    receivedReceiptRepo,
  });

  const app = express();
  app.use(express.json());
  const guards = {
    admin: [],
    read: [],
    intake: [],
    finalReview: [],
  };
  registerWorkspaceRoutes({
    app,
    guards,
    deps: {
      workspaceService,
      workspaceResetService,
      monthlySeedService,
      groupCodeRepo,
      storeBillRepo,
      missingReceiptRepo,
      errorRecordRepo,
      receivedReceiptRepo,
      dailyReceiptRepo,
      billMatchLogRepo,
      pendingReviewRepo,
      monthlyDataRepo,
    },
  });

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

async function seed(baseUrl, workspaceKey, body) {
  const res = await fetch(`${baseUrl}/api/monthly/workspaces/${workspaceKey}/seed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { res, json: await res.json() };
}

function countTable(db, table, workspaceKey) {
  return Number(db.prepare(`SELECT COUNT(1) AS n FROM ${table} WHERE workspace_key = ?`).get(workspaceKey)?.n || 0);
}

test('A2: all seed scenarios return inserted counts', async (t) => {
  const { baseUrl } = await setup(t);
  for (const scenario of SCENARIOS) {
    const { res, json } = await seed(baseUrl, DEMO_KEY, {
      scenario,
      count: scenario === 'large_volume' ? 120 : undefined,
    });
    assert.equal(res.status, 200, scenario);
    assert.equal(json.ok, true, scenario);
    assert.equal(json.scenario, scenario);
    assert.equal(typeof json.durationMs, 'number');
    const total = Object.values(json.inserted).reduce((sum, value) => sum + Number(value || 0), 0);
    assert.ok(total > 0, scenario);
    if (scenario === 'cross_month') {
      assert.deepEqual(json.metadata.expected_split, { '2026-04': 15, '2026-05': 15 });
    }
  }
});

test('A2: large_volume seeds requested count within 30 seconds', async (t) => {
  const { baseUrl, db } = await setup(t);
  const { res, json } = await seed(baseUrl, DEMO_KEY, {
    scenario: 'large_volume',
    count: 1000,
  });
  assert.equal(res.status, 200);
  assert.equal(json.inserted.daily, 1000);
  assert.ok(json.durationMs < 30000);
  assert.equal(countTable(db, 'daily_receipt_export', DEMO_KEY), 1000);
});

test('A2: production workspaces cannot be seeded', async (t) => {
  const { baseUrl } = await setup(t);
  const { res, json } = await seed(baseUrl, PROD_KEY, { scenario: 'all_matched' });
  assert.equal(res.status, 403);
  assert.equal(json.error, 'seed_only_allowed_on_demo_workspaces');
  assert.equal(json.code, 'SEED_DEMO_ONLY');
});

test('A2: reset replaces previous scenario data in the same demo workspace', async (t) => {
  const { baseUrl, db } = await setup(t);
  let result = await seed(baseUrl, DEMO_KEY, { scenario: 'all_matched' });
  assert.equal(result.res.status, 200);
  assert.equal(countTable(db, 'daily_receipt_export', DEMO_KEY), 50);
  assert.equal(countTable(db, 'store_bill', DEMO_KEY), 50);

  result = await seed(baseUrl, DEMO_KEY, { scenario: 'field_conflict' });
  assert.equal(result.res.status, 200);
  assert.equal(countTable(db, 'daily_receipt_export', DEMO_KEY), 50);
  assert.equal(countTable(db, 'store_bill', DEMO_KEY), 50);
  assert.equal(countTable(db, 'group_code', DEMO_KEY), 50);

  const conflictNames = Number(db.prepare(`
    SELECT COUNT(1) AS n
    FROM store_bill
    WHERE workspace_key = ? AND name LIKE 'CONFLICT%'
  `).get(DEMO_KEY)?.n || 0);
  assert.equal(conflictNames, 5);
});

test('A2: seeded daily row_hash values are unique', async (t) => {
  const { baseUrl, db } = await setup(t);
  const { res } = await seed(baseUrl, DEMO_KEY, {
    scenario: 'large_volume',
    count: 1000,
  });
  assert.equal(res.status, 200);
  const duplicate = db.prepare(`
    SELECT row_hash, COUNT(1) AS n
    FROM daily_receipt_export
    WHERE workspace_key = ?
    GROUP BY row_hash
    HAVING COUNT(1) > 1
    LIMIT 1
  `).get(DEMO_KEY);
  assert.equal(duplicate, undefined);
});
