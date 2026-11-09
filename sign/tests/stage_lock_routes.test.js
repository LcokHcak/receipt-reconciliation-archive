'use strict';

/**
 * Integration test — prove that the Sprint 2 stage routes honor the
 * stage_job advisory lock. A second concurrent POST to the same stage
 * on the same workspace must get 409 STAGE_ALREADY_RUNNING.
 */

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
const { createMonthlyWorkspaceService } = require('../services/monthly/workspace_service');
const { createImportService } = require('../services/monthly/import_service');
const { createErrorDetectionService } = require('../services/monthly/error_detection_service');
const { createCrossCheckService } = require('../services/monthly/cross_check_service');
const { createMonthlyRoutes } = require('../routes/monthly_routes');
const { createStageLogService } = require('../services/monthly/stage_log_service');

const WS = '2026-01';

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-lock-api-'));
  const db = openMonthlyDatabase({ dbPath: path.join(dir, 'monthly.sqlite') });

  const workspaceRepo = createMonthlyWorkspaceRepository({ db });
  const groupCodeRepo = createGroupCodeRepository({ db });
  const storeBillRepo = createStoreBillRepository({ db });
  const missingReceiptRepo = createMissingReceiptRepository({ db });
  const errorRecordRepo = createErrorRecordRepository({ db });
  const importJobRepo = createImportJobRepository({ db });
  const departureSyncAuditRepo = createDepartureSyncAuditRepository({ db });
  const receivedReceiptRepo = createReceivedReceiptRepository({ db });
  const dailyReceiptRepo = createDailyReceiptRepository({ db });
  const billMatchLogRepo = createBillMatchLogRepository({ db });
  const pendingReviewRepo = createPendingReviewRepository({ db });
  const monthlyDataRepo = createMonthlyDataRepository({ db });
  const stageJobRepo = createStageJobRepository({ db });

  const workspaceService = createMonthlyWorkspaceService({ workspaceRepo });
  workspaceService.open({ workspaceKey: WS, operator: 'test' });

  const importService = createImportService({
    importJobRepo, groupCodeRepo, storeBillRepo, missingReceiptRepo,
    receivedReceiptRepo, dailyReceiptRepo,
  });
  const crossCheckService = createCrossCheckService({
    storeBillRepo, errorRecordRepo, departureSyncAuditRepo,
  });
  const errorDetectionService = createErrorDetectionService({
    storeBillRepo, errorRecordRepo, groupCodeRepo, crossCheckService,
  });

  // Fake slow tour-match so we can get two requests running concurrently
  const tourMatchService = {
    async run() {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { scanned: 0, matched: 0 };
    },
  };

  const upload = { single() { return (_req, _res, next) => next(); } };
  const exportRoot = path.join(dir, 'exports');
  const stageLogService = createStageLogService({ exportRoot });

  const routes = createMonthlyRoutes({
    workspaceService, importService, errorDetectionService, crossCheckService,
    groupCodeRepo, storeBillRepo, missingReceiptRepo, errorRecordRepo,
    importJobRepo, departureSyncAuditRepo,
    receivedReceiptRepo, dailyReceiptRepo, billMatchLogRepo,
    pendingReviewRepo, monthlyDataRepo,
    tourMatchService,
    stageJobRepo,
    stageLogService,
    exportRoot,
    upload,
  });

  const app = express();
  app.use(express.json());
  routes.register(app, null);

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

  return { baseUrl, stageJobRepo, exportRoot };
}

test('concurrent stage invocations: second call returns 409 STAGE_ALREADY_RUNNING', async (t) => {
  const { baseUrl, stageJobRepo } = await setup(t);

  const [r1, r2] = await Promise.all([
    fetch(`${baseUrl}/api/monthly/workspaces/${WS}/stages/tour-match`, { method: 'POST' }),
    // Give the first request a tiny head start so its transaction commits
    // the running row before this second request enters the handler.
    new Promise((resolve) => setTimeout(resolve, 20))
      .then(() => fetch(`${baseUrl}/api/monthly/workspaces/${WS}/stages/tour-match`, { method: 'POST' })),
  ]);

  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [200, 409], `got ${statuses}`);

  const losingRes = r1.status === 409 ? r1 : r2;
  const losingBody = await losingRes.json();
  assert.equal(losingBody.code, 'STAGE_ALREADY_RUNNING');
  assert.ok(losingBody.running?.id);

  // After both settle, no running row should remain
  const running = stageJobRepo.listRecent({ workspaceKey: WS, status: 'running', limit: 5 });
  assert.equal(running.length, 0);
});

test('stage-jobs listing surfaces the recent run', async (t) => {
  const { baseUrl } = await setup(t);
  await fetch(`${baseUrl}/api/monthly/workspaces/${WS}/stages/tour-match`, { method: 'POST' });
  const res = await fetch(`${baseUrl}/api/monthly/workspaces/${WS}/stage-jobs`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.rows.length >= 1);
  assert.equal(body.rows[0].stage, 'tour_match');
  assert.equal(body.rows[0].status, 'succeeded');
});

test('stage job audit log is downloadable', async (t) => {
  const { baseUrl } = await setup(t);
  await fetch(`${baseUrl}/api/monthly/workspaces/${WS}/stages/tour-match`, { method: 'POST' });

  const jobsRes = await fetch(`${baseUrl}/api/monthly/workspaces/${WS}/stage-jobs`);
  assert.equal(jobsRes.status, 200);
  const jobsBody = await jobsRes.json();
  const job = jobsBody.rows[0];
  assert.ok(job.stats?.logFile, 'stage stats should include logFile');

  const logRes = await fetch(`${baseUrl}/api/monthly/workspaces/${WS}/stage-jobs/${job.id}/log`);
  assert.equal(logRes.status, 200);
  const text = await logRes.text();
  assert.match(text, /阶段：tour_match/);
  assert.match(text, /执行结果/);
});
