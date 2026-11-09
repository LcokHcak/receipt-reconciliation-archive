'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { openMonthlyDatabase } = require('../lib/storage/monthly_database');
const { createStoreBillRepository } = require('../repositories/store_bill_repository');
const { createDailyReceiptRepository } = require('../repositories/daily_receipt_repository');
const { createBillMatchLogRepository } = require('../repositories/bill_match_log_repository');
const { createPendingReviewRepository } = require('../repositories/pending_review_repository');
const { createMonthlyDataRepository } = require('../repositories/monthly_data_repository');
const { createStageJobRepository } = require('../repositories/stage_job_repository');
const { createMonthlyReconciliationService } = require('../services/monthly/reconciliation_service');

function withDb(fn) {
  const tmp = path.join(os.tmpdir(), `monthly-reconcile-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  const db = openMonthlyDatabase({ dbPath: tmp });
  try {
    return fn(db);
  } finally {
    try { db.close?.(); } catch {
      // intentional: best-effort cleanup
    }
    try {
      fs.rmSync(tmp, { force: true });
      fs.rmSync(`${tmp}-wal`, { force: true });
      fs.rmSync(`${tmp}-shm`, { force: true });
    } catch {
      // intentional: best-effort cleanup
    }
  }
}

test('monthly reconciliation service explains counts, formulas, and source rows in operator language', () => {
  withDb((db) => {
    const workspaceKey = '2026-05';
    const now = '2026-05-19T08:00:00.000Z';
    const dailyReceiptRepo = createDailyReceiptRepository({ db });
    const storeBillRepo = createStoreBillRepository({ db });
    const billMatchLogRepo = createBillMatchLogRepository({ db });
    const pendingReviewRepo = createPendingReviewRepository({ db });
    const monthlyDataRepo = createMonthlyDataRepository({ db });
    const stageJobRepo = createStageJobRepository({ db });

    dailyReceiptRepo.insertMany([
      {
        workspaceKey,
        receiptNo: '0326155300069',
        shop: 'THE SHILLA',
        purchaseDate: '2026-01-15',
        name: 'ZHENG ANBANG',
        passportNo: 'EF3892854',
        tourNo: '71990',
        modeRaw: '济州新罗V团',
        modeFolder: '济州新罗V团',
        rowHash: 'daily-1',
        importedAt: now,
        sourceFile: '审核台导入.xlsx',
        sourceSheet: '收票',
        sourceRow: 12,
        sourceType: 'workbench',
        modifiedBy: 'reviewer-a',
        ledgerStatus: 'posted',
        postedAt: now,
        postedBy: 'reviewer-a',
      },
      {
        workspaceKey,
        receiptNo: '0326155300070',
        shop: 'THE SHILLA',
        purchaseDate: '2026-01-16',
        name: 'READY ROW',
        passportNo: 'PREADY',
        tourNo: '71990',
        modeRaw: '济州新罗V团',
        modeFolder: '济州新罗V团',
        rowHash: 'daily-2',
        importedAt: now,
        sourceFile: '审核台导入.xlsx',
        sourceSheet: '收票',
        sourceRow: 13,
        sourceType: 'workbench',
        modifiedBy: 'reviewer-a',
        ledgerStatus: 'ready_to_post',
      },
    ]);

    storeBillRepo.insertMany([
      {
        workspaceKey,
        storeFamily: 'THE SHILLA',
        storeBranch: 'JEJU',
        receiptNo: '0326155300069',
        purchaseDate: '2026-01-15',
        name: 'ZHENG ANBANG',
        passportNo: 'EF3892854',
        tourNo: '71990',
        isDetailSheet: true,
        sourceFile: '店铺账单.xlsx',
        sourceSheet: '明细',
        sourceRow: 20,
        rowHash: 'bill-1',
        importedAt: now,
      },
      {
        workspaceKey,
        storeFamily: 'THE SHILLA',
        storeBranch: 'JEJU',
        receiptNo: '0326155300999',
        purchaseDate: '2026-01-16',
        name: 'BILL ONLY',
        passportNo: 'PBILLONLY',
        tourNo: '71990',
        isDetailSheet: true,
        sourceFile: '店铺账单.xlsx',
        sourceSheet: '明细',
        sourceRow: 21,
        rowHash: 'bill-2',
        importedAt: now,
      },
    ]);

    const dailyRows = dailyReceiptRepo._listAll({ workspaceKey });
    const billRows = storeBillRepo.list({ workspaceKey, limit: 10 });
    const matchedDaily = dailyRows.find((row) => row.receiptNo === '0326155300069');
    const matchedBill = billRows.find((row) => row.receiptNo === '0326155300069');
    const unmatchedBill = billRows.find((row) => row.receiptNo === '0326155300999');

    billMatchLogRepo.insertMany([
      {
        workspaceKey,
        dailyReceiptId: matchedDaily.id,
        storeBillId: matchedBill.id,
        matchPriority: 1,
        matchKey: '小票号=0326155300069',
        matchStatus: 'matched',
        matchedAt: now,
        confirmedBy: 'system',
        confirmedAt: now,
      },
      {
        workspaceKey,
        dailyReceiptId: null,
        storeBillId: unmatchedBill.id,
        matchPriority: 99,
        matchKey: '小票号=0326155300999',
        matchStatus: 'unmatched',
        matchedAt: now,
        note: '店铺账单有记录，收票台账没有同号小票',
      },
    ]);

    monthlyDataRepo.insertMany([
      {
        workspaceKey,
        modeFolder: '济州新罗V团',
        isUnmatched: false,
        dailyReceiptId: matchedDaily.id,
        storeBillId: matchedBill.id,
        receiptNo: '0326155300069',
        name: 'ZHENG ANBANG',
        passportNo: 'EF3892854',
        tourNo: '71990',
        shop: 'THE SHILLA',
        purchaseDate: '2026-01-15',
        rowHash: 'monthly-1',
        createdAt: now,
      },
      {
        workspaceKey,
        modeFolder: '济州新罗V团',
        isUnmatched: true,
        dailyReceiptId: null,
        storeBillId: unmatchedBill.id,
        receiptNo: '0326155300999',
        name: 'BILL ONLY',
        passportNo: 'PBILLONLY',
        tourNo: '71990',
        shop: 'THE SHILLA',
        purchaseDate: '2026-01-16',
        rowHash: 'monthly-2',
        createdAt: now,
      },
    ]);

    pendingReviewRepo.insertMany([{
      workspaceKey,
      sourceTable: 'store_bill',
      sourceId: unmatchedBill.id,
      reasonType: 'field_conflict',
      detail: { field: '护照号', billValue: 'PBILLONLY', ledgerValue: '' },
      status: 'open',
      createdAt: now,
    }]);

    const stage = stageJobRepo.acquire({ workspaceKey, stage: 'bill_match', operator: 'finance-a', startedAt: now });
    stageJobRepo.finish({
      id: stage.id,
      status: 'succeeded',
      finishedAt: now,
      stats: {
        billsScanned: 2,
        matched: 1,
        unmatched: 1,
        ambiguous: 2,
        fuzzy: 3,
        conflicts: 4,
        logFile: 'bill_match.log',
      },
    });

    const service = createMonthlyReconciliationService({
      db,
      dailyReceiptRepo,
      storeBillRepo,
      billMatchLogRepo,
      pendingReviewRepo,
      monthlyDataRepo,
      stageJobRepo,
    });

    const result = service.build({ workspaceKey, detailLimit: 5 });

    const storeMetric = result.metrics.find((item) => item.id === 'storeBills');
    assert.equal(storeMetric.value, 2);
    assert.equal(storeMetric.calculation.sourceTable, '店铺账单明细');
    assert.match(storeMetric.calculation.rule, /导入的店铺账单/);

    const billClosure = result.formulas.find((item) => item.id === 'billClosure');
    assert.equal(billClosure.left.value, 2);
    assert.equal(billClosure.balanced, true);
    assert.equal(billClosure.parts.find((item) => item.id === 'matchedMonthly').value, 1);
    assert.equal(billClosure.parts.find((item) => item.id === 'unreceivedMonthly').value, 1);

    const ledgerClosure = result.formulas.find((item) => item.id === 'ledgerClosure');
    assert.equal(ledgerClosure.left.value, 2);
    assert.equal(ledgerClosure.balanced, true);
    assert.equal(ledgerClosure.parts.find((item) => item.id === 'postedLedger').value, 1);
    assert.equal(ledgerClosure.parts.find((item) => item.id === 'readyLedger').value, 1);

    const matchedDetail = result.detailSections.monthlyMatched.rows[0];
    assert.equal(matchedDetail.receiptNo, '0326155300069');
    assert.equal(matchedDetail.trace.dailySource.file, '审核台导入.xlsx');
    assert.equal(matchedDetail.trace.dailySource.sheet, '收票');
    assert.equal(matchedDetail.trace.dailySource.row, 12);
    assert.equal(matchedDetail.trace.billSource.file, '店铺账单.xlsx');
    assert.equal(matchedDetail.trace.billSource.row, 20);
    assert.equal(matchedDetail.trace.matchRule, '小票号=0326155300069');

    const snapshot = result.operationSnapshots.find((item) => item.stage === 'bill_match');
    assert.equal(snapshot.stageLabel, '账单匹配');
    assert.equal(snapshot.operator, 'finance-a');
    assert.equal(snapshot.outputs.find((item) => item.label === '匹配成功').value, 1);
    assert.deepEqual(snapshot.reasonBreakdown, [
      { label: '台账里没有对应小票', value: 1 },
      { label: '多个候选，需要人工确认', value: 2 },
      { label: '疑似候选，需要人工确认', value: 3 },
      { label: '字段冲突，需要人工确认', value: 4 },
    ]);
  });
});
