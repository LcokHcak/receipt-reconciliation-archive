'use strict';

/**
 * Unit tests for pending_review_resolution_service — exercises every
 * reason_type dispatch path and verifies:
 *   - daily_receipt_export gets the right field updates
 *   - bill_match_log gains a matched row (when the reason type needs one)
 *   - monthly_data is rebuilt precisely for the affected daily row
 *   - pending_review row flips to resolved/rejected
 */

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
const { createMonthlyDataRepository } = require('../repositories/monthly_data_repository');
const {
  createPendingReviewResolutionService,
} = require('../services/monthly/pending_review_resolution_service');

const WS = '2026-01';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-resolve-'));
  const db = openMonthlyDatabase({ dbPath: path.join(dir, 'monthly.sqlite') });
  const storeBillRepo = createStoreBillRepository({ db });
  const dailyReceiptRepo = createDailyReceiptRepository({ db });
  const billMatchLogRepo = createBillMatchLogRepository({ db });
  const pendingReviewRepo = createPendingReviewRepository({ db });
  const monthlyDataRepo = createMonthlyDataRepository({ db });
  const service = createPendingReviewResolutionService({
    dailyReceiptRepo, storeBillRepo, billMatchLogRepo,
    pendingReviewRepo, monthlyDataRepo,
  });
  t.after(() => {
    try { db.close?.(); } catch {
      // intentional: best-effort cleanup
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {
      // intentional: best-effort cleanup
    }
  });
  return {
    dir, db,
    storeBillRepo, dailyReceiptRepo, billMatchLogRepo,
    pendingReviewRepo, monthlyDataRepo, service,
  };
}

function seedDaily(repo, extras = {}) {
  repo.insertMany([{
    workspaceKey: WS,
    receiptNo: 'R100',
    tourNo: 'T1',
    name: 'LI MING',
    passportNo: 'P1',
    shop: '乐天免税店',
    purchaseDate: '2026-01-14',
    modeFolder: '乐天首尔',
    tourMatchStatus: 'matched',
    rowHash: 'd100',
    importedAt: 't',
    ...extras,
  }]);
  return repo._listAll({ workspaceKey: WS }).find((r) => r.receiptNo === 'R100');
}

function seedBill(repo, extras = {}) {
  repo.insertMany([{
    workspaceKey: WS,
    storeFamily: '乐天免税店',
    receiptNo: 'R100',
    tourNo: 'T1',
    name: 'LI MING',
    passportNo: 'P1',
    purchaseDate: '2026-01-14',
    isDetailSheet: true,
    rowHash: 'b100',
    importedAt: 't',
    ...extras,
  }]);
  return repo.findByReceipt({ workspaceKey: WS, receiptNo: 'R100' })[0];
}

test('field_conflict: applies use_bill override + writes matched log + rebuilds monthly_data', async (t) => {
  const s = setup(t);
  const bill = seedBill(s.storeBillRepo, { tourNo: 'T-BILL-7' });
  const daily = seedDaily(s.dailyReceiptRepo, { tourNo: 'T-DAILY-9' });

  s.pendingReviewRepo.insertMany([{
    workspaceKey: WS,
    sourceTable: 'store_bill',
    sourceId: bill.id,
    reasonType: 'field_conflict',
    detail: {
      priority: 1,
      matchKey: `receipt_no=${bill.receiptNo}`,
      dailyReceiptId: daily.id,
      conflicts: [{ field: 'tourNo', dailyValue: 'T-DAILY-9', billValue: 'T-BILL-7' }],
      autoFillable: [],
    },
    status: 'open',
    createdAt: 't',
  }]);
  const pending = s.pendingReviewRepo.list({ workspaceKey: WS, status: 'open' })[0];

  const result = await s.service.resolve({
    id: pending.id, workspaceKey: WS,
    status: 'resolved',
    resolvedBy: 'tester',
    decision: { fieldOverrides: { tourNo: 'use_bill' } },
  });
  assert.equal(result.ok, true, JSON.stringify(result));

  const after = s.dailyReceiptRepo._fetchFullById({ workspaceKey: WS, id: daily.id });
  assert.equal(after.tourNo, 'T-BILL-7');
  assert.equal(after.billMatchStatus, 'matched');

  const logs = s.billMatchLogRepo.findByDaily({ workspaceKey: WS, dailyReceiptId: daily.id });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].matchStatus, 'matched');
  assert.equal(logs[0].storeBillId, bill.id);

  const mdRow = s.monthlyDataRepo.findByDaily({ workspaceKey: WS, dailyReceiptId: daily.id });
  assert.ok(mdRow, 'monthly_data row should exist');
  assert.equal(mdRow.is_unmatched, 0);
  assert.equal(mdRow.tour_no, 'T-BILL-7');
  assert.equal(mdRow.store_bill_id, bill.id);

  const reread = s.pendingReviewRepo.findById({ id: pending.id, workspaceKey: WS });
  assert.equal(reread.status, 'resolved');
});

// 审计H3回归:handler 早退(缺 daily 等)不得把 pending_review 标 resolved(幽灵成功=永久丢票)
test('phantom-success 防护:handler 找不到 daily 时保持 open、绝不标 resolved', async (t) => {
  const s = setup(t);
  const bill = seedBill(s.storeBillRepo);
  s.pendingReviewRepo.insertMany([{
    workspaceKey: WS,
    sourceTable: 'store_bill',
    sourceId: bill.id,
    reasonType: 'field_conflict',
    detail: {
      priority: 1,
      matchKey: `receipt_no=${bill.receiptNo}`,
      dailyReceiptId: 999999, // 提出与解决之间 daily 行被删/reset → 找不到
      conflicts: [{ field: 'tourNo', dailyValue: 'x', billValue: 'y' }],
      autoFillable: [],
    },
    status: 'open',
    createdAt: 't',
  }]);
  const pending = s.pendingReviewRepo.list({ workspaceKey: WS, status: 'open' })[0];

  const result = await s.service.resolve({
    id: pending.id, workspaceKey: WS,
    status: 'resolved',
    resolvedBy: 'tester',
    decision: { fieldOverrides: { tourNo: 'use_bill' } },
  });

  assert.equal(result.ok, false, '未写回必须 ok:false');
  assert.equal(result.resolved, false, '未写回绝不能标 resolved');
  assert.ok(result.warnings.includes('daily_not_found'));
  const reread = s.pendingReviewRepo.findById({ id: pending.id, workspaceKey: WS });
  assert.equal(reread.status, 'open', 'item 必须保持 open 供重试,绝不能幽灵消失');
});

// 复核HIGH-3:daily 存在但 modeFolder 为空 → monthly_data 重建不了。此前:先删月度旧行再发现
// 重建不了(旧行永久消失)+状态只进 applied 照样标 resolved(幽灵成功旁路)。现在:不删+保 open。
test('rebuild 未成(no_folder):月度旧行不删、item 保持 open、绝不标 resolved', async (t) => {
  const s = setup(t);
  const bill = seedBill(s.storeBillRepo);
  // daily 存在但 modeFolder 为空(还没归类落桶——field_conflict 场景完全可能)
  s.dailyReceiptRepo.insertMany([{
    workspaceKey: WS, receiptNo: 'R100', tourNo: 'T1', name: 'LI MING', passportNo: 'P1',
    shop: '乐天免税店', purchaseDate: '2026-01-14', modeFolder: null,
    tourMatchStatus: 'pending', rowHash: 'd-nofolder', importedAt: 't',
  }]);
  const daily = s.dailyReceiptRepo._listAll({ workspaceKey: WS }).find((r) => r.rowHash === 'd-nofolder');
  // 预置一条月度行(它是"删了没补"事故里会消失的那条)
  s.monthlyDataRepo.insertMany([{
    workspaceKey: WS, modeFolder: '旧桶', isUnmatched: 1,
    dailyReceiptId: daily.id, storeBillId: null,
    createdAt: 't', updatedAt: 't', rowHash: 'md-old',
    receiptNo: 'R100', name: 'LI MING',
  }]);
  assert.ok(s.monthlyDataRepo.findByDaily({ workspaceKey: WS, dailyReceiptId: daily.id }), '月度行预置成功');

  s.pendingReviewRepo.insertMany([{
    workspaceKey: WS, sourceTable: 'store_bill', sourceId: bill.id,
    reasonType: 'field_conflict',
    detail: {
      priority: 1, matchKey: `receipt_no=${bill.receiptNo}`, dailyReceiptId: daily.id,
      conflicts: [{ field: 'tourNo', dailyValue: 'T1', billValue: 'T-BILL' }], autoFillable: [],
    },
    status: 'open', createdAt: 't',
  }]);
  const pending = s.pendingReviewRepo.list({ workspaceKey: WS, status: 'open' })[0];

  const result = await s.service.resolve({
    id: pending.id, workspaceKey: WS, status: 'resolved', resolvedBy: 'tester',
    decision: { fieldOverrides: { tourNo: 'use_bill' } },
  });

  assert.equal(result.ok, false, '未完整落地必须 ok:false');
  assert.ok(result.warnings.some((w) => w.includes('monthly_data_not_rebuilt')), '未重建必须进 warnings');
  const reread = s.pendingReviewRepo.findById({ id: pending.id, workspaceKey: WS });
  assert.equal(reread.status, 'open', 'item 必须保持 open(幽灵成功旁路已堵)');
  assert.ok(
    s.monthlyDataRepo.findByDaily({ workspaceKey: WS, dailyReceiptId: daily.id }),
    '重建不了就不许删——月度旧行必须还在',
  );
});

test('ambiguous_match: chosen daily gets matched log + monthly_data', async (t) => {
  const s = setup(t);
  const bill = seedBill(s.storeBillRepo);
  const d1 = seedDaily(s.dailyReceiptRepo, { receiptNo: 'R100', rowHash: 'd-a' });
  s.dailyReceiptRepo.insertMany([{
    workspaceKey: WS, receiptNo: 'R100', tourNo: 'T1',
    name: 'LI MING', passportNo: 'P1', shop: '乐天免税店',
    purchaseDate: '2026-01-14',
    modeFolder: '乐天首尔', tourMatchStatus: 'matched',
    rowHash: 'd-b', importedAt: 't',
  }]);
  const d2 = s.dailyReceiptRepo._listAll({ workspaceKey: WS }).find((r) => r.rowHash === 'd-b');

  s.pendingReviewRepo.insertMany([{
    workspaceKey: WS,
    sourceTable: 'store_bill',
    sourceId: bill.id,
    reasonType: 'ambiguous_match',
    detail: { priority: 2, candidateIds: [d1.id, d2.id] },
    status: 'open', createdAt: 't',
  }]);
  const pending = s.pendingReviewRepo.list({ workspaceKey: WS, status: 'open' })[0];

  const result = await s.service.resolve({
    id: pending.id, workspaceKey: WS,
    status: 'resolved',
    resolvedBy: 'tester',
    decision: { chosenDailyId: d2.id },
  });
  assert.equal(result.ok, true, JSON.stringify(result));

  const after = s.dailyReceiptRepo._fetchFullById({ workspaceKey: WS, id: d2.id });
  assert.equal(after.billMatchStatus, 'matched');
  assert.equal(after.billMatchPriority, 2);

  const logs = s.billMatchLogRepo.findByDaily({ workspaceKey: WS, dailyReceiptId: d2.id });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].matchStatus, 'matched');

  const mdRow = s.monthlyDataRepo.findByDaily({ workspaceKey: WS, dailyReceiptId: d2.id });
  assert.ok(mdRow);
  assert.equal(mdRow.is_unmatched, 0);
});

test('mode_unresolved: operator picks modeFolder + merge rebuilds row', async (t) => {
  const s = setup(t);
  const daily = seedDaily(s.dailyReceiptRepo, {
    modeFolder: null, tourMatchStatus: 'mode_unresolved',
  });

  s.pendingReviewRepo.insertMany([{
    workspaceKey: WS,
    sourceTable: 'daily_receipt_export',
    sourceId: daily.id,
    reasonType: 'mode_unresolved',
    detail: { tourNo: 'T1' },
    status: 'open', createdAt: 't',
  }]);
  const pending = s.pendingReviewRepo.list({ workspaceKey: WS, status: 'open' })[0];

  const result = await s.service.resolve({
    id: pending.id, workspaceKey: WS,
    status: 'resolved',
    resolvedBy: 'tester',
    decision: { modeFolder: '乐天釜山' },
  });
  assert.equal(result.ok, true, JSON.stringify(result));

  const after = s.dailyReceiptRepo._fetchFullById({ workspaceKey: WS, id: daily.id });
  assert.equal(after.modeFolder, '乐天釜山');
  assert.equal(after.tourMatchStatus, 'matched');

  const mdRow = s.monthlyDataRepo.findByDaily({ workspaceKey: WS, dailyReceiptId: daily.id });
  assert.ok(mdRow);
  assert.equal(mdRow.mode_folder, '乐天釜山');
  assert.equal(mdRow.is_unmatched, 1); // no bill matched yet
});

test('rejected resolution: only flips pending_review status, nothing else', async (t) => {
  const s = setup(t);
  const bill = seedBill(s.storeBillRepo);
  const daily = seedDaily(s.dailyReceiptRepo);

  s.pendingReviewRepo.insertMany([{
    workspaceKey: WS,
    sourceTable: 'store_bill',
    sourceId: bill.id,
    reasonType: 'fuzzy_match',
    detail: { candidateIds: [daily.id] },
    status: 'open', createdAt: 't',
  }]);
  const pending = s.pendingReviewRepo.list({ workspaceKey: WS, status: 'open' })[0];

  const result = await s.service.resolve({
    id: pending.id, workspaceKey: WS,
    status: 'rejected',
    resolvedBy: 'tester',
  });
  assert.equal(result.ok, true);

  const after = s.dailyReceiptRepo._fetchFullById({ workspaceKey: WS, id: daily.id });
  assert.notEqual(after.billMatchStatus, 'matched');
  const logs = s.billMatchLogRepo.findByDaily({ workspaceKey: WS, dailyReceiptId: daily.id });
  assert.equal(logs.length, 0);
  const mdRow = s.monthlyDataRepo.findByDaily({ workspaceKey: WS, dailyReceiptId: daily.id });
  assert.equal(mdRow, null);

  const reread = s.pendingReviewRepo.findById({ id: pending.id, workspaceKey: WS });
  assert.equal(reread.status, 'rejected');
});

test('already-resolved pending_review is a no-op', async (t) => {
  const s = setup(t);
  const bill = seedBill(s.storeBillRepo);
  const daily = seedDaily(s.dailyReceiptRepo);

  s.pendingReviewRepo.insertMany([{
    workspaceKey: WS,
    sourceTable: 'store_bill',
    sourceId: bill.id,
    reasonType: 'ambiguous_match',
    detail: { candidateIds: [daily.id] },
    status: 'open', createdAt: 't',
  }]);
  const pending = s.pendingReviewRepo.list({ workspaceKey: WS, status: 'open' })[0];

  await s.service.resolve({
    id: pending.id, workspaceKey: WS, status: 'resolved',
    decision: { chosenDailyId: daily.id },
  });
  const result2 = await s.service.resolve({
    id: pending.id, workspaceKey: WS, status: 'resolved',
    decision: { chosenDailyId: daily.id },
  });
  assert.equal(result2.ok, false);
  assert.ok(result2.warnings.some((w) => w.startsWith('already_')));
});
