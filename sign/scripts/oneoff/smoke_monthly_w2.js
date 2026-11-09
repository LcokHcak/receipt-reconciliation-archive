'use strict';

/**
 * W2 smoke: import ALL store-bill + missing xlsx files in
 * data_sample/新建文件夹 into a temp DB, then run cross-check.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openMonthlyDatabase } = require('../lib/storage/monthly_database');
const { createMonthlyWorkspaceRepository } = require('../repositories/monthly_workspace_repository');
const { createGroupCodeRepository } = require('../repositories/group_code_repository');
const { createStoreBillRepository } = require('../repositories/store_bill_repository');
const { createMissingReceiptRepository } = require('../repositories/missing_receipt_repository');
const { createErrorRecordRepository } = require('../repositories/error_record_repository');
const { createImportJobRepository } = require('../repositories/import_job_repository');
const { createMonthlyWorkspaceService } = require('../services/monthly/workspace_service');
const { createImportService } = require('../services/monthly/import_service');
const { createErrorDetectionService } = require('../services/monthly/error_detection_service');

const DATA_ROOT = 'd:/JIN HAIMIN/self/ticket/data_sample/新建文件夹';
const WORKSPACE_KEY = '2026-01';

const GROUP_FILES = [
  path.join(DATA_ROOT, '1.团号汇总', '团号汇总.xlsx'),
];

const BILL_FILES = [
  path.join(DATA_ROOT, '3.账单表', '爱宝客', '1月爱宝客客人账单数据.xlsx'),
  path.join(DATA_ROOT, '3.账单表', '乐天SG+H团+釜山', '1月乐天H 客人账单.xlsx'),
  path.join(DATA_ROOT, '3.账单表', '乐天SG+H团+釜山', '乐天SG 1月客人账单.xlsx'),
  path.join(DATA_ROOT, '3.账单表', '乐天SG+H团+釜山', '乐天B团卖出1月-客人账单.xlsx'),
  path.join(DATA_ROOT, '3.账单表', '乐天SG+H团+釜山', '乐天釜山卖出1月-客人账单.xlsx'),
  path.join(DATA_ROOT, '3.账单表', '新罗V团+济州', '2601月济州新罗V团客人账单数据.xlsx'),
];

const MISSING_FILES = [
  path.join(DATA_ROOT, '5.未收-用来补齐部分', '1月未收(1).xlsx'),
  path.join(DATA_ROOT, '5.未收-用来补齐部分', '1月爱宝客SG团小票.xlsx'),
  path.join(DATA_ROOT, '5.未收-用来补齐部分', '1月爱宝客PKG团小票.xlsx'),
  path.join(DATA_ROOT, '5.未收-用来补齐部分', '1月乐天H团小票.xlsx'),
  path.join(DATA_ROOT, '5.未收-用来补齐部分', '1月乐天SG小票.xlsx'),
  path.join(DATA_ROOT, '5.未收-用来补齐部分', '1月乐天B团小票.xlsx'),
  path.join(DATA_ROOT, '5.未收-用来补齐部分', '1月乐天釜山SG小票.xlsx'),
  path.join(DATA_ROOT, '5.未收-用来补齐部分', '1月济州新罗V团小票.xlsx'),
];

const MASSIVE_FILE = path.join(DATA_ROOT, '2.收票汇总', '收票汇总.xlsx');

async function run() {
  const tmpDb = path.join(os.tmpdir(), `monthly-w2-${Date.now()}.sqlite`);
  console.log(`[w2] tmp db: ${tmpDb}`);
  const startHeap = process.memoryUsage().rss;

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
  workspaceService.open({ workspaceKey: WORKSPACE_KEY, operator: 'w2' });

  for (const file of GROUP_FILES) {
    if (!fs.existsSync(file)) { console.warn(`[w2] missing: ${file}`); continue; }
    const t = Date.now();
    const job = await importService.importGroupCode({ workspaceKey: WORKSPACE_KEY, filePath: file, operator: 'w2' });
    console.log(`[w2] group: ${path.basename(file)} rows=${job.rowsTotal} ins=${job.rowsInserted} skip=${job.rowsSkipped} ms=${Date.now() - t}`);
  }

  for (const file of BILL_FILES) {
    if (!fs.existsSync(file)) { console.warn(`[w2] missing: ${file}`); continue; }
    const sizeMB = (fs.statSync(file).size / 1024 / 1024).toFixed(1);
    const t = Date.now();
    try {
      const job = await importService.importStoreBill({ workspaceKey: WORKSPACE_KEY, filePath: file, operator: 'w2' });
      console.log(`[w2] bill: ${path.basename(file)} (${sizeMB}MB) rows=${job.rowsTotal} ins=${job.rowsInserted} skip=${job.rowsSkipped} ms=${Date.now() - t}`);
    } catch (e) {
      console.error(`[w2] bill FAIL: ${path.basename(file)} -> ${e.message}`);
    }
  }

  for (const file of MISSING_FILES) {
    if (!fs.existsSync(file)) { console.warn(`[w2] missing: ${file}`); continue; }
    const t = Date.now();
    try {
      const job = await importService.importMissingReceipt({ workspaceKey: WORKSPACE_KEY, filePath: file, operator: 'w2' });
      console.log(`[w2] miss: ${path.basename(file)} rows=${job.rowsTotal} ins=${job.rowsInserted} skip=${job.rowsSkipped} ms=${Date.now() - t}`);
    } catch (e) {
      console.error(`[w2] miss FAIL: ${path.basename(file)} -> ${e.message}`);
    }
  }

  // totals + cross-check
  console.log('\n[w2] ====== TOTALS ======');
  console.log(`  group_code: ${groupCodeRepo.countByWorkspace(WORKSPACE_KEY)}`);
  console.log(`  store_bill: ${storeBillRepo.countByWorkspace(WORKSPACE_KEY)}`);
  console.log(`  by family: ${JSON.stringify(storeBillRepo.countByFamily(WORKSPACE_KEY))}`);
  console.log(`  missing: ${missingRepo.countByWorkspace(WORKSPACE_KEY)}`);

  console.log('\n[w2] running rule engine on full data set...');
  const t = Date.now();
  const cc = errorService.runCrossCheck({ workspaceKey: WORKSPACE_KEY });
  console.log(`  total errors: ${cc.totalErrors}, summary: ${JSON.stringify(cc.summary)}, ms=${Date.now() - t}`);

  // sample 3 errors per type
  for (const type of Object.keys(cc.summary || {})) {
    const rows = errorRepo.list({ workspaceKey: WORKSPACE_KEY, errorType: type, limit: 3 });
    console.log(`\n  -- ${type} samples (showing ${rows.length} / ${cc.summary[type]}) --`);
    rows.forEach((r) => {
      console.log(`    receipt=${r.receiptNo} passport=${r.passportNo} expected=${r.expectedValue} actual=${r.actualValue}`);
    });
  }

  // massive file stream-check (optional based on env)
  if (process.argv.includes('--big') && fs.existsSync(MASSIVE_FILE)) {
    const sizeMB = (fs.statSync(MASSIVE_FILE).size / 1024 / 1024).toFixed(1);
    console.log(`\n[w2] BIG: streaming ${sizeMB}MB 收票汇总.xlsx as missing (may take a while)...`);
    const t2 = Date.now();
    const beforeHeap = process.memoryUsage().rss;
    try {
      const job = await importService.importMissingReceipt({ workspaceKey: WORKSPACE_KEY, filePath: MASSIVE_FILE, operator: 'w2-big' });
      const afterHeap = process.memoryUsage().rss;
      console.log(`[w2]   rows=${job.rowsTotal} ins=${job.rowsInserted} skip=${job.rowsSkipped} ms=${Date.now() - t2}`);
      console.log(`[w2]   rss start=${(startHeap / 1024 / 1024).toFixed(0)}MB before=${(beforeHeap / 1024 / 1024).toFixed(0)}MB after=${(afterHeap / 1024 / 1024).toFixed(0)}MB`);
    } catch (e) {
      console.error(`[w2] BIG FAIL: ${e.message}`);
    }
  } else {
    console.log('\n[w2] skipping 48MB 收票汇总.xlsx (pass --big to include)');
  }

  db.close?.();
  fs.rmSync(tmpDb, { force: true });
  fs.rmSync(`${tmpDb}-wal`, { force: true });
  fs.rmSync(`${tmpDb}-shm`, { force: true });
  const finalHeap = process.memoryUsage().rss;
  console.log(`\n[w2] done. final rss=${(finalHeap / 1024 / 1024).toFixed(0)}MB`);
}

run().catch((err) => { console.error('[w2] FAILED', err); process.exit(1); });
