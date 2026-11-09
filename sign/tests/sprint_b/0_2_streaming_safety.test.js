'use strict';

/**
 * 0_2_streaming_safety — merge_streaming_service 事务安全性测试
 *
 * 1. 正常路径:run 完成后 monthly_data 行数正确
 * 2. 异常路径(事务内):insertMany 抛出 → BEGIN IMMEDIATE 回滚,旧数据完整保留
 * 3. 异常路径(事务前):storeBillRepo.iterateDetail 抛出 → 删除未发生,旧数据自然保留
 * 4. 等价性 smoke:同一份输入跑 merge_service 和 merge_streaming_service,
 *    产出 monthly_data 的 row_hash 集合完全相同
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openMonthlyDatabase } = require('../../lib/storage/monthly_database');
const { createBillMatchLogRepository } = require('../../repositories/bill_match_log_repository');
const { createDailyReceiptRepository } = require('../../repositories/daily_receipt_repository');
const { createMonthlyDataRepository } = require('../../repositories/monthly_data_repository');
const { createMonthlyWorkspaceRepository } = require('../../repositories/monthly_workspace_repository');
const { createMergeStreamingService } = require('../../services/monthly/merge_streaming_service');
const { createMergeService } = require('../../services/monthly/merge_service');
const { createMonthlyWorkspaceService } = require('../../services/monthly/workspace_service');

const WS = 'demo-2026-05';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-safety-'));
  const db = openMonthlyDatabase({ dbPath: path.join(dir, 'monthly.sqlite') });
  const workspaceRepo = createMonthlyWorkspaceRepository({ db });
  createMonthlyWorkspaceService({ workspaceRepo }).open({ workspaceKey: WS, operator: 'test' });
  const dailyReceiptRepo = createDailyReceiptRepository({ db });
  const monthlyDataRepo = createMonthlyDataRepository({ db });
  const billMatchLogRepo = createBillMatchLogRepository({ db });

  t.after(() => {
    try { db.close?.(); } catch { /* intentional */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  return { db, dailyReceiptRepo, monthlyDataRepo, billMatchLogRepo };
}

function seedOldRow(db) {
  const oldHash = crypto.createHash('sha1').update(`old-${Date.now()}-${Math.random()}`).digest('hex');
  const now = new Date().toISOString();
  db.exec(`
    INSERT INTO monthly_data
      (workspace_key, mode_folder, is_unmatched, row_hash, created_at, updated_at)
    VALUES ('${WS}', 'A', 0, '${oldHash}', '${now}', '${now}')
  `);
  return oldHash;
}

// ─── Test 1: happy path ──────────────────────────────────────────────────────

test('streaming run() inserts expected rows into monthly_data', async (t) => {
  const { db, dailyReceiptRepo, monthlyDataRepo, billMatchLogRepo } = setup(t);

  for (let i = 1; i <= 3; i++) {
    const rno = `R${String(i).padStart(3, '0')}`;
    const hash = crypto.createHash('sha1').update(`${WS}:${rno}`).digest('hex');
    const now = new Date().toISOString();
    db.exec(`
      INSERT OR IGNORE INTO daily_receipt_export
        (workspace_key, receipt_no, row_hash, imported_at,
         ledger_status, tour_match_status, bill_match_status, mode_folder)
      VALUES ('${WS}', '${rno}', '${hash}', '${now}', 'posted', 'matched', 'matched', 'X')
    `);
    const id = db.prepare(
      'SELECT id FROM daily_receipt_export WHERE workspace_key = ? AND receipt_no = ?'
    ).get(WS, rno)?.id;
    db.exec(`
      INSERT OR IGNORE INTO bill_match_log
        (workspace_key, daily_receipt_id, store_bill_id, match_priority,
         match_key, match_status, matched_at)
      VALUES ('${WS}', ${id}, NULL, 1, 'receipt_no', 'matched', '${now}')
    `);
  }

  const svc = createMergeStreamingService({ db, dailyReceiptRepo, billMatchLogRepo, monthlyDataRepo });
  const result = await svc.run({ workspaceKey: WS });

  const count = monthlyDataRepo.countByWorkspace(WS);
  assert.ok(count >= 1, `expected ≥ 1 row, got ${count}`);
  assert.equal(result.workspaceKey, WS);
  assert.ok(typeof result.inserted === 'number');
});

// ─── Test 2: in-transaction exception → rollback, old data preserved ─────────

test('streaming run() rolls back via ROLLBACK when insertMany throws inside the transaction', async (t) => {
  const { db, dailyReceiptRepo, monthlyDataRepo, billMatchLogRepo } = setup(t);

  const oldHash = seedOldRow(db);
  assert.equal(monthlyDataRepo.countByWorkspace(WS), 1, 'precondition: 1 old row');

  // Seed a posted daily receipt so the batch actually builds up and insertMany is called.
  const rno = 'R-TX-001';
  const rHash = crypto.createHash('sha1').update(`${WS}:${rno}`).digest('hex');
  const now = new Date().toISOString();
  db.exec(`
    INSERT OR IGNORE INTO daily_receipt_export
      (workspace_key, receipt_no, row_hash, imported_at,
       ledger_status, tour_match_status, bill_match_status, mode_folder)
    VALUES ('${WS}', '${rno}', '${rHash}', '${now}', 'posted', 'matched', 'matched', 'A')
  `);

  // Wrap monthlyDataRepo so insertMany throws after deleteByWorkspace has cleared old data
  let deleteCount = 0;
  const faultyRepo = {
    ...monthlyDataRepo,
    deleteByWorkspace(...args) {
      deleteCount += 1;
      return monthlyDataRepo.deleteByWorkspace(...args);
    },
    insertMany() {
      // deleteByWorkspace already ran → without ROLLBACK the old row would be gone
      throw new Error('simulated insertMany crash');
    },
  };

  const svc = createMergeStreamingService({
    db,
    dailyReceiptRepo,
    billMatchLogRepo,
    monthlyDataRepo: faultyRepo,
  });

  await assert.rejects(() => svc.run({ workspaceKey: WS }), /simulated insertMany crash/);

  assert.equal(deleteCount, 1, 'deleteByWorkspace must have been called once');
  const afterCount = monthlyDataRepo.countByWorkspace(WS);
  assert.equal(afterCount, 1, 'old row must be restored by ROLLBACK');
  const row = db.prepare('SELECT row_hash FROM monthly_data WHERE workspace_key = ?').get(WS);
  assert.equal(row?.row_hash, oldHash, 'old row hash must match after rollback');
});

// ─── Test 3: pre-transaction exception → no deletion, old data safe ──────────

test('streaming run() preserves old data when storeBillRepo.iterateDetail throws before the transaction', async (t) => {
  const { db, dailyReceiptRepo, monthlyDataRepo, billMatchLogRepo } = setup(t);

  const oldHash = seedOldRow(db);
  assert.equal(monthlyDataRepo.countByWorkspace(WS), 1, 'precondition: 1 old row');

  // iterateDetail is called in the read phase, before BEGIN IMMEDIATE
  const faultyStoreBillRepo = {
    iterateDetail: () => { throw new Error('simulated iterateDetail crash'); },
  };

  const svc = createMergeStreamingService({
    db,
    dailyReceiptRepo,
    billMatchLogRepo,
    monthlyDataRepo,
    storeBillRepo: faultyStoreBillRepo,
  });

  await assert.rejects(() => svc.run({ workspaceKey: WS }), /simulated iterateDetail crash/);

  // No delete ever ran, so old data is still there
  const afterCount = monthlyDataRepo.countByWorkspace(WS);
  assert.equal(afterCount, 1, 'old row must still be present (no delete was issued)');
  const row = db.prepare('SELECT row_hash FROM monthly_data WHERE workspace_key = ?').get(WS);
  assert.equal(row?.row_hash, oldHash);
});

// ─── Test 4: equivalence smoke — merge_service vs merge_streaming_service ────

test('merge_service and merge_streaming_service produce identical row_hash sets', async (t) => {
  function makeEnv() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-equiv-'));
    const db = openMonthlyDatabase({ dbPath: path.join(dir, 'monthly.sqlite') });
    t.after(() => {
      try { db.close?.(); } catch { /* intentional */ }
      fs.rmSync(dir, { recursive: true, force: true });
    });
    createMonthlyWorkspaceService({
      workspaceRepo: createMonthlyWorkspaceRepository({ db }),
    }).open({ workspaceKey: WS, operator: 'test' });
    const now = new Date().toISOString();
    for (let i = 1; i <= 5; i++) {
      const rno = `EQ-${i}`;
      const hash = crypto.createHash('sha1').update(`${WS}:${rno}`).digest('hex');
      db.exec(`
        INSERT OR IGNORE INTO daily_receipt_export
          (workspace_key, receipt_no, row_hash, imported_at,
           ledger_status, tour_match_status, bill_match_status, mode_folder)
        VALUES ('${WS}', '${rno}', '${hash}', '${now}', 'posted', 'matched', 'matched', 'Y')
      `);
      const id = db.prepare(
        'SELECT id FROM daily_receipt_export WHERE workspace_key = ? AND receipt_no = ?'
      ).get(WS, rno)?.id;
      db.exec(`
        INSERT OR IGNORE INTO bill_match_log
          (workspace_key, daily_receipt_id, store_bill_id, match_priority,
           match_key, match_status, matched_at)
        VALUES ('${WS}', ${id}, NULL, 1, 'receipt_no', 'matched', '${now}')
      `);
    }
    return {
      db,
      dailyReceiptRepo: createDailyReceiptRepository({ db }),
      monthlyDataRepo: createMonthlyDataRepository({ db }),
      billMatchLogRepo: createBillMatchLogRepository({ db }),
    };
  }

  const e1 = makeEnv();
  const e2 = makeEnv();

  const legacy = createMergeService({
    dailyReceiptRepo: e1.dailyReceiptRepo,
    billMatchLogRepo: e1.billMatchLogRepo,
    monthlyDataRepo: e1.monthlyDataRepo,
  });
  const streaming = createMergeStreamingService({
    db: e2.db,
    dailyReceiptRepo: e2.dailyReceiptRepo,
    billMatchLogRepo: e2.billMatchLogRepo,
    monthlyDataRepo: e2.monthlyDataRepo,
  });

  await legacy.run({ workspaceKey: WS });
  await streaming.run({ workspaceKey: WS });

  const hashes1 = new Set(
    e1.db.prepare('SELECT row_hash FROM monthly_data WHERE workspace_key = ?').all(WS).map((r) => r.row_hash)
  );
  const hashes2 = new Set(
    e2.db.prepare('SELECT row_hash FROM monthly_data WHERE workspace_key = ?').all(WS).map((r) => r.row_hash)
  );

  assert.equal(hashes1.size, hashes2.size, `row count mismatch: legacy=${hashes1.size} streaming=${hashes2.size}`);
  for (const h of hashes1) {
    assert.ok(hashes2.has(h), `hash ${h} from merge_service missing in merge_streaming_service output`);
  }
});
