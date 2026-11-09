'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openMonthlyDatabase } = require('../lib/storage/monthly_database');
const { createStoreBillRepository } = require('../repositories/store_bill_repository');
const { createDailyReceiptRepository } = require('../repositories/daily_receipt_repository');
const { createBillMatchLogRepository } = require('../repositories/bill_match_log_repository');
const { createPendingReviewRepository } = require('../repositories/pending_review_repository');
const { createMatchBadcaseRepository } = require('../repositories/match_badcase_repository');
const { createBillMatchService } = require('../services/monthly/bill_match_service');

const WORKSPACE_KEY = '2026-05';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bill-match-tx-'));
  const db = openMonthlyDatabase({ dbPath: path.join(dir, 'monthly.sqlite') });
  const storeBillRepo = createStoreBillRepository({ db });
  const dailyReceiptRepo = createDailyReceiptRepository({ db });
  const billMatchLogRepo = createBillMatchLogRepository({ db });
  const pendingReviewRepo = createPendingReviewRepository({ db });
  const matchBadcaseRepo = createMatchBadcaseRepository({ db });

  seedMatchedPair({ storeBillRepo, dailyReceiptRepo });

  t.after(() => {
    try { db.close?.(); } catch {
      // intentional: best-effort cleanup
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {
      // intentional: best-effort cleanup
    }
  });

  return {
    db,
    storeBillRepo,
    dailyReceiptRepo,
    billMatchLogRepo,
    pendingReviewRepo,
    matchBadcaseRepo,
  };
}

function seedMatchedPair({ storeBillRepo, dailyReceiptRepo }) {
  const importedAt = '2026-05-20T00:00:00.000Z';
  dailyReceiptRepo.insertMany([{
    workspaceKey: WORKSPACE_KEY,
    receiptNo: '0326155300069',
    shop: 'THE SHILLA',
    purchaseDate: '2026-01-15',
    name: 'ZHENG ANBANG',
    passportNo: 'EF3892854',
    rowHash: 'daily-row-1',
    importedAt,
    sourceType: 'imported',
    ledgerStatus: 'posted',
    tourMatchStatus: 'matched',
  }]);
  storeBillRepo.insertMany([{
    workspaceKey: WORKSPACE_KEY,
    storeFamily: 'THE SHILLA',
    receiptNo: '0326155300069',
    purchaseDate: '2026-01-15',
    name: 'ZHENG ANBANG',
    passportNo: 'EF3892854',
    rowHash: 'bill-row-1',
    importedAt,
    isDetailSheet: true,
  }]);
}

test('bill_match write phase rolls back logs and status when a later write fails', async (t) => {
  const {
    db,
    storeBillRepo,
    dailyReceiptRepo,
    billMatchLogRepo,
    pendingReviewRepo,
    matchBadcaseRepo,
  } = setup(t);

  const failingBillMatchLogRepo = {
    ...billMatchLogRepo,
    insertMany(rows) {
      const result = billMatchLogRepo.insertMany(rows);
      throw Object.assign(new Error('log write failed after partial insert'), { result });
    },
  };

  const service = createBillMatchService({
    db,
    storeBillRepo,
    dailyReceiptRepo,
    billMatchLogRepo: failingBillMatchLogRepo,
    pendingReviewRepo,
    matchBadcaseRepo,
  });

  await assert.rejects(
    () => service.run({ workspaceKey: WORKSPACE_KEY }),
    /log write failed after partial insert/
  );

  assert.equal(billMatchLogRepo.countByWorkspace(WORKSPACE_KEY), 0);
  assert.equal(pendingReviewRepo.countOpen(WORKSPACE_KEY), 0);
  const row = db.prepare(
    `SELECT bill_match_status AS status, bill_match_priority AS priority
     FROM daily_receipt_export
     WHERE workspace_key = ? AND receipt_no = ?`
  ).get(WORKSPACE_KEY, '0326155300069');
  assert.equal(row.status, 'unmatched');
  assert.equal(row.priority, null);
});

test('bill_match rethrows _applyBillMatchBatch failures without leaving review rows', async (t) => {
  const {
    storeBillRepo,
    dailyReceiptRepo,
    billMatchLogRepo,
    pendingReviewRepo,
    matchBadcaseRepo,
  } = setup(t);

  const throwingDailyReceiptRepo = {
    ...dailyReceiptRepo,
    _listAll: dailyReceiptRepo._listAll,
    _applyBillMatchBatch() {
      throw new Error('daily batch update failed');
    },
  };

  const service = createBillMatchService({
    storeBillRepo,
    dailyReceiptRepo: throwingDailyReceiptRepo,
    billMatchLogRepo,
    pendingReviewRepo,
    matchBadcaseRepo,
  });

  await assert.rejects(
    () => service.run({ workspaceKey: WORKSPACE_KEY }),
    /daily batch update failed/
  );
  assert.equal(billMatchLogRepo.countByWorkspace(WORKSPACE_KEY), 0);
  assert.equal(pendingReviewRepo.countOpen(WORKSPACE_KEY), 0);
});
