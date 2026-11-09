'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { runMigrations } = require('../../lib/storage/migration_runner');
const { createStoreBillRepository } = require('../../repositories/store_bill_repository');
const { createDailyReceiptRepository } = require('../../repositories/daily_receipt_repository');
const { createBillMatchLogRepository } = require('../../repositories/bill_match_log_repository');
const { createBillEnrichmentService } = require('../../services/monthly/bill_enrichment_service');

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
  const service = createBillEnrichmentService({ db, storeBillRepo, dailyReceiptRepo, billMatchLogRepo });
  return { db, storeBillRepo, dailyReceiptRepo, billMatchLogRepo, service };
}

let dseq = 0;
function insertDaily(db, { passportNo, name, receiptNo, tourNo = 'T001', departureDate = '2026-05-20' }) {
  dseq += 1;
  const info = db.prepare(`
    INSERT INTO daily_receipt_export
      (workspace_key, passport_no, name, receipt_no, tour_no, departure_date, row_hash, imported_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(WS, passportNo, name, receiptNo, tourNo, departureDate, `d${dseq}`, '2026-05-11T00:00:00.000Z');
  return Number(info.lastInsertRowid);
}

function bill(overrides) {
  return {
    workspaceKey: WS, storeFamily: '乐天首尔', receiptNo: 'R1',
    purchaseDate: '2026-05-10', isDetailSheet: true,
    rowHash: Math.random().toString(36).slice(2), importedAt: '2026-05-11T00:00:00.000Z',
    ...overrides,
  };
}

function rawBills(db, receiptNo) {
  return db.prepare(`SELECT passport_no, departure_date, tour_no, name, enriched_from_daily_id
    FROM store_bill WHERE workspace_key = ? AND receipt_no = ? ORDER BY id`).all(WS, receiptNo);
}

function markMatched(billMatchLogRepo, dailyId, billId) {
  billMatchLogRepo.insertMany([{
    workspaceKey: WS, dailyReceiptId: dailyId, storeBillId: billId,
    matchPriority: 1, matchKey: 'k', matchStatus: 'matched', matchedAt: '2026-05-11T00:00:00.000Z',
  }]);
}

test('占位符护照 HDC_PKG100 → 用台账真护照 EM1156758 覆盖', () => {
  const { db, storeBillRepo, billMatchLogRepo, service } = makeCtx();
  const dailyId = insertDaily(db, { passportNo: 'EM1156758', name: 'BAI', receiptNo: 'R1' });
  storeBillRepo.insertMany([bill({ passportNo: 'HDC_PKG100', receiptNo: 'R1' })]);
  const billId = storeBillRepo.findByReceipt({ workspaceKey: WS, receiptNo: 'R1' })[0].id;
  markMatched(billMatchLogRepo, dailyId, billId);

  const stats = service.run({ workspaceKey: WS });
  assert.ok(stats.placeholderOverrides >= 1);
  assert.equal(rawBills(db, 'R1')[0].passport_no, 'EM1156758');
});

test('空 departure_date → 用台账补', () => {
  const { db, storeBillRepo, billMatchLogRepo, service } = makeCtx();
  const dailyId = insertDaily(db, { passportNo: 'P1', name: 'A', receiptNo: 'R1', departureDate: '2026-05-25' });
  storeBillRepo.insertMany([bill({ passportNo: 'P1', receiptNo: 'R1', departureDate: null })]);
  const billId = storeBillRepo.findByReceipt({ workspaceKey: WS, receiptNo: 'R1' })[0].id;
  markMatched(billMatchLogRepo, dailyId, billId);

  service.run({ workspaceKey: WS });
  assert.equal(rawBills(db, 'R1')[0].departure_date, '2026-05-25');
});

test('已有真实护照值不被覆盖', () => {
  const { db, storeBillRepo, billMatchLogRepo, service } = makeCtx();
  const dailyId = insertDaily(db, { passportNo: 'EM1156758', name: 'A', receiptNo: 'R1' });
  storeBillRepo.insertMany([bill({ passportNo: 'EH1234567', receiptNo: 'R1' })]);
  const billId = storeBillRepo.findByReceipt({ workspaceKey: WS, receiptNo: 'R1' })[0].id;
  markMatched(billMatchLogRepo, dailyId, billId);

  service.run({ workspaceKey: WS });
  assert.equal(rawBills(db, 'R1')[0].passport_no, 'EH1234567', '真实值保持不动');
});

test('同一小票 5 商品行 → 5 行全部补齐', () => {
  const { db, storeBillRepo, billMatchLogRepo, service } = makeCtx();
  const dailyId = insertDaily(db, { passportNo: 'EM1156758', name: 'BAI', receiptNo: 'R1', departureDate: '2026-05-25' });
  const rows = [];
  for (let i = 0; i < 5; i += 1) {
    rows.push(bill({ passportNo: '', departureDate: null, name: null, receiptNo: 'R1', brand: `B${i}` }));
  }
  storeBillRepo.insertMany(rows);
  // 只标记其中一行 matched — 补全应扩散到同小票全部 5 行
  const billId = storeBillRepo.findByReceipt({ workspaceKey: WS, receiptNo: 'R1' })[0].id;
  markMatched(billMatchLogRepo, dailyId, billId);

  const stats = service.run({ workspaceKey: WS });
  assert.equal(stats.itemsEnriched, 5, '同小票 5 行都被补');
  for (const r of rawBills(db, 'R1')) {
    assert.equal(r.passport_no, 'EM1156758');
    assert.equal(r.departure_date, '2026-05-25');
    assert.equal(r.name, 'BAI');
    assert.equal(r.enriched_from_daily_id, dailyId);
  }
});

test('无 matched 配对 → 不动任何行', () => {
  const { db, storeBillRepo, service } = makeCtx();
  insertDaily(db, { passportNo: 'P1', name: 'A', receiptNo: 'R1' });
  storeBillRepo.insertMany([bill({ passportNo: '', receiptNo: 'R1' })]);
  const stats = service.run({ workspaceKey: WS });
  assert.equal(stats.receiptsTargeted, 0);
  assert.equal(rawBills(db, 'R1')[0].passport_no, null);
});
