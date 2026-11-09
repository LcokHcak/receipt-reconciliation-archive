'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openMonthlyDatabase } = require('../../lib/storage/monthly_database');
const { createBillMatchLogRepository } = require('../../repositories/bill_match_log_repository');
const { createDailyReceiptRepository } = require('../../repositories/daily_receipt_repository');
const { createPendingReviewRepository } = require('../../repositories/pending_review_repository');
const { createStoreBillRepository } = require('../../repositories/store_bill_repository');
const { createBillMatchService } = require('../../services/monthly/bill_match_service');

const WS = 'demo-2026-05';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g15-conflict-fields-'));
  const db = openMonthlyDatabase({ dbPath: path.join(dir, 'monthly.sqlite') });
  const storeBillRepo = createStoreBillRepository({ db });
  const dailyReceiptRepo = createDailyReceiptRepository({ db });
  const billMatchLogRepo = createBillMatchLogRepository({ db });
  const pendingReviewRepo = createPendingReviewRepository({ db });
  const billMatchService = createBillMatchService({
    db,
    storeBillRepo,
    dailyReceiptRepo,
    billMatchLogRepo,
    pendingReviewRepo,
  });
  t.after(() => {
    try { db.close?.(); } catch {
      // best effort
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db, storeBillRepo, dailyReceiptRepo, billMatchService };
}

test('G15 v2: bill_match writes conflict field names onto matched daily rows', async (t) => {
  const ctx = setup(t);
  ctx.dailyReceiptRepo.insertMany([dailyRow()]);
  ctx.storeBillRepo.insertMany([billRow()]);

  await ctx.billMatchService.run({ workspaceKey: WS });

  const daily = ctx.dailyReceiptRepo._listAll({ workspaceKey: WS })[0];
  assert.equal(daily.billMatchStatus, 'pending_review');
  assert.deepEqual(daily.conflictFields, ['name', 'netKrw']);
});

test('G15 v2: successful rerun clears stale conflict fields from a daily row', async (t) => {
  const ctx = setup(t);
  ctx.dailyReceiptRepo.insertMany([dailyRow()]);
  ctx.storeBillRepo.insertMany([billRow()]);

  await ctx.billMatchService.run({ workspaceKey: WS });
  ctx.storeBillRepo.insertMany([{ ...billRow(), name: 'DAILY NAME', netKrw: 124300, rowHash: 'bill-ok' }]);
  ctx.db.prepare("UPDATE store_bill SET transaction_type = 'refund' WHERE row_hash = 'bill-conflict'").run();
  await ctx.billMatchService.run({ workspaceKey: WS });

  const daily = ctx.dailyReceiptRepo._listAll({ workspaceKey: WS })[0];
  assert.equal(daily.billMatchStatus, 'matched');
  assert.equal(daily.conflictFields, null);
});

function dailyRow() {
  return {
    workspaceKey: WS,
    receiptNo: 'R-G15-1',
    tourNo: 'T001',
    name: 'DAILY NAME',
    passportNo: 'P1234567',
    shop: 'LOTTE',
    purchaseDate: '2026-05-10',
    departureDate: '2026-05-12',
    netKrw: 124300,
    rowHash: 'daily-conflict',
    importedAt: '2026-05-01T00:00:00.000Z',
    // 账单匹配候选前提:已过团号匹配(posted + matched)
    ledgerStatus: 'posted',
    tourMatchStatus: 'matched',
  };
}

function billRow() {
  return {
    workspaceKey: WS,
    storeFamily: 'LOTTE',
    receiptNo: 'R-G15-1',
    tourNo: 'T001',
    name: 'BILL NAME',
    passportNo: 'P1234567',
    purchaseDate: '2026-05-10',
    departureDate: '2026-05-12',
    netKrw: 124305,
    isDetailSheet: true,
    rowHash: 'bill-conflict',
    importedAt: '2026-05-01T00:00:00.000Z',
    transactionType: 'sale',
  };
}
