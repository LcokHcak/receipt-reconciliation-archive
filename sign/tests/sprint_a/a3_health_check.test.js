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
const { createMonthlyHealthCheckService } = require('../../services/monthly/health_check_service');
const { registerWorkspaceRoutes } = require('../../routes/monthly/workspace_routes');

const DEMO_KEY = 'demo-2026-05';

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a3-health-'));
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
  const monthlyHealthCheckService = createMonthlyHealthCheckService({
    db,
    workspaceService,
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
      monthlyHealthCheckService,
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

  return { baseUrl, db, monthlySeedService };
}

async function health(baseUrl, workspaceKey = DEMO_KEY) {
  const res = await fetch(`${baseUrl}/api/monthly/workspaces/${workspaceKey}/health-check`, {
    method: 'POST',
  });
  return { res, json: await res.json() };
}

async function healthCsv(baseUrl, workspaceKey = DEMO_KEY) {
  const res = await fetch(`${baseUrl}/api/monthly/workspaces/${workspaceKey}/health-check.csv`);
  return { res, text: await res.text() };
}

function findIssue(report, id) {
  return report.issues.find((issue) => issue.id === id);
}

test('A3: clean seeded demo workspace has no actionable health issues', async (t) => {
  const { baseUrl, monthlySeedService } = await setup(t);
  await monthlySeedService.seedWorkspace({ workspaceKey: DEMO_KEY, scenario: 'all_matched' });

  const { res, json } = await health(baseUrl);

  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.workspaceKey, DEMO_KEY);
  assert.equal(json.isTestMode, true);
  assert.equal(json.summary.critical, 0);
  assert.equal(json.summary.warning, 0);
  assert.equal(json.summary.info, 0);
  assert.deepEqual(json.issues.filter((issue) => !issue.skipped), []);
  assert.equal(findIssue(json, 'H2').skipped, true);
  assert.equal(findIssue(json, 'H2').reason, 'merge_never_run');
});

test('A3: H1 reports monthly_data rows whose daily_receipt_id no longer exists', async (t) => {
  const { baseUrl, db } = await setup(t);
  insertOrphanMonthlyData(db);

  const { json } = await health(baseUrl);
  const issue = findIssue(json, 'H1');

  assert.equal(issue.severity, 'warning');
  assert.equal(issue.count, 1);
  assert.equal(issue.samples[0].daily_receipt_id, 999999);
  assert.equal(json.summary.warning, 1);
});

test('A3: H3 reports stage jobs running longer than one hour', async (t) => {
  const { baseUrl, db } = await setup(t);
  db.prepare(`
    INSERT INTO stage_job (workspace_key, stage, status, started_at, operator)
    VALUES (?, 'merge', 'running', ?, 'acceptance')
  `).run(DEMO_KEY, hoursAgo(2));

  const { json } = await health(baseUrl);
  const issue = findIssue(json, 'H3');

  assert.equal(issue.severity, 'critical');
  assert.equal(issue.count, 1);
  assert.equal(issue.samples[0].stage, 'merge');
  assert.equal(json.summary.critical, 1);
});

test('A3: H4 reports open pending reviews older than thirty days', async (t) => {
  const { baseUrl, db } = await setup(t);
  db.prepare(`
    INSERT INTO pending_review (
      workspace_key, source_table, source_id, reason_type, detail, status, created_at
    ) VALUES (?, 'daily_receipt_export', 1, 'field_conflict', '{}', 'open', ?)
  `).run(DEMO_KEY, daysAgo(40));

  const { json } = await health(baseUrl);
  const issue = findIssue(json, 'H4');

  assert.equal(issue.severity, 'info');
  assert.equal(issue.count, 1);
  assert.equal(issue.samples[0].reason_type, 'field_conflict');
  assert.equal(json.summary.info, 1);
});

test('A3: H5 reports business writes after a workspace has been locked', async (t) => {
  const { baseUrl, db } = await setup(t);
  const lockedAt = hoursAgo(2);
  db.prepare(`
    UPDATE monthly_workspace
    SET status = 'locked', locked_at = ?, locked_by = 'acceptance'
    WHERE workspace_key = ?
  `).run(lockedAt, DEMO_KEY);
  insertDailyAfterLock(db, { importedAt: hoursAgo(1) });

  const { json } = await health(baseUrl);
  const issue = findIssue(json, 'H5');

  assert.equal(issue.severity, 'critical');
  assert.equal(issue.count, 1);
  assert.equal(issue.samples[0].table, 'daily_receipt_export');
  assert.equal(json.summary.critical, 1);
});

test('A3: health check CSV includes one row for each reported issue', async (t) => {
  const { baseUrl, db } = await setup(t);
  insertOrphanMonthlyData(db);
  db.prepare(`
    INSERT INTO pending_review (
      workspace_key, source_table, source_id, reason_type, detail, status, created_at
    ) VALUES (?, 'daily_receipt_export', 1, 'field_conflict', '{}', 'open', ?)
  `).run(DEMO_KEY, daysAgo(40));

  const { json } = await health(baseUrl);
  const { res, text } = await healthCsv(baseUrl);
  const rows = text.trim().split(/\r?\n/);

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.equal(rows.length - 1, json.issues.length);
  assert.match(text, /H1/);
  assert.match(text, /H4/);
  assert.match(text, /merge_never_run/);
});

function insertOrphanMonthlyData(db) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO monthly_data (
      workspace_key, mode_folder, is_unmatched, daily_receipt_id,
      receipt_no, name, row_hash, created_at, updated_at
    ) VALUES (?, '济州新罗V团', 0, 999999, '0326000000001', 'ORPHAN', 'a3-h1-row', ?, ?)
  `).run(DEMO_KEY, now, now);
}

function insertDailyAfterLock(db, { importedAt }) {
  db.prepare(`
    INSERT INTO daily_receipt_export (
      workspace_key, name, receipt_no, purchase_date,
      ledger_status, imported_at, row_hash, source_type, posted_at
    ) VALUES (?, 'LOCKED WRITE', '0326000000002', '2026-05-01',
      'posted', ?, 'a3-h5-row', 'imported', ?)
  `).run(DEMO_KEY, importedAt, importedAt);
}

function hoursAgo(hours) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}
