'use strict';

/**
 * e0b_orphan_aggregation — 孤立账单 + 孤立行聚合 service 测试 (Sprint E E0b)
 *
 * 测试 orphanAggregationService:
 *   1.  空工作区 → items=[], total=0
 *   2.  store_bill 无匹配 log → 视为孤立账单
 *   3.  store_bill 有 matched log → 不视为孤立账单
 *   4.  daily_receipt_export bill_match_status=unmatched → 孤立行
 *   5.  daily_receipt_export bill_match_status=matched → 不视为孤立行
 *   6.  模糊候选评分: amount 相近 → score >= 0.4
 *   7.  模糊候选评分: score < 0.3 → 不返回候选
 *   8.  listOrphanBills dateFrom/dateTo 过滤
 *   9.  listOrphanRows search 过滤
 *   10. candidates 上限: 最多 MAX_CANDS=3 条
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openMonthlyDatabase } = require('../../lib/storage/monthly_database');
const { createOrphanAggregationService } = require('../../services/monthly/orphan_aggregation_service');

const WS = 'demo-2026-05';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e0b-orphan-'));
  const db = openMonthlyDatabase({ dbPath: path.join(dir, 'monthly.sqlite') });
  const svc = createOrphanAggregationService({ db });

  t.after(() => {
    try { db.close(); } catch { /* intentional */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* intentional */ }
  });
  return { db, svc };
}

// ── 种子 helpers ──────────────────────────────────────────────────────────────

let _billSeq = 0;
function insertBill(db, partial = {}) {
  _billSeq++;
  const row = {
    workspace_key: WS,
    store_family: 'LotteSeoul',
    store_branch: 'LotteSeoul',
    mode: partial.mode || 'T1',
    mode_normalized: partial.mode_normalized || partial.mode || 'T1',
    purchase_date: partial.purchase_date || '2026-05-10',
    name: partial.name || `CUSTOMER_${_billSeq}`,
    passport_no: partial.passport_no || `EG${100000 + _billSeq}`,
    receipt_no: partial.receipt_no || `R${_billSeq}`,
    net_krw: partial.net_krw ?? 500000,
    net_usd: partial.net_usd ?? 400,
    gross_krw: partial.gross_krw ?? 550000,
    row_hash: partial.row_hash || `bilhash${_billSeq}`,
    imported_at: '2026-05-20T00:00:00.000Z',
    is_detail_sheet: 0,
  };
  const info = db.prepare(`
    INSERT INTO store_bill (
      workspace_key, store_family, store_branch, mode, mode_normalized,
      purchase_date, name, passport_no, receipt_no,
      net_krw, net_usd, gross_krw,
      row_hash, imported_at, is_detail_sheet
    ) VALUES (
      :workspace_key, :store_family, :store_branch, :mode, :mode_normalized,
      :purchase_date, :name, :passport_no, :receipt_no,
      :net_krw, :net_usd, :gross_krw,
      :row_hash, :imported_at, :is_detail_sheet
    )
  `).run(row);
  return info.lastInsertRowid;
}

let _rowSeq = 0;
function insertDailyRow(db, partial = {}) {
  _rowSeq++;
  const row = {
    workspace_key: WS,
    mode_raw: partial.mode_raw || 'T1',
    mode_normalized: partial.mode_normalized || 'T1',
    purchase_date: partial.purchase_date || '2026-05-10',
    name: partial.name || `CUST_${_rowSeq}`,
    passport_no: partial.passport_no || `PA${200000 + _rowSeq}`,
    receipt_no: partial.receipt_no || `DR${_rowSeq}`,
    net_krw: partial.net_krw ?? 500000,
    net_usd: partial.net_usd ?? 400,
    gross_krw: partial.gross_krw ?? 550000,
    bill_match_status: partial.bill_match_status || 'unmatched',
    row_hash: partial.row_hash || `rowhash${_rowSeq}`,
    imported_at: '2026-05-20T00:00:00.000Z',
  };
  const info = db.prepare(`
    INSERT INTO daily_receipt_export (
      workspace_key, mode_raw, mode_normalized,
      purchase_date, name, passport_no, receipt_no,
      net_krw, net_usd, gross_krw,
      bill_match_status, row_hash, imported_at
    ) VALUES (
      :workspace_key, :mode_raw, :mode_normalized,
      :purchase_date, :name, :passport_no, :receipt_no,
      :net_krw, :net_usd, :gross_krw,
      :bill_match_status, :row_hash, :imported_at
    )
  `).run(row);
  return info.lastInsertRowid;
}

function insertMatchLog(db, dailyReceiptId, storeBillId, status = 'matched') {
  db.prepare(`
    INSERT INTO bill_match_log (
      workspace_key, daily_receipt_id, store_bill_id,
      match_priority, match_key, match_status, matched_at
    ) VALUES (?, ?, ?, 1, 'test', ?, ?)
  `).run(WS, dailyReceiptId, storeBillId, status, '2026-05-20T00:00:00.000Z');
}

function markBillUnmatched(db, storeBillId) {
  insertMatchLog(db, null, storeBillId, 'unmatched');
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('E0b t1: 空工作区 → items=[], total=0', (t) => {
  const { svc } = setup(t);
  const bills = svc.listOrphanBills({ workspaceKey: WS });
  const rows = svc.listOrphanRows({ workspaceKey: WS });
  assert.equal(bills.items.length, 0);
  assert.equal(bills.total, 0);
  assert.equal(rows.items.length, 0);
  assert.equal(rows.total, 0);
});

test('E0b t2: store_bill with unmatched log is an unreceived bill', (t) => {
  const { db, svc } = setup(t);
  const billId = insertBill(db);
  markBillUnmatched(db, billId);
  const result = svc.listOrphanBills({ workspaceKey: WS });
  assert.equal(result.items.length, 1);
  assert.equal(result.total, 1);
});

test('E0b t3: store_bill 有 matched log → 不返回', (t) => {
  const { db, svc } = setup(t);
  const billId = insertBill(db);
  const rowId = insertDailyRow(db, { bill_match_status: 'matched' });
  insertMatchLog(db, rowId, billId, 'matched');
  const result = svc.listOrphanBills({ workspaceKey: WS });
  assert.equal(result.items.length, 0);
});

test('E0b t4: daily_receipt_export bill_match_status=unmatched is not an unreceived receipt', (t) => {
  const { db, svc } = setup(t);
  insertDailyRow(db, { bill_match_status: 'unmatched' });
  const result = svc.listOrphanRows({ workspaceKey: WS });
  assert.equal(result.items.length, 0);
  assert.equal(result.total, 0);

  const reviewResult = svc.listDailyWithoutBill({ workspaceKey: WS });
  assert.equal(reviewResult.items.length, 1);
  assert.equal(reviewResult.total, 1);
});

test('E0b t5: daily_receipt_export bill_match_status=matched → 不返回', (t) => {
  const { db, svc } = setup(t);
  insertDailyRow(db, { bill_match_status: 'matched' });
  const result = svc.listOrphanRows({ workspaceKey: WS });
  assert.equal(result.items.length, 0);
});

test('E0b t6: 模糊候选: amount 相近 → score >= 0.4 → 包含候选', (t) => {
  const { db, svc } = setup(t);
  // 孤立行: netKrw = 500000
  insertDailyRow(db, { net_krw: 500000, purchase_date: '2026-05-10', mode_raw: 'T1' });
  // 孤立账单: netKrw = 510000 (相差 2%) → amount score = 1
  const billId = insertBill(db, { net_krw: 510000, purchase_date: '2026-05-10', mode: 'T1' });
  markBillUnmatched(db, billId);

  const result = svc.listOrphanBills({ workspaceKey: WS });
  assert.equal(result.items.length, 1);
  const candidates = result.items[0].candidates;
  assert.ok(candidates.length > 0, 'should have at least 1 candidate');
  assert.ok(candidates[0].score >= 0.4, `score should be >= 0.4, got ${candidates[0].score}`);
});

test('E0b t7: score < 0.3 → 不返回候选', (t) => {
  const { db, svc } = setup(t);
  // 孤立行: netKrw = 500000
  insertDailyRow(db, { net_krw: 500000, purchase_date: '2026-05-10' });
  // 孤立账单: netKrw 完全不同（20000），date 也不同 → score < 0.3
  const billId = insertBill(db, { net_krw: 20000, purchase_date: '2026-01-01' });
  markBillUnmatched(db, billId);

  const result = svc.listOrphanBills({ workspaceKey: WS });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].candidates.length, 0, 'no candidate should pass threshold');
});

test('E0b t8: listOrphanBills dateFrom/dateTo 过滤', (t) => {
  const { db, svc } = setup(t);
  markBillUnmatched(db, insertBill(db, { purchase_date: '2026-05-01' }));
  markBillUnmatched(db, insertBill(db, { purchase_date: '2026-05-15' }));
  markBillUnmatched(db, insertBill(db, { purchase_date: '2026-05-28' }));

  const result = svc.listOrphanBills({ workspaceKey: WS, dateFrom: '2026-05-10', dateTo: '2026-05-20' });
  assert.equal(result.items.length, 1, 'only May 15 should pass');
  assert.equal(result.items[0].purchaseDate, '2026-05-15');
});

test('E0b t9: listOrphanRows remains empty because daily-without-bill belongs in bill review', (t) => {
  const { db, svc } = setup(t);
  insertDailyRow(db, { name: '张三', bill_match_status: 'unmatched' });
  insertDailyRow(db, { name: '李四', bill_match_status: 'unmatched' });

  const result = svc.listOrphanRows({ workspaceKey: WS, search: '张三' });
  assert.equal(result.items.length, 0);
  assert.equal(result.total, 0);
});

test('E0b t10: orphan bill candidates are capped at MAX_CANDS=3', (t) => {
  const { db, svc } = setup(t);
  // One orphan bill should surface at most three candidate daily rows.
  const billId = insertBill(db, { net_krw: 500000, purchase_date: '2026-05-10', mode: 'T1' });
  markBillUnmatched(db, billId);
  for (let i = 0; i < 5; i++) {
    insertDailyRow(db, {
      net_krw: 500000 + i * 100,   // slight variation but same range
      purchase_date: '2026-05-10',
      mode_raw: 'T1',
    });
  }
  const result = svc.listOrphanBills({ workspaceKey: WS });
  assert.equal(result.items.length, 1);
  assert.ok(result.items[0].candidates.length <= 3, 'candidates should be capped at 3');
});
