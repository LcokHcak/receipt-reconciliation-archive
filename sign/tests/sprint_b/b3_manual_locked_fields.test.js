'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openMonthlyDatabase } = require('../../lib/storage/monthly_database');
const { createBillMatchLogRepository } = require('../../repositories/bill_match_log_repository');
const { createDailyReceiptRepository } = require('../../repositories/daily_receipt_repository');
const { createMonthlyDataRepository } = require('../../repositories/monthly_data_repository');
const { createPendingReviewRepository } = require('../../repositories/pending_review_repository');
const { createStoreBillRepository } = require('../../repositories/store_bill_repository');
const { createTourMatchService } = require('../../services/monthly/tour_match_service');
const { createBillMatchService } = require('../../services/monthly/bill_match_service');
const { createMergeService } = require('../../services/monthly/merge_service');
const { createPendingReviewResolutionService } = require('../../services/monthly/pending_review_resolution_service');

const WS = 'demo-2026-01';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b3-manual-lock-'));
  const db = openMonthlyDatabase({ dbPath: path.join(dir, 'monthly.sqlite') });
  const dailyReceiptRepo = createDailyReceiptRepository({ db });
  const storeBillRepo = createStoreBillRepository({ db });
  const billMatchLogRepo = createBillMatchLogRepository({ db });
  const pendingReviewRepo = createPendingReviewRepository({ db });
  const monthlyDataRepo = createMonthlyDataRepository({ db });
  const groupCodeRepo = makeGroupCodeRepo();
  const tourMatchService = createTourMatchService({
    dailyReceiptRepo,
    groupCodeRepo,
    pendingReviewRepo,
  });
  const billMatchService = createBillMatchService({
    db,
    storeBillRepo,
    dailyReceiptRepo,
    billMatchLogRepo,
    pendingReviewRepo,
  });
  const mergeService = createMergeService({
    dailyReceiptRepo,
    billMatchLogRepo,
    monthlyDataRepo,
    storeBillRepo,
  });
  const resolutionService = createPendingReviewResolutionService({
    dailyReceiptRepo,
    storeBillRepo,
    billMatchLogRepo,
    pendingReviewRepo,
    monthlyDataRepo,
  });
  t.after(() => {
    try { db.close?.(); } catch {
      // intentional: best-effort cleanup
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    db,
    dailyReceiptRepo,
    storeBillRepo,
    pendingReviewRepo,
    billMatchLogRepo,
    monthlyDataRepo,
    tourMatchService,
    billMatchService,
    mergeService,
    resolutionService,
  };
}

test('B3 t1-t3: manual field edits add stable non-duplicated locks', (t) => {
  const ctx = setup(t);
  const row = insertDaily(ctx, { modeFolder: 'OLD', tourNo: 'T001' });

  let result = ctx.dailyReceiptRepo.applyFieldUpdates({
    id: row.id, workspaceKey: WS, manualLock: true, updates: { modeFolder: 'MANUAL' },
  });
  assert.equal(result.changes, 1);
  assert.equal(fetch(ctx, row.id).manualLockedFields, '["mode_folder"]');

  result = ctx.dailyReceiptRepo.applyFieldUpdates({
    id: row.id, workspaceKey: WS, manualLock: true, updates: { tourNo: 'T999' },
  });
  assert.equal(result.changes, 1);
  assert.equal(fetch(ctx, row.id).manualLockedFields, '["mode_folder","tour_no"]');

  ctx.dailyReceiptRepo.applyFieldUpdates({
    id: row.id, workspaceKey: WS, manualLock: true, updates: { modeFolder: 'MANUAL2' },
  });
  assert.equal(fetch(ctx, row.id).manualLockedFields, '["mode_folder","tour_no"]');
});

test('B3 t4-t6: tour_match skips locked fields and aggregates stats', async (t) => {
  const ctx = setup(t);
  const row = insertDaily(ctx, { modeFolder: 'MANUAL', modeRaw: 'manual', tourMatchStatus: 'pending' });
  ctx.dailyReceiptRepo.applyFieldUpdates({
    id: row.id, workspaceKey: WS, manualLock: true, updates: { modeFolder: 'MANUAL' },
  });

  const firstRun = await ctx.tourMatchService.run({ workspaceKey: WS });
  const afterFirst = fetch(ctx, row.id);
  assert.equal(afterFirst.modeFolder, 'MANUAL');
  assert.equal(afterFirst.tourNo, 'T001');
  assert.equal(firstRun.skipped_due_to_manual_lock.rows_affected, 1);
  assert.equal(firstRun.skipped_due_to_manual_lock.fields.mode_folder, 1);

  ctx.dailyReceiptRepo.applyFieldUpdates({
    id: row.id, workspaceKey: WS, updates: { tourNo: 'T002', tourMatchStatus: 'pending' },
  });
  const secondRun = await ctx.tourMatchService.run({ workspaceKey: WS });
  const afterSecond = fetch(ctx, row.id);
  assert.equal(afterSecond.tourNo, 'T002');
  assert.equal(afterSecond.modeFolder, 'MANUAL');
  assert.equal(secondRun.skipped_due_to_manual_lock.fields.mode_folder, 1);

  for (let i = 0; i < 5; i += 1) {
    const extra = insertDaily(ctx, { rowHash: `daily-extra-${i}`, modeFolder: 'LOCKED', modeRaw: null });
    ctx.dailyReceiptRepo.applyFieldUpdates({
      id: extra.id, workspaceKey: WS, manualLock: true, updates: { modeFolder: 'LOCKED' },
    });
  }
  const thirdRun = await ctx.tourMatchService.run({ workspaceKey: WS });
  assert.equal(thirdRun.skipped_due_to_manual_lock.rows_affected, 5);
  assert.equal(thirdRun.skipped_due_to_manual_lock.fields.mode_folder, 5);
});

test('B3 t7: bill_match skips locked bill_match_status', async (t) => {
  const ctx = setup(t);
  // 账单匹配候选前提:台账行需已过团号匹配(matched)
  const row = insertDaily(ctx, { billMatchStatus: 'manual', tourMatchStatus: 'matched' });
  insertBill(ctx);
  ctx.dailyReceiptRepo.applyFieldUpdates({
    id: row.id, workspaceKey: WS, manualLock: true, updates: { billMatchStatus: 'manual' },
  });

  const result = await ctx.billMatchService.run({ workspaceKey: WS });

  assert.equal(fetch(ctx, row.id).billMatchStatus, 'manual');
  assert.equal(result.skipped_due_to_manual_lock.rows_affected, 1);
  assert.equal(result.skipped_due_to_manual_lock.fields.bill_match_status, 1);
});

test('B3 t8: merge does not mutate daily manual locks', async (t) => {
  const ctx = setup(t);
  const row = insertDaily(ctx, { modeFolder: 'MANUAL', ledgerStatus: 'posted' });
  ctx.dailyReceiptRepo.applyFieldUpdates({
    id: row.id, workspaceKey: WS, manualLock: true, updates: { modeFolder: 'MANUAL' },
  });

  await ctx.mergeService.run({ workspaceKey: WS });

  assert.equal(fetch(ctx, row.id).manualLockedFields, '["mode_folder"]');
});

test('B3 t9-t10: system and import writes do not create manual locks', async (t) => {
  const ctx = setup(t);
  const row = insertDaily(ctx);

  await ctx.tourMatchService.run({ workspaceKey: WS });

  assert.equal(fetch(ctx, row.id).manualLockedFields, null);
  const imported = insertDaily(ctx, { rowHash: 'imported', sourceType: 'imported' });
  assert.equal(fetch(ctx, imported.id).manualLockedFields, null);
});

test('B3 t11: manual lock JSON serialization is stable', (t) => {
  const ctx = setup(t);
  const a = insertDaily(ctx, { rowHash: 'stable-a' });
  const b = insertDaily(ctx, { rowHash: 'stable-b' });

  ctx.dailyReceiptRepo.applyFieldUpdates({
    id: a.id, workspaceKey: WS, manualLock: true, updates: { tourNo: 'T002', modeFolder: 'A' },
  });
  ctx.dailyReceiptRepo.applyFieldUpdates({
    id: b.id, workspaceKey: WS, manualLock: true, updates: { modeFolder: 'A', tourNo: 'T002' },
  });

  assert.equal(fetch(ctx, a.id).manualLockedFields, fetch(ctx, b.id).manualLockedFields);
});

test('B3 t12: lockPosted is not blocked by manual field locks', (t) => {
  const ctx = setup(t);
  const row = insertDaily(ctx, { modeFolder: 'MANUAL', ledgerStatus: 'posted' });
  ctx.dailyReceiptRepo.applyFieldUpdates({
    id: row.id, workspaceKey: WS, manualLock: true, updates: { modeFolder: 'MANUAL' },
  });

  const changes = ctx.dailyReceiptRepo.lockPosted({ workspaceKey: WS, lockedBy: 'admin' });

  const locked = fetch(ctx, row.id);
  assert.equal(changes, 1);
  assert.equal(locked.ledgerStatus, 'locked');
  assert.equal(locked.modeFolder, 'MANUAL');
  assert.equal(locked.manualLockedFields, '["mode_folder"]');
});

test('B3 t13: pending resolution writes are manual locks for changed fields only', async (t) => {
  const ctx = setup(t);
  const daily = insertDaily(ctx, { receiptNo: 'R100' });
  const bill = insertBill(ctx, { receiptNo: 'R200' });
  ctx.pendingReviewRepo.insertMany([{
    workspaceKey: WS,
    sourceTable: 'store_bill',
    sourceId: bill.id,
    reasonType: 'field_conflict',
    detail: {
      priority: 1,
      matchKey: 'R100',
      dailyReceiptId: daily.id,
      conflicts: [{ field: 'receiptNo', dailyValue: 'R100', billValue: 'R200' }],
    },
    status: 'open',
    createdAt: '2026-01-01T00:00:00.000Z',
  }]);
  const pending = ctx.pendingReviewRepo.list({ workspaceKey: WS, limit: 10 })[0];

  await ctx.resolutionService.resolve({
    id: pending.id,
    workspaceKey: WS,
    status: 'resolved',
    resolvedBy: 'tester',
    decision: { fieldOverrides: { receiptNo: 'use_bill' } },
  });

  const row = fetch(ctx, daily.id);
  assert.equal(row.receiptNo, 'R200');
  assert.equal(row.manualLockedFields, '["bill_match_priority","bill_match_status","receipt_no"]');
});

function makeGroupCodeRepo() {
  return {
    findByTour({ tourNo }) {
      return [{
        tour_no: tourNo,
        agent: 'AGENT',
        mode: '乐天SG-땡新',
        apply_date: '2026-01-01',
        end_date: '2026-01-31',
      }];
    },
  };
}

function insertDaily(ctx, overrides = {}) {
  const row = {
    workspaceKey: WS,
    receiptNo: 'R100',
    tourNo: 'T001',
    agent: 'AGENT',
    name: 'DAILY NAME',
    passportNo: 'P1234567',
    shop: 'THE SHILLA',
    purchaseDate: '2026-01-10',
    departureDate: '2026-01-12',
    billMatchStatus: 'unmatched',
    tourMatchStatus: 'pending',
    ledgerStatus: 'posted',
    rowHash: `daily-${Date.now()}-${Math.random()}`,
    importedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
  ctx.dailyReceiptRepo.insertMany([row]);
  return ctx.dailyReceiptRepo._listAll({ workspaceKey: WS }).find((r) => r.rowHash === row.rowHash);
}

function insertBill(ctx, overrides = {}) {
  const row = {
    workspaceKey: WS,
    storeFamily: 'THE SHILLA',
    receiptNo: 'R100',
    tourNo: 'T001',
    name: 'DAILY NAME',
    passportNo: 'P1234567',
    purchaseDate: '2026-01-10',
    departureDate: '2026-01-12',
    isDetailSheet: true,
    rowHash: `bill-${Date.now()}-${Math.random()}`,
    importedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
  ctx.storeBillRepo.insertMany([row]);
  return ctx.storeBillRepo.iterateDetail(WS).find((r) => r.rowHash === row.rowHash);
}

function fetch(ctx, id) {
  return ctx.dailyReceiptRepo._fetchFullById({ workspaceKey: WS, id });
}
