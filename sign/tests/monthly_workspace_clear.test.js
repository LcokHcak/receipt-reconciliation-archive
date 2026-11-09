'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const { openMonthlyDatabase } = require('../lib/storage/monthly_database');
const { createMonthlyWorkspaceRepository } = require('../repositories/monthly_workspace_repository');
const { createGroupCodeRepository } = require('../repositories/group_code_repository');
const { createStoreBillRepository } = require('../repositories/store_bill_repository');
const { createMissingReceiptRepository } = require('../repositories/missing_receipt_repository');
const { createErrorRecordRepository } = require('../repositories/error_record_repository');
const { createImportJobRepository } = require('../repositories/import_job_repository');
const { createDepartureSyncAuditRepository } = require('../repositories/departure_sync_audit_repository');
const { createReceivedReceiptRepository } = require('../repositories/received_receipt_repository');
const { createDailyReceiptRepository } = require('../repositories/daily_receipt_repository');
const { createBillMatchLogRepository } = require('../repositories/bill_match_log_repository');
const { createPendingReviewRepository } = require('../repositories/pending_review_repository');
const { createMonthlyDataRepository } = require('../repositories/monthly_data_repository');
const { createStageJobRepository } = require('../repositories/stage_job_repository');
const { createMatchBadcaseRepository } = require('../repositories/match_badcase_repository');
const { createMonthlyWorkspaceService } = require('../services/monthly/workspace_service');
const { createMonthlyWorkspaceResetService } = require('../services/monthly/workspace_reset_service');
const { createMonthlyRoutes } = require('../routes/monthly_routes');

const WORKSPACE_KEY = '2099-04';

function createAuth(role = 'admin') {
  return {
    authenticateToken(req, _res, next) {
      req.user = { username: `${role}_operator`, role };
      next();
    },
    requireRole(...roles) {
      return (req, res, next) => {
        if (!roles.includes(req.user?.role)) {
          return res.status(403).json({ error: 'Forbidden' });
        }
        next();
      };
    },
  };
}

async function setup(t, { role = 'admin' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monthly-clear-'));
  const exportRoot = path.join(dir, 'exports');
  const db = openMonthlyDatabase({ dbPath: path.join(dir, 'monthly.sqlite') });
  db.exec(`
    CREATE TABLE IF NOT EXISTS stage_job_retry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stage_job_id INTEGER NOT NULL,
      workspace_key TEXT NOT NULL,
      stage TEXT NOT NULL,
      retry_count INTEGER NOT NULL,
      triggered_at TEXT NOT NULL,
      result TEXT,
      error_message TEXT,
      finished_at TEXT,
      FOREIGN KEY (stage_job_id) REFERENCES stage_job(id)
    )
  `);

  const workspaceRepo = createMonthlyWorkspaceRepository({ db });
  const workspaceService = createMonthlyWorkspaceService({ workspaceRepo });
  workspaceService.open({ workspaceKey: WORKSPACE_KEY, operator: 'test' });

  const repos = {
    groupCodeRepo: createGroupCodeRepository({ db }),
    storeBillRepo: createStoreBillRepository({ db }),
    missingReceiptRepo: createMissingReceiptRepository({ db }),
    errorRecordRepo: createErrorRecordRepository({ db }),
    importJobRepo: createImportJobRepository({ db }),
    departureSyncAuditRepo: createDepartureSyncAuditRepository({ db }),
    receivedReceiptRepo: createReceivedReceiptRepository({ db }),
    dailyReceiptRepo: createDailyReceiptRepository({ db }),
    billMatchLogRepo: createBillMatchLogRepository({ db }),
    pendingReviewRepo: createPendingReviewRepository({ db }),
    monthlyDataRepo: createMonthlyDataRepository({ db }),
    stageJobRepo: createStageJobRepository({ db }),
    matchBadcaseRepo: createMatchBadcaseRepository({ db }),
  };

  const workspaceResetService = createMonthlyWorkspaceResetService({
    db,
    workspaceRepo,
    exportRoot,
    createBackup: async () => ({ backupDir: path.join(dir, 'backup-before-clear') }),
  });

  const routes = createMonthlyRoutes({
    workspaceService,
    workspaceResetService,
    importService: {},
    errorDetectionService: {},
    crossCheckService: {},
    ...repos,
    exportRoot,
    upload: { single: () => (_req, _res, next) => next() },
  });

  const app = express();
  app.use(express.json());
  routes.register(app, createAuth(role));
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });

  t.after(() => {
    server.close();
    try { db.close?.(); } catch {
      // intentional: best-effort cleanup
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {
      // intentional: best-effort cleanup
    }
  });

  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    db,
    dir,
    exportRoot,
    workspaceRepo,
    repos,
  };
}

function seedWorkspaceData({ db, exportRoot, repos }) {
  const importedAt = '2099-04-01T00:00:00.000Z';
  repos.groupCodeRepo.insertMany([{
    workspaceKey: WORKSPACE_KEY,
    tourNo: 'T-CLEAR',
    mode: 'SG',
    modeNormalized: 'SG',
    rowHash: 'clear-group',
    importedAt,
  }]);
  repos.storeBillRepo.insertMany([{
    workspaceKey: WORKSPACE_KEY,
    storeFamily: 'THE SHILLA',
    receiptNo: 'B-CLEAR',
    rowHash: 'clear-bill',
    importedAt,
    isDetailSheet: true,
  }]);
  repos.dailyReceiptRepo.insertMany([{
    workspaceKey: WORKSPACE_KEY,
    receiptNo: 'D-CLEAR',
    rowHash: 'clear-daily',
    importedAt,
  }]);
  repos.receivedReceiptRepo.insertMany([{
    workspaceKey: WORKSPACE_KEY,
    receiptNo: 'R-CLEAR',
    rowHash: 'clear-received',
    importedAt,
  }]);
  repos.missingReceiptRepo.insertMany([{
    workspaceKey: WORKSPACE_KEY,
    receiptNo: 'M-CLEAR',
    rowHash: 'clear-missing',
    importedAt,
  }]);

  db.prepare(`
    INSERT INTO import_job (workspace_key, job_type, source_file, status, started_at)
    VALUES (?, 'daily_receipt', 'daily.xlsx', 'done', ?)
  `).run(WORKSPACE_KEY, importedAt);
  db.prepare(`
    INSERT INTO error_record (workspace_key, error_type, detected_at)
    VALUES (?, 'TEST_ERROR', ?)
  `).run(WORKSPACE_KEY, importedAt);
  const stage = repos.stageJobRepo.acquire({
    workspaceKey: WORKSPACE_KEY,
    stage: 'merge',
    operator: 'test',
    startedAt: importedAt,
  });
  repos.stageJobRepo.finish({ id: stage.id, status: 'succeeded', finishedAt: importedAt });
  db.prepare(`
    INSERT INTO stage_job_retry (stage_job_id, workspace_key, stage, retry_count, triggered_at)
    VALUES (?, ?, 'merge', 1, ?)
  `).run(stage.id, WORKSPACE_KEY, importedAt);

  // 未收侧状态(P2 复核 HIGH#1):重置必须清,否则重导后 INSERT OR IGNORE 复用旧
  // first_seen → 刚对账出来的行立即假「超7天」
  db.prepare(`
    INSERT INTO unreceived_state (workspace_key, item_key, first_seen_at)
    VALUES (?, 'p|n|r-clear', ?)
  `).run(WORKSPACE_KEY, importedAt);
  db.prepare(`
    INSERT INTO unreceived_resolution (workspace_key, item_key, action, resolved_at)
    VALUES (?, 'p|n|r-clear', 'void', ?)
  `).run(WORKSPACE_KEY, importedAt);

  const exportDir = path.join(exportRoot, WORKSPACE_KEY);
  fs.mkdirSync(exportDir, { recursive: true });
  fs.writeFileSync(path.join(exportDir, 'old-export.xlsx'), 'old export');
}

function count(db, table) {
  return db.prepare(`SELECT COUNT(1) AS count FROM ${table} WHERE workspace_key = ?`).get(WORKSPACE_KEY).count;
}

test('admin can clear a monthly workspace and restart the same month', async (t) => {
  const { baseUrl, db, exportRoot, workspaceRepo, repos } = await setup(t);
  seedWorkspaceData({ db, exportRoot, repos });

  const res = await fetch(`${baseUrl}/api/monthly/workspaces/${WORKSPACE_KEY}/clear`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmWorkspaceKey: WORKSPACE_KEY }),
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.workspace.workspaceKey, WORKSPACE_KEY);
  assert.equal(body.workspace.status, 'open');
  assert.equal(body.backupDir.endsWith('backup-before-clear'), true);
  assert.equal(body.deleted.group_code, 1);
  assert.equal(body.deleted.stage_job_retry, 1);

  for (const table of [
    'group_code',
    'store_bill',
    'daily_receipt_export',
    'received_receipt',
    'missing_receipt',
    'import_job',
    'error_record',
    'stage_job',
    'stage_job_retry',
    'unreceived_state',
    'unreceived_resolution',
  ]) {
    assert.equal(count(db, table), 0, `${table} should be empty`);
  }
  assert.equal(fs.existsSync(path.join(exportRoot, WORKSPACE_KEY)), false);
  assert.equal(workspaceRepo.findByKey(WORKSPACE_KEY).status, 'open');
});

test('monthly workspace clear requires admin role and exact confirmation', async (t) => {
  const { baseUrl } = await setup(t, { role: 'reviewer' });

  const reviewerRes = await fetch(`${baseUrl}/api/monthly/workspaces/${WORKSPACE_KEY}/clear`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmWorkspaceKey: WORKSPACE_KEY }),
  });
  assert.equal(reviewerRes.status, 403);

  const adminSetup = await setup(t, { role: 'admin' });
  const badConfirmRes = await fetch(`${adminSetup.baseUrl}/api/monthly/workspaces/${WORKSPACE_KEY}/clear`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmWorkspaceKey: '2099-05' }),
  });
  assert.equal(badConfirmRes.status, 400);
});
