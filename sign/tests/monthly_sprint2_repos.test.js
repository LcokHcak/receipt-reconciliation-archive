'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { openMonthlyDatabase } = require('../lib/storage/monthly_database');
const { createReceivedReceiptRepository } = require('../repositories/received_receipt_repository');
const { createDailyReceiptRepository } = require('../repositories/daily_receipt_repository');
const { createMonthlyDataRepository } = require('../repositories/monthly_data_repository');

function withDb(fn) {
  const tmp = path.join(os.tmpdir(), `sprint2-repo-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
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

test('openMonthlyDatabase — applies Sprint 2 ALTERs on store_bill', () => {
  withDb((db) => {
    const cols = db.prepare('PRAGMA table_info(store_bill)').all().map((r) => r.name);
    for (const col of [
      'statement_date', 'payment_mode', 'upstream', 'entry_company', 'tour_guide',
      'agent', 'product_name', 'dc_usd', 'dc_krw', 'discount_rate',
      'voucher_amount', 'voucher_deduction',
      'customer_points', 'customer_rebate',
      'store_base_points', 'store_base_rebate',
      'store_extra_points', 'store_extra_amount', 'store_final_rebate',
      'category_secondary', 'remark',
    ]) {
      assert.ok(cols.includes(col), `store_bill.${col} should exist`);
    }
  });
});

test('openMonthlyDatabase — adds reason column to departure_sync_audit', () => {
  withDb((db) => {
    const cols = db.prepare('PRAGMA table_info(departure_sync_audit)').all().map((r) => r.name);
    assert.ok(cols.includes('reason'), 'departure_sync_audit.reason should exist');
  });
});

test('openMonthlyDatabase — creates Sprint 2 tables', () => {
  withDb((db) => {
    const tables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
    ).all().map((r) => r.name);
    for (const t of [
      'received_receipt', 'daily_receipt_export', 'bill_match_log',
      'pending_review', 'monthly_data',
    ]) {
      assert.ok(tables.includes(t), `table ${t} should exist`);
    }
  });
});

test('receivedReceiptRepository — insertMany + countByWorker + findByReceipt', () => {
  withDb((db) => {
    const repo = createReceivedReceiptRepository({ db });
    const result = repo.insertMany([
      {
        workspaceKey: '2026-01', workerName: '侯丹妮', workerNo: '9',
        receiptDate: '2026-01-15', receiptNo: '0326152400282',
        tourNo: '71993', name: 'WANG LING', passportNo: 'EC0943782',
        rowHash: 'h1', importedAt: 't',
      },
      {
        workspaceKey: '2026-01', workerName: '高杰', workerNo: '11',
        receiptDate: '2026-01-15', receiptNo: '0326152400283',
        tourNo: '71993', name: 'LI MING', passportNo: 'EK1234567',
        rowHash: 'h2', importedAt: 't',
      },
    ]);
    assert.equal(result.inserted, 2);
    assert.equal(repo.countByWorkspace('2026-01'), 2);
    const byWorker = repo.countByWorker('2026-01');
    assert.equal(byWorker.length, 2);

    const hits = repo.findByReceipt({ workspaceKey: '2026-01', receiptNo: '0326152400282' });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].name, 'WANG LING');

    // Dedupe via row_hash
    const again = repo.insertMany([{
      workspaceKey: '2026-01', workerName: '侯丹妮', workerNo: '9',
      receiptDate: '2026-01-15', receiptNo: '0326152400282',
      tourNo: '71993', name: 'WANG LING', passportNo: 'EC0943782',
      rowHash: 'h1', importedAt: 't',
    }]);
    assert.equal(again.inserted, 0);
    assert.equal(again.skipped, 1);
  });
});

test('dailyReceiptRepository — insertMany + countByMode + tour/bill match updates', () => {
  withDb((db) => {
    const repo = createDailyReceiptRepository({ db });
    const result = repo.insertMany([
      {
        workspaceKey: '2026-01', receiptNo: 'R1', name: 'A', passportNo: 'P1',
        tourNo: '71993', agent: '梓陌', modeRaw: '乐天SG',
        rowHash: 'd1', importedAt: 't',
      },
      {
        workspaceKey: '2026-01', receiptNo: 'R2', name: 'B', passportNo: 'P2',
        tourNo: '71994', agent: '大雄', modeRaw: '济州乐天V团',
        rowHash: 'd2', importedAt: 't',
      },
    ]);
    assert.equal(result.inserted, 2);

    const byStatus = repo.countByMatchStatus('2026-01');
    assert.equal(byStatus[0].status, 'unmatched');
    assert.equal(byStatus[0].n, 2);

    // Simulate stage 1.5 tour match
    const all = db.prepare('SELECT id FROM daily_receipt_export WHERE workspace_key = ?').all('2026-01');
    repo.updateTourMatch({
      id: all[0].id, workspaceKey: '2026-01',
      modeFolder: '乐天首尔', modeRaw: '乐天SG', modeNormalized: 'SG',
      tourMatchStatus: 'matched',
    });
    const modeSummary = repo.countByMode('2026-01');
    assert.ok(modeSummary.some((m) => m.folder === '乐天首尔' && m.n === 1));

    // Simulate stage 2 bill match
    repo.updateBillMatch({
      id: all[0].id, workspaceKey: '2026-01',
      billMatchStatus: 'matched', billMatchPriority: 1,
    });
    const byStatusAfter = repo.countByMatchStatus('2026-01');
    const matchedCnt = byStatusAfter.find((s) => s.status === 'matched');
    assert.equal(matchedCnt.n, 1);
  });
});

test('dailyReceiptRepository skips duplicate receipt business keys even when row_hash changes', () => {
  withDb((db) => {
    const repo = createDailyReceiptRepository({ db });
    const first = repo.insertMany([
      {
        workspaceKey: '2026-05',
        shop: 'THE SHILLA',
        receiptNo: '0326155300069',
        purchaseDate: '2026-01-15',
        name: 'ZHENG ANBANG',
        passportNo: 'EF3892854',
        rowHash: 'old-task-based-hash',
        importedAt: '2026-05-13T07:30:00.000Z',
        sourceType: 'workbench',
      },
    ]);
    assert.equal(first.inserted, 1);

    const again = repo.insertMany([
      {
        workspaceKey: '2026-05',
        shop: 'THE SHILLA',
        receiptNo: '0326155300069',
        purchaseDate: '2026-01-15',
        name: 'ZHENG ANBANG',
        passportNo: 'EF3892854',
        rowHash: 'new-business-hash',
        importedAt: '2026-05-13T14:30:00.000Z',
        sourceType: 'workbench',
      },
    ]);

    assert.equal(again.inserted, 0);
    assert.equal(again.skipped, 1);
    assert.equal(repo.countByWorkspace('2026-05'), 1);
  });
});

test('dailyReceiptRepository treats one receipt as one row when passport OCR changes', () => {
  withDb((db) => {
    const repo = createDailyReceiptRepository({ db });
    const result = repo.insertMany([
      {
        workspaceKey: '2026-05',
        shop: 'THE SHILLA',
        receiptNo: '0326146800180',
        purchaseDate: '2026-01-29',
        name: 'ALIPAY',
        passportNo: 'EJ9650087',
        rowHash: 'with-passport',
        importedAt: '2026-05-13T07:30:00.000Z',
        sourceType: 'workbench',
      },
      {
        workspaceKey: '2026-05',
        shop: 'THE SHILLA',
        receiptNo: '0326146800180',
        purchaseDate: '2026-01-29',
        name: 'BAR CODE',
        passportNo: '',
        rowHash: 'missing-passport',
        importedAt: '2026-05-13T07:31:00.000Z',
        sourceType: 'workbench',
      },
    ]);
    assert.equal(result.inserted, 1);
    assert.equal(result.skipped, 1);
    assert.equal(repo.countByWorkspace('2026-05'), 1);
  });
});

test('dailyReceiptRepository counts ledger statuses using the same filters as the ledger table', () => {
  withDb((db) => {
    const repo = createDailyReceiptRepository({ db });
    repo.insertMany([
      {
        workspaceKey: '2026-05',
        shop: 'THE SHILLA',
        receiptNo: 'R1',
        purchaseDate: '2026-01-15',
        rowHash: 'ready',
        importedAt: '2026-05-13T00:00:00.000Z',
        sourceType: 'workbench',
        ledgerStatus: 'ready_to_post',
        receiptDate: '2026-05-13',
      },
      {
        workspaceKey: '2026-05',
        shop: 'THE SHILLA',
        receiptNo: 'R2',
        purchaseDate: '2026-01-16',
        rowHash: 'remedy',
        importedAt: '2026-05-13T00:00:00.000Z',
        sourceType: 'workbench',
        ledgerStatus: 'remedy',
        remedyReason: 'tour_match_unresolved',
        receiptDate: '2026-05-13',
      },
    ]);

    const counts = repo.countByLedgerStatus({
      workspaceKey: '2026-05',
      ledgerStatus: 'ready_to_post',
    });

    assert.deepEqual(counts.map((row) => [row.status, row.n]), [
      ['ready_to_post', 1],
    ]);
  });
});

test('monthlyDataRepository — insertMany + countByMode', () => {
  withDb((db) => {
    const repo = createMonthlyDataRepository({ db });
    const now = '2026-05-11T00:00:00.000Z';
    repo.insertMany([
      {
        workspaceKey: '2026-01', modeFolder: '乐天首尔', isUnmatched: false,
        dailyReceiptId: 1, storeBillId: 99, receiptNo: 'R1', name: 'A',
        passportNo: 'P1', tourNo: '71993',
        rowHash: 'm1', createdAt: now,
      },
      {
        workspaceKey: '2026-01', modeFolder: '乐天首尔', isUnmatched: true,
        dailyReceiptId: 2, storeBillId: 100, receiptNo: 'R2', name: 'B',
        passportNo: 'P2', tourNo: '71993',
        rowHash: 'm2', createdAt: now,
      },
      {
        workspaceKey: '2026-01', modeFolder: '爱宝客', isUnmatched: false,
        dailyReceiptId: 3, storeBillId: 101, receiptNo: 'R3', name: 'C',
        passportNo: 'P3', tourNo: '71999',
        rowHash: 'm3', createdAt: now,
      },
    ]);
    assert.equal(repo.countByWorkspace('2026-01'), 3);
    const byMode = repo.countByMode('2026-01');
    const lotteFormal = byMode.find((m) => m.folder === '乐天首尔' && m.unmatched === 0);
    const lotteUnmatched = byMode.find((m) => m.folder === '乐天首尔' && m.unmatched === 1);
    assert.equal(lotteFormal.n, 1);
    assert.equal(lotteUnmatched.n, 1);
  });
});

test('monthly_data — Phase 2 columns exist (customer_rebate_krw, customer_rebate_usd, merge_config_version)', () => {
  withDb((db) => {
    const cols = db.prepare(`PRAGMA table_info('monthly_data')`).all().map((r) => r.name);
    for (const col of ['customer_rebate_krw', 'customer_rebate_usd', 'merge_config_version']) {
      assert.ok(cols.includes(col), `monthly_data.${col} should exist`);
    }
  });
});
