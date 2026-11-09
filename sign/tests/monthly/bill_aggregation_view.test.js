'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { runMigrations } = require('../../lib/storage/migration_runner');
const { createStoreBillRepository } = require('../../repositories/store_bill_repository');
const { createBillMatchLogRepository } = require('../../repositories/bill_match_log_repository');
const { createBillAggregationViewService } = require('../../services/monthly/bill_aggregation_view_service');

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
  const billMatchLogRepo = createBillMatchLogRepository({ db });
  const service = createBillAggregationViewService({ db, storeBillRepo });
  return { db, storeBillRepo, billMatchLogRepo, service };
}

function billRow(overrides = {}) {
  return {
    workspaceKey: WS,
    storeFamily: '乐天首尔',
    storeBranch: '本店',
    mode: '现金',
    modeNormalized: 'cash',
    tourNo: 'T001',
    purchaseDate: '2026-05-10',
    departureDate: '2026-05-15',
    name: 'BAI XUE',
    fullName: 'BAI XUE',
    passportNo: 'EP6274602',
    receiptNo: 'R0001',
    brand: 'BrandA',
    qty: 1,
    netUsd: 100,
    netKrw: 130000,
    grossKrw: 140000,
    isDetailSheet: true,
    rowHash: Math.random().toString(36).slice(2),
    importedAt: '2026-05-11T00:00:00.000Z',
    ...overrides,
  };
}

test('聚合: 同一小票号 5 个商品行 → 聚合为 1 行,金额 SUM,detailIds 含 5 个', () => {
  const { storeBillRepo, service } = makeCtx();
  const rows = [];
  for (let i = 0; i < 5; i += 1) {
    rows.push(billRow({ brand: `Brand${i}`, qty: 1, netKrw: 1000, netUsd: 1, rowHash: `h${i}` }));
  }
  storeBillRepo.insertMany(rows);

  const view = service.getReceiptLevelView(WS);
  assert.equal(view.length, 1, '5 商品行同小票号 → 聚合 1 行');
  const r = view[0];
  assert.equal(r.receiptNo, 'R0001');
  assert.equal(r.itemCount, 5);
  assert.equal(r.totalNetKrw, 5000, 'net_krw SUM = 5 * 1000');
  assert.equal(r.totalNetUsd, 5);
  assert.equal(r.totalQty, 5);
  assert.equal(r.detailIds.length, 5, 'detailIds 含 5 个 id');
  assert.equal(r.passportNo, 'EP6274602');
});

test('聚合: 多张不同小票号 → 各自一行', () => {
  const { storeBillRepo, service } = makeCtx();
  storeBillRepo.insertMany([
    billRow({ receiptNo: 'R0001', rowHash: 'a' }),
    billRow({ receiptNo: 'R0002', rowHash: 'b' }),
    billRow({ receiptNo: 'R0002', rowHash: 'c' }),
  ]);
  const view = service.getReceiptLevelView(WS);
  assert.equal(view.length, 2);
  const byNo = Object.fromEntries(view.map((v) => [v.receiptNo, v]));
  assert.equal(byNo.R0001.itemCount, 1);
  assert.equal(byNo.R0002.itemCount, 2);
});

test('聚合: family 过滤只返回该业务桶的小票', () => {
  const { storeBillRepo, service } = makeCtx();
  storeBillRepo.insertMany([
    billRow({ receiptNo: 'R0001', storeFamily: '乐天首尔', rowHash: 'a' }),
    billRow({ receiptNo: 'R0002', storeFamily: '爱宝客', rowHash: 'b' }),
  ]);
  const seoul = service.getReceiptLevelView(WS, { family: '乐天首尔' });
  assert.equal(seoul.length, 1);
  assert.equal(seoul[0].receiptNo, 'R0001');
});

test('聚合: 空/缺小票号的行不计入聚合视图', () => {
  const { storeBillRepo, service } = makeCtx();
  storeBillRepo.insertMany([
    billRow({ receiptNo: 'R0001', rowHash: 'a' }),
    billRow({ receiptNo: '', rowHash: 'b' }),
    billRow({ receiptNo: null, rowHash: 'c' }),
  ]);
  const view = service.getReceiptLevelView(WS);
  assert.equal(view.length, 1);
});

test('getReceiptDetail 返回该小票全部商品行', () => {
  const { storeBillRepo, service } = makeCtx();
  storeBillRepo.insertMany([
    billRow({ receiptNo: 'R0001', brand: 'X', rowHash: 'a' }),
    billRow({ receiptNo: 'R0001', brand: 'Y', rowHash: 'b' }),
  ]);
  const detail = service.getReceiptDetail(WS, 'R0001');
  assert.equal(detail.length, 2);
});

test('getReceiptMatchStatus 按 match_status 聚合该小票各商品行的匹配状态', () => {
  const { storeBillRepo, billMatchLogRepo, service } = makeCtx();
  storeBillRepo.insertMany([
    billRow({ receiptNo: 'R0001', rowHash: 'a' }),
    billRow({ receiptNo: 'R0001', rowHash: 'b' }),
  ]);
  const detail = service.getReceiptDetail(WS, 'R0001');
  billMatchLogRepo.insertMany([
    { workspaceKey: WS, dailyReceiptId: null, storeBillId: detail[0].id, matchPriority: 1, matchKey: 'k', matchStatus: 'matched', matchedAt: '2026-05-11T00:00:00.000Z' },
    { workspaceKey: WS, dailyReceiptId: null, storeBillId: detail[1].id, matchPriority: 0, matchKey: null, matchStatus: 'unmatched', matchedAt: '2026-05-11T00:00:00.000Z' },
  ]);
  const status = service.getReceiptMatchStatus(WS, 'R0001');
  const map = Object.fromEntries(status.map((s) => [s.matchStatus, s.n]));
  assert.equal(map.matched, 1);
  assert.equal(map.unmatched, 1);
});
