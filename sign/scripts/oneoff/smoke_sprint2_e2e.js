'use strict';

/**
 * Sprint 2 E2E smoke:
 *   1. import group_code from 团号汇总.xlsx
 *   2. import received_receipt from 收票汇总.xlsx
 *   3. import store_bill from 3.账单表/ (all 5 lotte xlsx files)
 *   4. synthesize daily_receipt_export from received_receipt
 *      (真正的每日收票表-员工序号.xlsx 是 OCR 审核后的产出,
 *       样本库里还没有; W3 stage pipeline 只需要核心字段)
 *   5. run tour_match_service  (stage 1.5)
 *   6. run bill_match_service  (stage 2)
 *   7. run merge_service       (fills monthly_data)
 *   8. run second_pass_missing_service (stage 3)
 *   9. run monthly_export_service to produce xlsx files
 *  10. print stats + file list
 */

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { openMonthlyDatabase } = require('../lib/storage/monthly_database');
const { createImportJobRepository } = require('../repositories/import_job_repository');
const { createGroupCodeRepository } = require('../repositories/group_code_repository');
const { createStoreBillRepository } = require('../repositories/store_bill_repository');
const { createMissingReceiptRepository } = require('../repositories/missing_receipt_repository');
const { createReceivedReceiptRepository } = require('../repositories/received_receipt_repository');
const { createDailyReceiptRepository } = require('../repositories/daily_receipt_repository');
const { createBillMatchLogRepository } = require('../repositories/bill_match_log_repository');
const { createPendingReviewRepository } = require('../repositories/pending_review_repository');
const { createMonthlyDataRepository } = require('../repositories/monthly_data_repository');
const { createErrorRecordRepository } = require('../repositories/error_record_repository');

const { createImportService } = require('../services/monthly/import_service');
const { createTourMatchService } = require('../services/monthly/tour_match_service');
const { createBillMatchService } = require('../services/monthly/bill_match_service');
const { createMergeService } = require('../services/monthly/merge_service');
const { createSecondPassMissingService } = require('../services/monthly/second_pass_missing_service');
const { createMonthlyExportService } = require('../services/monthly/monthly_export_service');

const SAMPLE_ROOT = path.resolve(
  process.env.SAMPLE_ROOT || path.join(__dirname, '..', '..', 'data_sample', '新建文件夹')
);
const WORKSPACE_KEY = '2026-01';

function hrsec(t) { return `${((Date.now() - t) / 1000).toFixed(1)}s`; }

async function main() {
  const tmp = path.join(os.tmpdir(), `sprint2-e2e-${Date.now()}.sqlite`);
  const outDir = path.join(os.tmpdir(), `sprint2-e2e-out-${Date.now()}`);
  console.log('[smoke] sample root:', SAMPLE_ROOT);
  console.log('[smoke] db:', tmp);
  console.log('[smoke] out:', outDir);
  const db = openMonthlyDatabase({ dbPath: tmp });

  const importJobRepo = createImportJobRepository({ db });
  const groupCodeRepo = createGroupCodeRepository({ db });
  const storeBillRepo = createStoreBillRepository({ db });
  const missingReceiptRepo = createMissingReceiptRepository({ db });
  const receivedReceiptRepo = createReceivedReceiptRepository({ db });
  const dailyReceiptRepo = createDailyReceiptRepository({ db });
  const billMatchLogRepo = createBillMatchLogRepository({ db });
  const pendingReviewRepo = createPendingReviewRepository({ db });
  const monthlyDataRepo = createMonthlyDataRepository({ db });
  const errorRecordRepo = createErrorRecordRepository({ db });

  const importer = createImportService({
    importJobRepo, groupCodeRepo, storeBillRepo, missingReceiptRepo,
    receivedReceiptRepo, dailyReceiptRepo,
  });

  // ---- 1. group_code ----
  const groupCodeFile = path.join(SAMPLE_ROOT, '1.团号汇总', '团号汇总.xlsx');
  console.log(`\n[1/9] importing group_code: ${path.basename(groupCodeFile)}`);
  let t = Date.now();
  const gcJob = await importer.importGroupCode({
    workspaceKey: WORKSPACE_KEY, filePath: groupCodeFile, operator: 'smoke',
  });
  console.log(`  rows=${gcJob.rowsInserted} skipped=${gcJob.rowsSkipped} in ${hrsec(t)}`);

  // ---- 2. received_receipt ----
  const receiptFile = path.join(SAMPLE_ROOT, '2.收票汇总', '收票汇总.xlsx');
  console.log(`\n[2/9] importing received_receipt: ${path.basename(receiptFile)}`);
  t = Date.now();
  const rrJob = await importer.importReceivedReceipt({
    workspaceKey: WORKSPACE_KEY, filePath: receiptFile, operator: 'smoke',
  });
  console.log(`  rows=${rrJob.rowsInserted} skipped=${rrJob.rowsSkipped} in ${hrsec(t)}`);

  // ---- 3. store_bill (all xlsx in 3.账单表/乐天SG+H团+釜山) ----
  const billDir = path.join(SAMPLE_ROOT, '3.账单表', '乐天SG+H团+釜山');
  const billFiles = fs.readdirSync(billDir)
    .filter((f) => f.endsWith('.xlsx'))
    .map((f) => path.join(billDir, f));
  console.log(`\n[3/9] importing store_bill: ${billFiles.length} files`);
  t = Date.now();
  let billInserted = 0;
  for (const bf of billFiles) {
    const job = await importer.importStoreBill({
      workspaceKey: WORKSPACE_KEY, filePath: bf, operator: 'smoke',
    });
    console.log(`  ${path.basename(bf)}: +${job.rowsInserted} (skip ${job.rowsSkipped})`);
    billInserted += job.rowsInserted;
  }
  console.log(`  total store_bill rows: ${billInserted} in ${hrsec(t)}`);

  // ---- 4. synthesize daily_receipt_export from received_receipt ----
  console.log('\n[4/9] synthesizing daily_receipt_export from received_receipt');
  t = Date.now();
  const synthesized = synthesizeDailyFromReceived(db, WORKSPACE_KEY);
  console.log(`  synthesized ${synthesized} daily rows in ${hrsec(t)}`);

  // ---- 5. stage 1.5 tour_match ----
  console.log('\n[5/9] stage 1.5 tour_match_service');
  t = Date.now();
  const tourSvc = createTourMatchService({
    dailyReceiptRepo, groupCodeRepo, pendingReviewRepo, errorRecordRepo,
  });
  const tourResult = await tourSvc.run({ workspaceKey: WORKSPACE_KEY });
  console.log(`  scanned=${tourResult.scanned} matched=${tourResult.matched} ` +
    `tourNotFound=${tourResult.tourNotFound} agentMismatch=${tourResult.agentMismatch} ` +
    `modeUnresolved=${tourResult.modeUnresolved} in ${hrsec(t)}`);
  console.log('  folder breakdown:', tourResult.folderBreakdown);

  // ---- 6. stage 2 bill_match ----
  console.log('\n[6/9] stage 2 bill_match_service');
  t = Date.now();
  const billSvc = createBillMatchService({
    storeBillRepo, dailyReceiptRepo, billMatchLogRepo, pendingReviewRepo,
  });
  const billResult = await billSvc.run({ workspaceKey: WORKSPACE_KEY });
  console.log(`  bills=${billResult.billsScanned} matched=${billResult.matched} ` +
    `ambiguous=${billResult.ambiguous} fuzzy=${billResult.fuzzy} ` +
    `unmatched=${billResult.unmatched} conflicts=${billResult.conflicts} in ${hrsec(t)}`);
  console.log('  priority breakdown:', billResult.priorityBreakdown);

  // ---- 7. merge ----
  console.log('\n[7/9] merge_service');
  t = Date.now();
  const mergeSvc = createMergeService({ dailyReceiptRepo, billMatchLogRepo, monthlyDataRepo });
  const mergeResult = await mergeSvc.run({ workspaceKey: WORKSPACE_KEY });
  console.log(`  monthly_data +${mergeResult.inserted} matched=${mergeResult.matched} ` +
    `unmatched=${mergeResult.unmatched} noFolder=${mergeResult.skippedNoFolder} in ${hrsec(t)}`);

  // ---- 8. stage 3 second_pass ----
  console.log('\n[8/9] stage 3 second_pass_missing_service');
  t = Date.now();
  const secondSvc = createSecondPassMissingService({
    dailyReceiptRepo, storeBillRepo, pendingReviewRepo,
  });
  const secondResult = await secondSvc.run({ workspaceKey: WORKSPACE_KEY });
  console.log(`  scanned=${secondResult.scanned} promoted=${secondResult.promotedToReview} ` +
    `stillMissing=${secondResult.stillMissing} ambiguous=${secondResult.ambiguousCandidates} in ${hrsec(t)}`);

  // ---- 9. xlsx export ----
  console.log('\n[9/9] monthly_export_service');
  t = Date.now();
  const exportSvc = createMonthlyExportService({ monthlyDataRepo, pendingReviewRepo, db });
  const exportResult = await exportSvc.run({ workspaceKey: WORKSPACE_KEY, outputDir: outDir });
  for (const f of exportResult.files) {
    const sz = (fs.statSync(f.path).size / 1024).toFixed(1);
    console.log(`  ${f.kind.padEnd(9)} ${path.basename(f.path).padEnd(24)} ${String(f.rows).padStart(6)} rows   ${sz} KB`);
  }
  console.log(`  exported ${exportResult.files.length} files in ${hrsec(t)}`);

  console.log('\n[smoke] summary');
  console.log(`  group_code:       ${gcJob.rowsInserted}`);
  console.log(`  received_receipt: ${rrJob.rowsInserted}`);
  console.log(`  store_bill:       ${billInserted}`);
  console.log(`  daily_receipt:    ${synthesized}`);
  console.log(`  monthly_data:     ${monthlyDataRepo.countByWorkspace(WORKSPACE_KEY)}`);
  console.log(`  pending_review:   ${pendingReviewRepo.countOpen(WORKSPACE_KEY)}`);
  console.log(`  bill_match_log:   ${billMatchLogRepo.countByWorkspace(WORKSPACE_KEY)}`);
  console.log('\n[smoke] OK');
}

/**
 * Synthesizes daily_receipt_export rows directly from received_receipt
 * so the stage 1.5/2 pipeline has something to chew on. Real production
 * would import 每日收票表-员工序号.xlsx via `importDailyReceipt`.
 */
function synthesizeDailyFromReceived(db, workspaceKey) {
  const rows = db.prepare(`
    SELECT receipt_date, agent, purchase_date, receipt_no, tour_no, name,
           passport_no, departure_date, mode_raw, mode_normalized
    FROM received_receipt WHERE workspace_key = ?
  `).all(workspaceKey);
  const importedAt = new Date().toISOString();
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO daily_receipt_export (
      workspace_key, stmt_date, agent, purchase_date,
      receipt_no, tour_no, name, passport_no, departure_date,
      mode_raw, mode_normalized, row_hash, imported_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let inserted = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const hash = crypto.createHash('sha1').update(JSON.stringify({
        w: workspaceKey, r: r.receipt_no, n: r.name, p: r.passport_no,
        pd: r.purchase_date, t: r.tour_no,
      })).digest('hex');
      const result = insertStmt.run(
        workspaceKey,
        r.receipt_date, r.agent, r.purchase_date,
        r.receipt_no, r.tour_no, r.name, r.passport_no, r.departure_date,
        r.mode_raw, r.mode_normalized,
        hash, importedAt
      );
      if (result.changes > 0) inserted += 1;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return inserted;
}

main().catch((err) => {
  console.error('[smoke] FAIL', err);
  process.exit(1);
});
