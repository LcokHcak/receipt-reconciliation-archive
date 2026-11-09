'use strict';

/**
 * Smoke test: import 团号汇总.xlsx into a fresh temp SQLite
 * and report row counts. Does NOT touch production storage.
 *
 * Usage: node scripts/smoke_monthly_import.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openMonthlyDatabase } = require('../lib/storage/monthly_database');
const { createMonthlyWorkspaceRepository } = require('../repositories/monthly_workspace_repository');
const { createGroupCodeRepository } = require('../repositories/group_code_repository');
const { createStoreBillRepository } = require('../repositories/store_bill_repository');
const { createMissingReceiptRepository } = require('../repositories/missing_receipt_repository');
const { createImportJobRepository } = require('../repositories/import_job_repository');
const { createErrorRecordRepository } = require('../repositories/error_record_repository');
const { createMonthlyWorkspaceService } = require('../services/monthly/workspace_service');
const { createImportService } = require('../services/monthly/import_service');
const { createErrorDetectionService } = require('../services/monthly/error_detection_service');

const DATA_ROOT = 'd:/JIN HAIMIN/self/ticket/data_sample/新建文件夹';
const WORKSPACE_KEY = '2026-01';

async function run() {
  const tmpDb = path.join(os.tmpdir(), `monthly-smoke-${Date.now()}.sqlite`);
  console.log(`[smoke] tmp db: ${tmpDb}`);

  const db = openMonthlyDatabase({ dbPath: tmpDb });
  const workspaceRepo = createMonthlyWorkspaceRepository({ db });
  const groupCodeRepo = createGroupCodeRepository({ db });
  const storeBillRepo = createStoreBillRepository({ db });
  const missingRepo = createMissingReceiptRepository({ db });
  const errorRepo = createErrorRecordRepository({ db });
  const importJobRepo = createImportJobRepository({ db });
  const workspaceService = createMonthlyWorkspaceService({ workspaceRepo });
  const importService = createImportService({
    importJobRepo,
    groupCodeRepo,
    storeBillRepo,
    missingReceiptRepo: missingRepo,
  });
  const errorService = createErrorDetectionService({
    storeBillRepo,
    errorRecordRepo: errorRepo,
  });

  workspaceService.open({ workspaceKey: WORKSPACE_KEY, operator: 'smoke' });
  console.log(`[smoke] workspace ${WORKSPACE_KEY} opened`);

  // 1. group code import
  const gcFile = path.join(DATA_ROOT, '1.团号汇总', '团号汇总.xlsx');
  console.log(`[smoke] importing group code: ${gcFile}`);
  let t = Date.now();
  const gcJob = await importService.importGroupCode({
    workspaceKey: WORKSPACE_KEY,
    filePath: gcFile,
    operator: 'smoke',
  });
  console.log(
    `[smoke]   rowsTotal=${gcJob.rowsTotal}, inserted=${gcJob.rowsInserted}, skipped=${gcJob.rowsSkipped}, ms=${Date.now() - t}`
  );

  // Re-run for idempotency
  t = Date.now();
  const gcJob2 = await importService.importGroupCode({
    workspaceKey: WORKSPACE_KEY,
    filePath: gcFile,
    operator: 'smoke',
  });
  console.log(
    `[smoke]   (rerun) inserted=${gcJob2.rowsInserted}, skipped=${gcJob2.rowsSkipped}, ms=${Date.now() - t}`
  );
  console.log(`[smoke]   db count: ${groupCodeRepo.countByWorkspace(WORKSPACE_KEY)}`);

  // 2. store bill import (爱宝客 — smaller file)
  const billFile = path.join(DATA_ROOT, '3.账单表', '爱宝客', '1月爱宝客客人账单数据.xlsx');
  console.log(`[smoke] importing store bill: ${billFile}`);
  t = Date.now();
  const billJob = await importService.importStoreBill({
    workspaceKey: WORKSPACE_KEY,
    filePath: billFile,
    operator: 'smoke',
  });
  console.log(
    `[smoke]   rowsTotal=${billJob.rowsTotal}, inserted=${billJob.rowsInserted}, skipped=${billJob.rowsSkipped}, ms=${Date.now() - t}`
  );
  console.log(`[smoke]   byFamily: ${JSON.stringify(storeBillRepo.countByFamily(WORKSPACE_KEY))}`);

  // 3. missing receipt import
  const missFile = path.join(DATA_ROOT, '5.未收-用来补齐部分', '1月未收(1).xlsx');
  console.log(`[smoke] importing missing receipts: ${missFile}`);
  t = Date.now();
  const missJob = await importService.importMissingReceipt({
    workspaceKey: WORKSPACE_KEY,
    filePath: missFile,
    operator: 'smoke',
  });
  console.log(
    `[smoke]   rowsTotal=${missJob.rowsTotal}, inserted=${missJob.rowsInserted}, skipped=${missJob.rowsSkipped}, ms=${Date.now() - t}`
  );

  // 4. cross-check
  console.log('[smoke] running rule engine...');
  const ccResult = errorService.runCrossCheck({ workspaceKey: WORKSPACE_KEY });
  console.log(`[smoke]   errors: ${ccResult.totalErrors}, summary: ${JSON.stringify(ccResult.summary)}`);

  // 5. sample group code rows
  const sample = groupCodeRepo.list({ workspaceKey: WORKSPACE_KEY, limit: 3 });
  console.log(`[smoke] sample group codes: ${JSON.stringify(sample, null, 2)}`);

  // 6. cleanup
  db.close?.();
  fs.rmSync(tmpDb, { force: true });
  fs.rmSync(`${tmpDb}-wal`, { force: true });
  fs.rmSync(`${tmpDb}-shm`, { force: true });
  console.log('[smoke] done');
}

run().catch((err) => {
  console.error('[smoke] FAILED', err);
  process.exit(1);
});
