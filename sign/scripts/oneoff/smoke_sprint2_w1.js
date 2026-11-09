'use strict';

/**
 * Sprint 2 W1 smoke — proves the new Sprint 2 schema + repos + mappers
 * import cleanly against the real sample files. Does NOT persist to the
 * project DB; uses a throwaway sqlite file in %TEMP%.
 *
 * Usage: node scripts/smoke_sprint2_w1.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openMonthlyDatabase } = require('../lib/storage/monthly_database');
const { createImportJobRepository } = require('../repositories/import_job_repository');
const { createGroupCodeRepository } = require('../repositories/group_code_repository');
const { createStoreBillRepository } = require('../repositories/store_bill_repository');
const { createMissingReceiptRepository } = require('../repositories/missing_receipt_repository');
const { createReceivedReceiptRepository } = require('../repositories/received_receipt_repository');
const { createDailyReceiptRepository } = require('../repositories/daily_receipt_repository');
const { createImportService } = require('../services/monthly/import_service');

const WORKSPACE_KEY = '2026-01';
const RECEIPT_XLSX = 'd:/JIN HAIMIN/self/ticket/data_sample/新建文件夹/2.收票汇总/收票汇总.xlsx';
const DAILY_TEMPLATE = 'd:/JIN HAIMIN/self/ticket/小票规则/每日收票表-员工序号.xlsx';

(async () => {
  const tmpDb = path.join(os.tmpdir(), `sprint2-w1-smoke-${Date.now()}.sqlite`);
  console.log(`[smoke] db: ${tmpDb}`);
  const db = openMonthlyDatabase({ dbPath: tmpDb });

  const repos = {
    importJobRepo: createImportJobRepository({ db }),
    groupCodeRepo: createGroupCodeRepository({ db }),
    storeBillRepo: createStoreBillRepository({ db }),
    missingReceiptRepo: createMissingReceiptRepository({ db }),
    receivedReceiptRepo: createReceivedReceiptRepository({ db }),
    dailyReceiptRepo: createDailyReceiptRepository({ db }),
  };
  const importService = createImportService(repos);

  // Schema sanity — confirm new columns exist on store_bill
  const cols = db.prepare('PRAGMA table_info(store_bill)').all().map((r) => r.name);
  for (const col of ['statement_date', 'payment_mode', 'customer_points', 'remark']) {
    if (!cols.includes(col)) {
      console.error(`[smoke] MISSING column store_bill.${col}`);
      process.exit(1);
    }
  }
  console.log(`[smoke] store_bill has ${cols.length} columns — extensions applied`);

  // Test 1: 每日收票表 template (headers-only)
  if (fs.existsSync(DAILY_TEMPLATE)) {
    console.log(`\n[smoke] importing daily_receipt template: ${path.basename(DAILY_TEMPLATE)}`);
    const t = Date.now();
    const job = await importService.importDailyReceipt({
      workspaceKey: WORKSPACE_KEY,
      filePath: DAILY_TEMPLATE,
      operator: 'smoke',
    });
    console.log(`  rows_total=${job.rowsTotal} inserted=${job.rowsInserted} skipped=${job.rowsSkipped} in ${Date.now() - t}ms`);
    console.log(`  schema-only template (0 data rows expected)`);
  } else {
    console.warn(`[smoke] daily template missing: ${DAILY_TEMPLATE}`);
  }

  // Test 2: 收票汇总 (25 worker sheets, ~48 MB)
  if (fs.existsSync(RECEIPT_XLSX)) {
    const stats = fs.statSync(RECEIPT_XLSX);
    console.log(`\n[smoke] importing 收票汇总.xlsx (${(stats.size / 1e6).toFixed(1)} MB)`);
    const t = Date.now();
    const job = await importService.importReceivedReceipt({
      workspaceKey: WORKSPACE_KEY,
      filePath: RECEIPT_XLSX,
      operator: 'smoke',
    });
    console.log(`  rows_total=${job.rowsTotal} inserted=${job.rowsInserted} skipped=${job.rowsSkipped} in ${Date.now() - t}ms`);
    const sheets = (job.details && job.details.sheets) || [];
    const processedSheets = sheets.filter((s) => !s.skipped);
    const skippedSheets = sheets.filter((s) => s.skipped);
    console.log(`  sheets: ${processedSheets.length} worker / ${skippedSheets.length} skipped (summary)`);
    console.log(`  skipped sheet names: ${skippedSheets.map((s) => s.name).join(' / ')}`);

    const byWorker = repos.receivedReceiptRepo.countByWorker(WORKSPACE_KEY);
    console.log(`\n  by worker (top 10):`);
    for (const w of byWorker.slice(0, 10)) {
      console.log(`    #${String(w.worker_no || '-').padEnd(3)} ${String(w.worker || '-').padEnd(12)} ${w.n}`);
    }

    // Verify monthly_data table is queryable
    const count = repos.receivedReceiptRepo.countByWorkspace(WORKSPACE_KEY);
    console.log(`\n  received_receipt total: ${count}`);

    if (count === 0) {
      console.error('[smoke] FAILED: expected >0 received_receipt rows');
      process.exit(1);
    }
  } else {
    console.warn(`[smoke] 收票汇总 missing: ${RECEIPT_XLSX}`);
  }

  // Confirm monthly_data table exists + is empty
  const mdCount = db.prepare('SELECT COUNT(1) AS n FROM monthly_data').get().n;
  console.log(`\n[smoke] monthly_data rows: ${mdCount} (expected 0; stage-2 populates this)`);

  db.close?.();
    try { fs.rmSync(tmpDb); fs.rmSync(`${tmpDb}-wal`, { force: true }); fs.rmSync(`${tmpDb}-shm`, { force: true }); } catch {
      // intentional: best-effort cleanup
    }
  console.log('\n[smoke] OK');
})().catch((err) => {
  console.error('[smoke] FAILED', err);
  process.exit(1);
});
