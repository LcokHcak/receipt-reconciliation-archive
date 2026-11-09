'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { runMigrations } = require('../../lib/storage/migration_runner');
const { createBillMatchBucketService } = require('../../services/monthly/bill_match_bucket_service');
const { createStoreBillRepository } = require('../../repositories/store_bill_repository');
const { createDailyReceiptRepository } = require('../../repositories/daily_receipt_repository');
const { createBillMatchLogRepository } = require('../../repositories/bill_match_log_repository');
const { createPendingReviewRepository } = require('../../repositories/pending_review_repository');
const { createMatchBadcaseRepository } = require('../../repositories/match_badcase_repository');
const { createMonthlyDataRepository } = require('../../repositories/monthly_data_repository');
const { createModeDeductConfigRepository } = require('../../repositories/monthly/mode_deduct_config_repo');
const { createModeFolderMappingRepository } = require('../../repositories/monthly/mode_folder_mapping_repo');
const { createImportJobRepository } = require('../../repositories/import_job_repository');
const { allFolders } = require('../../lib/monthly_pipeline/mode_folder_classifier');

const MIGRATIONS = path.join(__dirname, '..', '..', 'lib', 'storage', 'migrations');
const WS = '2026-05';

function makeCtx() {
  const db = new DatabaseSync(':memory:');
  runMigrations(db, MIGRATIONS, { logger: { info() {}, warn() {}, error() {} } });
  db.exec(`
    INSERT INTO monthly_workspace (workspace_key, year, month, status, created_at, updated_at)
    VALUES ('${WS}', 2026, 5, 'open', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z')
  `);
  const storeBillRepo = createStoreBillRepository({ db });
  const dailyReceiptRepo = createDailyReceiptRepository({ db });
  const billMatchLogRepo = createBillMatchLogRepository({ db });
  const pendingReviewRepo = createPendingReviewRepository({ db });
  const matchBadcaseRepo = createMatchBadcaseRepository({ db });
  const monthlyDataRepo = createMonthlyDataRepository({ db });
  const modeDeductConfigRepo = createModeDeductConfigRepository({ db });
  const modeFolderMappingRepo = createModeFolderMappingRepository({ db });
  const importJobRepo = createImportJobRepository({ db });
  const service = createBillMatchBucketService({
    db,
    storeBillRepo,
    dailyReceiptRepo,
    billMatchLogRepo,
    pendingReviewRepo,
    matchBadcaseRepo,
    monthlyDataRepo,
    modeDeductConfigRepo,
    modeFolderMappingRepo,
    importJobRepo,
  });
  return {
    db,
    storeBillRepo,
    dailyReceiptRepo,
    billMatchLogRepo,
    pendingReviewRepo,
    matchBadcaseRepo,
    monthlyDataRepo,
    modeDeductConfigRepo,
    modeFolderMappingRepo,
    importJobRepo,
    service,
  };
}

test('bill-match buckets returns four empty buckets for a clean workspace', () => {
  const { service } = makeCtx();
  const result = service.getBucketsOverview(WS);

  assert.equal(result.buckets.length, 4);
  assert.equal(result.global.totalBills, 0);
  assert.equal(result.global.totalDaily, 0);
  assert.equal(result.global.matched, 0);
  assert.ok(result.buckets.every((bucket) => bucket.isEmpty));
});

test('bill-match buckets aggregates daily, bills, imports, deducts, and match logs', () => {
  const ctx = makeCtx();
  ctx.modeDeductConfigRepo.upsertRows({
    workspaceKey: WS,
    updatedBy: 'tester',
    updatedAt: '2026-05-01T00:00:00.000Z',
    rows: [{ modeFolder: '乐天首尔', deductValue: 0.0333 }],
  });
  ctx.modeFolderMappingRepo.upsertRows({
    workspaceKey: WS,
    updatedBy: 'tester',
    updatedAt: '2026-05-01T00:00:00.000Z',
    rows: [{ modeRaw: '乐天SG-本司', modeFolder: '乐天首尔' }],
  });
  ctx.storeBillRepo.insertMany([
    bill({ id: 1, receiptNo: 'R1', sourceFile: 'lotte-seoul-main.xlsx', sourceRow: 1 }),
    bill({ id: 2, receiptNo: 'R2', sourceFile: 'lotte-seoul-main.xlsx', sourceRow: 2 }),
  ]);
  ctx.db.prepare(`
    INSERT INTO daily_receipt_export (
      workspace_key, mode_raw, mode_folder, receipt_no, purchase_date,
      bill_match_status, tour_match_status, row_hash, imported_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(WS, '乐天SG-本司', '乐天首尔', 'R1', '2026-05-02', 'matched', 'matched', 'daily-1', now());
  ctx.billMatchLogRepo.insertMany([{
    workspaceKey: WS,
    dailyReceiptId: 1,
    storeBillId: 1,
    matchPriority: 1,
    matchKey: 'R1',
    matchStatus: 'matched',
    matchedAt: now(),
  }]);
  const importJobId = ctx.importJobRepo.create({
    workspaceKey: WS,
    jobType: 'store_bill',
    sourceFile: 'lotte-seoul-main.xlsx',
    fileSize: 12,
    sha256: 'abc',
    operator: 'tester',
    startedAt: now(),
    bucketFolder: '乐天首尔',
  });
  ctx.importJobRepo.finalize({
    id: importJobId,
    status: 'done',
    rowsTotal: 2,
    rowsInserted: 2,
    rowsSkipped: 0,
    finishedAt: now(),
  });

  const result = ctx.service.getBucketsOverview(WS);
  const bucket = result.buckets.find((item) => item.folder === '乐天首尔');

  assert.equal(bucket.billCount, 2);
  assert.equal(bucket.dailyCount, 1);
  assert.equal(bucket.deductValue, 0.0333);
  assert.deepEqual(bucket.modeRaws, ['乐天SG-本司']);
  assert.equal(bucket.billFiles.length, 1);
  assert.equal(bucket.billFiles[0].rows, 2);
  assert.equal(bucket.matchStats.matched, 1);
  assert.equal(bucket.matchStats.unmatched, 1);
  assert.equal(bucket.matchStats.priorityBreakdown['1'], 1);
  assert.equal(result.global.totalBills, 2);
  assert.equal(result.global.totalDaily, 1);
  assert.equal(result.global.matched, 1);
});

test('bill-match buckets count matched ledger rows, not duplicated bill detail logs', () => {
  const ctx = makeCtx();
  const folder = allFolders()[0];
  ctx.storeBillRepo.insertMany([
    bill({ receiptNo: 'R1', sourceFile: 'lotte-seoul-main.xlsx', sourceRow: 1 }),
    bill({ receiptNo: 'R1', sourceFile: 'lotte-seoul-main.xlsx', sourceRow: 2, rowHash: 'bill-r1-2' }),
    bill({ receiptNo: 'R2', sourceFile: 'lotte-seoul-main.xlsx', sourceRow: 3, rowHash: 'bill-r2-3' }),
  ]);
  ctx.db.prepare(`
    INSERT INTO daily_receipt_export (
      workspace_key, mode_raw, mode_folder, receipt_no, purchase_date,
      bill_match_status, tour_match_status, row_hash, imported_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(WS, 'lotte-sg', folder, 'R1', '2026-05-02', 'matched', 'matched', 'daily-1', now());
  const daily = ctx.dailyReceiptRepo._listAll({ workspaceKey: WS })[0];
  const bills = ctx.storeBillRepo.list({ workspaceKey: WS, limit: 10 });
  const r1Bills = bills.filter((item) => item.receiptNo === 'R1');

  ctx.billMatchLogRepo.insertMany([
    {
      workspaceKey: WS,
      dailyReceiptId: daily.id,
      storeBillId: r1Bills[0].id,
      matchPriority: 1,
      matchKey: 'R1',
      matchStatus: 'matched',
      matchedAt: now(),
    },
    {
      workspaceKey: WS,
      dailyReceiptId: daily.id,
      storeBillId: r1Bills[1].id,
      matchPriority: 1,
      matchKey: 'R1',
      matchStatus: 'matched',
      matchedAt: now(),
    },
    {
      workspaceKey: WS,
      dailyReceiptId: daily.id,
      storeBillId: r1Bills[1].id,
      matchPriority: 1,
      matchKey: 'R1',
      matchStatus: 'matched',
      matchedAt: now(),
    },
  ]);

  const result = ctx.service.getBucketsOverview(WS);
  const bucket = result.buckets.find((item) => item.folder === folder);

  assert.equal(bucket.billCount, 3);
  assert.equal(bucket.dailyCount, 1);
  assert.equal(bucket.matchStats.matched, 1);
  assert.equal(bucket.matchStats.matchedBillRows, 2);
  assert.equal(bucket.matchStats.unmatched, 1);
  assert.equal(result.global.matched, 1);
  assert.equal(result.global.matchedBillRows, 2);
  assert.equal(result.global.matchRate, 1);
  assert.equal(result.global.billDetailCoverageRate, 2 / 3);
});

test('import_job stores and maps bucket_folder', () => {
  const { importJobRepo } = makeCtx();
  const id = importJobRepo.create({
    workspaceKey: WS,
    jobType: 'store_bill',
    sourceFile: 'ipark.xlsx',
    startedAt: now(),
    bucketFolder: '爱宝客',
  });

  assert.equal(importJobRepo.findById(id).bucketFolder, '爱宝客');
  assert.equal(importJobRepo.listByWorkspace({ workspaceKey: WS, jobType: 'store_bill' })[0].bucketFolder, '爱宝客');
});

test('bill-match bucket clear removes old bills and invalidates stale match outputs only for that bucket', () => {
  const ctx = makeCtx();
  const [folder, otherFolder] = allFolders();
  const oldJobId = createDoneImportJob(ctx.importJobRepo, { sourceFile: 'lotte-old.xlsx', bucketFolder: folder, rows: 1 });
  const otherJobId = createDoneImportJob(ctx.importJobRepo, { sourceFile: 'ipark.xlsx', bucketFolder: otherFolder, rows: 1 });

  ctx.storeBillRepo.insertMany([
    bill({ receiptNo: 'R-OLD', sourceFile: 'lotte-old.xlsx', sourceRow: 1, importJobId: oldJobId }),
    bill({ receiptNo: 'R-KEEP', sourceFile: 'ipark.xlsx', sourceRow: 1, importJobId: otherJobId, rowHash: 'bill-keep' }),
  ]);
  ctx.dailyReceiptRepo.insertMany([{
    workspaceKey: WS,
    receiptNo: 'R-OLD',
    purchaseDate: '2026-05-02',
    billMatchStatus: 'matched',
    billMatchPriority: 1,
    conflictFields: [{ field: 'name' }],
    rowHash: 'daily-old',
    importedAt: now(),
  }]);
  const daily = ctx.dailyReceiptRepo._listAll({ workspaceKey: WS })[0];
  const bills = ctx.storeBillRepo.list({ workspaceKey: WS, limit: 10 });
  const oldBill = bills.find((item) => item.receiptNo === 'R-OLD');
  const keepBill = bills.find((item) => item.receiptNo === 'R-KEEP');

  ctx.billMatchLogRepo.insertMany([{
    workspaceKey: WS,
    dailyReceiptId: daily.id,
    storeBillId: oldBill.id,
    matchPriority: 1,
    matchKey: 'R-OLD',
    matchStatus: 'matched',
    matchedAt: now(),
  }]);
  ctx.pendingReviewRepo.insertMany([{
    workspaceKey: WS,
    sourceTable: 'store_bill',
    sourceId: oldBill.id,
    reasonType: 'field_conflict',
    detail: { receiptNo: 'R-OLD' },
    createdAt: now(),
  }]);
  ctx.matchBadcaseRepo.insertMany([{
    workspaceKey: WS,
    stage: 'bill_match',
    kind: 'field_conflict',
    sourceTable: 'store_bill',
    sourceId: oldBill.id,
    dailyReceiptId: daily.id,
    storeBillId: oldBill.id,
    receiptNo: 'R-OLD',
    snapshot: {},
    createdAt: now(),
  }]);
  ctx.monthlyDataRepo.insertMany([{
    workspaceKey: WS,
    modeFolder: folder,
    isUnmatched: false,
    dailyReceiptId: daily.id,
    storeBillId: oldBill.id,
    receiptNo: 'R-OLD',
    rowHash: 'monthly-old',
    createdAt: now(),
  }]);

  const result = ctx.service.clearBucketBills({ workspaceKey: WS, folder, operator: 'tester' });

  assert.equal(result.deletedBills, 1);
  assert.equal(ctx.storeBillRepo.findByReceipt({ workspaceKey: WS, receiptNo: 'R-OLD' }).length, 0);
  assert.equal(ctx.storeBillRepo.findByReceipt({ workspaceKey: WS, receiptNo: 'R-KEEP' })[0].id, keepBill.id);
  assert.equal(ctx.billMatchLogRepo.findByDaily({ workspaceKey: WS, dailyReceiptId: daily.id }).length, 0);
  assert.equal(ctx.pendingReviewRepo.list({ workspaceKey: WS, status: 'open' }).length, 0);
  assert.equal(ctx.matchBadcaseRepo.count({ workspaceKey: WS }), 0);
  assert.equal(ctx.monthlyDataRepo.countByWorkspace(WS), 0);
  const resetDaily = ctx.dailyReceiptRepo._fetchFullById({ workspaceKey: WS, id: daily.id });
  assert.equal(resetDaily.billMatchStatus, 'unmatched');
  assert.equal(resetDaily.billMatchPriority, null);
  assert.equal(resetDaily.conflictFields, null);
  assert.equal(ctx.importJobRepo.findById(oldJobId).status, 'replaced');
  assert.equal(ctx.importJobRepo.findById(otherJobId).status, 'done');
  const overview = ctx.service.getBucketsOverview(WS);
  const clearedBucket = overview.buckets.find((item) => item.folder === folder);
  assert.equal(clearedBucket.billFiles.length, 0);
});

function bill({ receiptNo, sourceFile, sourceRow, importJobId = null, rowHash = null }) {
  return {
    workspaceKey: WS,
    storeFamily: '乐天',
    storeBranch: '乐天首尔',
    receiptNo,
    purchaseDate: '2026-05-02',
    isDetailSheet: true,
    sourceFile,
    sourceSheet: 'Sheet1',
    sourceRow,
    rowHash: rowHash || `bill-${receiptNo}`,
    importedAt: now(),
    importJobId,
    transactionType: 'sale',
  };
}

function createDoneImportJob(importJobRepo, { sourceFile, bucketFolder, rows }) {
  const id = importJobRepo.create({
    workspaceKey: WS,
    jobType: 'store_bill',
    sourceFile,
    fileSize: 12,
    sha256: `${sourceFile}-sha`,
    operator: 'tester',
    startedAt: now(),
    bucketFolder,
  });
  importJobRepo.finalize({
    id,
    status: 'done',
    rowsTotal: rows,
    rowsInserted: rows,
    rowsSkipped: 0,
    finishedAt: now(),
  });
  return id;
}

function now() {
  return '2026-05-01T00:00:00.000Z';
}

// A1复核HIGH(2026-07-16):桶级替换=整桶账单作废——人工锁定 bill_match 的行必须
// 解除账单三列锁再重置(否则=僵尸锁,新账单永远匹不上);其它人工锁(如团号)原样保留。
test('bucket clear 解除人工账单锁并重置行;非账单锁保留(防僵尸锁)', () => {
  const ctx = makeCtx();
  const [folder] = allFolders();
  const jobId = createDoneImportJob(ctx.importJobRepo, { sourceFile: 'lotte-v1.xlsx', bucketFolder: folder, rows: 1 });
  ctx.storeBillRepo.insertMany([
    bill({ receiptNo: 'R-LOCK', sourceFile: 'lotte-v1.xlsx', sourceRow: 1, importJobId: jobId }),
  ]);
  ctx.dailyReceiptRepo.insertMany([{
    workspaceKey: WS, receiptNo: 'R-LOCK', purchaseDate: '2026-05-02',
    rowHash: 'daily-lock', importedAt: now(),
  }]);
  const daily = ctx.dailyReceiptRepo._listAll({ workspaceKey: WS })[0];
  const lockBill = ctx.storeBillRepo.list({ workspaceKey: WS, limit: 10 })[0];
  // 人工 resolve 同款:锁 billMatchStatus=matched;再锁一个非账单字段(团号)当"其他锁"对照
  ctx.dailyReceiptRepo.applyFieldUpdates({
    id: daily.id, workspaceKey: WS, manualLock: true,
    updates: { billMatchStatus: 'matched', billMatchPriority: 1, tourNo: 'T-MANUAL' },
  });
  ctx.billMatchLogRepo.insertMany([{
    workspaceKey: WS, dailyReceiptId: daily.id, storeBillId: lockBill.id,
    matchPriority: 1, matchKey: 'R-LOCK', matchStatus: 'matched', matchedAt: now(),
  }]);

  const result = ctx.service.clearBucketBills({ workspaceKey: WS, folder, operator: 'tester' });

  assert.equal(result.clearedLocks, 1, '应报告解除了1行的账单锁');
  const after = ctx.dailyReceiptRepo._fetchFullById({ workspaceKey: WS, id: daily.id });
  assert.equal(after.billMatchStatus, 'unmatched', '锁已解除,行应被正常重置(不再是绕锁或僵尸)');
  const locks = String(after.manualLockedFields || '');
  assert.ok(!locks.includes('bill_match_status'), '账单锁必须被解除');
  assert.ok(!locks.includes('bill_match_priority'));
  assert.ok(locks.includes('tour_no'), '非账单人工锁(团号)必须原样保留');
});
