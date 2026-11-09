'use strict';

/**
 * Verifies that tour_match_service and bill_match_service write match_badcase
 * rows with the expected stage/kind/snapshot when matchBadcaseRepo is wired.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openMonthlyDatabase } = require('../lib/storage/monthly_database');
const { createGroupCodeRepository } = require('../repositories/group_code_repository');
const { createStoreBillRepository } = require('../repositories/store_bill_repository');
const { createDailyReceiptRepository } = require('../repositories/daily_receipt_repository');
const { createBillMatchLogRepository } = require('../repositories/bill_match_log_repository');
const { createPendingReviewRepository } = require('../repositories/pending_review_repository');
const { createMatchBadcaseRepository } = require('../repositories/match_badcase_repository');
const { createTourMatchService } = require('../services/monthly/tour_match_service');
const { createBillMatchService } = require('../services/monthly/bill_match_service');

const WS = '2026-01';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'match-badcase-int-'));
  const db = openMonthlyDatabase({ dbPath: path.join(dir, 'monthly.sqlite') });
  const groupCodeRepo = createGroupCodeRepository({ db });
  const storeBillRepo = createStoreBillRepository({ db });
  const dailyReceiptRepo = createDailyReceiptRepository({ db });
  const billMatchLogRepo = createBillMatchLogRepository({ db });
  const pendingReviewRepo = createPendingReviewRepository({ db });
  const matchBadcaseRepo = createMatchBadcaseRepository({ db });
  t.after(() => {
    try { db.close?.(); } catch {
      // intentional: best-effort cleanup
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {
      // intentional: best-effort cleanup
    }
  });
  return {
    db, groupCodeRepo, storeBillRepo, dailyReceiptRepo,
    billMatchLogRepo, pendingReviewRepo, matchBadcaseRepo,
  };
}

test('tour_match: tour_not_found writes badcase with snapshot', async (t) => {
  const s = setup(t);
  s.dailyReceiptRepo.insertMany([{
    workspaceKey: WS, receiptNo: 'R-X', tourNo: 'X999',
    name: 'A', passportNo: 'P1', shop: 'lotte',
    purchaseDate: '2026-01-14',
    rowHash: 'd1', importedAt: 't',
  }]);

  const svc = createTourMatchService({
    dailyReceiptRepo: s.dailyReceiptRepo,
    groupCodeRepo: s.groupCodeRepo,
    pendingReviewRepo: s.pendingReviewRepo,
    matchBadcaseRepo: s.matchBadcaseRepo,
  });
  const result = await svc.run({ workspaceKey: WS, stageJobId: 42 });
  assert.equal(result.tourNotFound, 1);
  assert.ok(result.ruleVersion);

  const rows = s.matchBadcaseRepo.list({ workspaceKey: WS, stage: 'tour_match' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'tour_not_found');
  assert.equal(rows[0].tourNo, 'X999');
  assert.equal(rows[0].ruleVersion, result.ruleVersion);
  assert.equal(rows[0].stageJobId, 42);
  assert.equal(rows[0].snapshot.decision, 'tour_not_found');
});

test('bill_match: unmatched bill writes badcase with snapshot', async (t) => {
  const s = setup(t);
  s.storeBillRepo.insertMany([{
    workspaceKey: WS, storeFamily: '乐天', receiptNo: 'R-NONE',
    tourNo: 'T1', name: 'B', passportNo: 'P2',
    purchaseDate: '2026-01-15',
    isDetailSheet: true,
    rowHash: 'b1', importedAt: 't',
  }]);
  // No daily rows → bill is unmatched

  const svc = createBillMatchService({
    storeBillRepo: s.storeBillRepo,
    dailyReceiptRepo: s.dailyReceiptRepo,
    billMatchLogRepo: s.billMatchLogRepo,
    pendingReviewRepo: s.pendingReviewRepo,
    matchBadcaseRepo: s.matchBadcaseRepo,
  });
  const result = await svc.run({ workspaceKey: WS, stageJobId: 7 });
  assert.equal(result.unmatched, 1);

  const rows = s.matchBadcaseRepo.list({ workspaceKey: WS, stage: 'bill_match' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'unmatched');
  assert.equal(rows[0].receiptNo, 'R-NONE');
  assert.equal(rows[0].snapshot.decision, 'unmatched');
  assert.equal(rows[0].stageJobId, 7);
});

test('bill_match: ambiguous P1 match writes badcase with candidates', async (t) => {
  const s = setup(t);
  s.dailyReceiptRepo.insertMany([
    {
      workspaceKey: WS, receiptNo: 'R100', tourNo: 'T1',
      name: 'A', passportNo: 'P1', shop: 'lotte',
      purchaseDate: '2026-01-14',
      rowHash: 'd-a', importedAt: 't',
      ledgerStatus: 'posted', tourMatchStatus: 'matched',
    },
    {
      workspaceKey: WS, receiptNo: 'R100', tourNo: 'T1',
      name: 'B', passportNo: 'P2', shop: 'lotte',
      purchaseDate: '2026-01-14',
      rowHash: 'd-b', importedAt: 't',
      ledgerStatus: 'posted', tourMatchStatus: 'matched',
    },
  ]);
  s.storeBillRepo.insertMany([{
    workspaceKey: WS, storeFamily: 'lotte', receiptNo: 'R100',
    tourNo: 'T1', name: 'A', passportNo: 'P1',
    purchaseDate: '2026-01-14',
    isDetailSheet: true,
    rowHash: 'b-a', importedAt: 't',
  }]);

  const svc = createBillMatchService({
    storeBillRepo: s.storeBillRepo,
    dailyReceiptRepo: s.dailyReceiptRepo,
    billMatchLogRepo: s.billMatchLogRepo,
    pendingReviewRepo: s.pendingReviewRepo,
    matchBadcaseRepo: s.matchBadcaseRepo,
  });
  const result = await svc.run({ workspaceKey: WS });
  assert.equal(result.ambiguous, 1);

  const rows = s.matchBadcaseRepo.list({ workspaceKey: WS, kind: 'ambiguous_match' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].snapshot.decision, 'ambiguous');
  assert.ok(rows[0].snapshot.candidates.length >= 2);
});
