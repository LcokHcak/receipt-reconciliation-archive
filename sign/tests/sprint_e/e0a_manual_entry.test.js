'use strict';

/**
 * e0a_manual_entry — 手动无图录入 endpoint 测试 (Sprint E E0a)
 *
 * 测试 manualEntryService.createEntry:
 *   1. 必填字段缺失 → 400 validation_failed
 *   2. exchangeRate 缺失 → 422 exchange_rate_missing
 *   3. exchangeRate 为零/负数 → 422 exchange_rate_missing
 *   4. 工作区已锁定 → 423 WORKSPACE_LOCKED
 *   5. row_hash 碰撞 → 409 target_row_hash_collision
 *   6. 正常路径: 201, 返回 id / workspaceKey / rowHash / ledgerStatus / sourceType
 *   7. 跨月写入: purchaseDate 归属不同月份时 actualWorkspaceKey 指向正确月份
 *   8. deductKrw 默认 0: netKrw = grossKrw
 *   9. demo- 前缀继承: demo 工作区 → 跨月后仍是 demo-xxxx-xx
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openMonthlyDatabase } = require('../../lib/storage/monthly_database');
const { createDailyReceiptRepository } = require('../../repositories/daily_receipt_repository');
const { createMonthlyWorkspaceRepository } = require('../../repositories/monthly_workspace_repository');
const { createMonthlyWorkspaceService } = require('../../services/monthly/workspace_service');
const { createManualEntryService } = require('../../services/monthly/manual_entry_service');

const WS = 'demo-2026-05';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e0a-manual-'));
  const db = openMonthlyDatabase({ dbPath: path.join(dir, 'monthly.sqlite') });
  const workspaceRepo = createMonthlyWorkspaceRepository({ db });
  const workspaceService = createMonthlyWorkspaceService({ workspaceRepo });
  workspaceService.open({ workspaceKey: WS, operator: 'test' });
  const dailyReceiptRepo = createDailyReceiptRepository({ db });
  const svc = createManualEntryService({ db, workspaceService, dailyReceiptRepo });

  t.after(() => {
    try { db.close(); } catch { /* intentional */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* intentional */ }
  });

  return { db, workspaceRepo, workspaceService, dailyReceiptRepo, svc };
}

const BASE = {
  workspaceKey: WS,
  mode: 'T1',
  customerNo: 'CN001',
  customerName: '张三',
  purchaseDate: '2026-05-10',
  grossKrw: 500000,
  exchangeRate: 1200,
  operator: 'tester',
};

test('E0a t1: mode 缺失 → 400 validation_failed', (t) => {
  const { svc } = setup(t);
  assert.throws(
    () => svc.createEntry({ ...BASE, mode: undefined }),
    (err) => {
      assert.equal(err.code, 'validation_failed');
      assert.equal(err.statusCode, 400);
      assert.ok(Array.isArray(err.errors) && err.errors.some((e) => /mode/.test(e)));
      return true;
    }
  );
});

test('E0a t2: customerName 缺失 → 400 validation_failed', (t) => {
  const { svc } = setup(t);
  assert.throws(
    () => svc.createEntry({ ...BASE, customerName: undefined }),
    (err) => {
      assert.equal(err.code, 'validation_failed');
      assert.equal(err.statusCode, 400);
      return true;
    }
  );
});

test('E0a t3: exchangeRate 缺失 → 422 exchange_rate_missing', (t) => {
  const { svc } = setup(t);
  assert.throws(
    () => svc.createEntry({ ...BASE, exchangeRate: undefined }),
    (err) => {
      assert.equal(err.code, 'exchange_rate_missing');
      assert.equal(err.statusCode, 422);
      return true;
    }
  );
});

test('E0a t4: exchangeRate=0 → 422 exchange_rate_missing', (t) => {
  const { svc } = setup(t);
  assert.throws(
    () => svc.createEntry({ ...BASE, exchangeRate: 0 }),
    (err) => {
      assert.equal(err.code, 'exchange_rate_missing');
      assert.equal(err.statusCode, 422);
      return true;
    }
  );
});

test('E0a t5: 工作区已锁定 → 423 WORKSPACE_LOCKED', (t) => {
  const { svc, workspaceRepo } = setup(t);
  // 锁定工作区
  workspaceRepo.updateStatus({
    workspaceKey: WS,
    status: 'locked',
    updatedAt: new Date().toISOString(),
    lockedAt: new Date().toISOString(),
    lockedBy: 'test',
  });
  assert.throws(
    () => svc.createEntry({ ...BASE }),
    (err) => {
      assert.equal(err.code, 'WORKSPACE_LOCKED');
      assert.equal(err.statusCode, 423);
      return true;
    }
  );
});

test('E0a t6: 正常路径 → 201 / id / rowHash / ledgerStatus', (t) => {
  const { svc } = setup(t);
  const result = svc.createEntry({ ...BASE });
  assert.ok(result.id, 'should have id');
  assert.equal(result.workspaceKey, WS);
  assert.equal(result.actualWorkspaceKey, WS);
  assert.ok(typeof result.rowHash === 'string' && result.rowHash.length === 40, 'sha1 hex');
  assert.equal(result.ledgerStatus, 'posted');
  assert.equal(result.sourceType, 'manual');
});

test('E0a t7: row_hash 碰撞 → 409 target_row_hash_collision', (t) => {
  const { db, workspaceService, dailyReceiptRepo } = setup(t);
  const knownHash = 'abcd' + '0'.repeat(36);
  // 预占该 hash
  db.prepare(
    `INSERT INTO daily_receipt_export
       (workspace_key, source_type, ledger_status, row_hash, imported_at)
     VALUES (?, 'manual', 'posted', ?, ?)`
  ).run(WS, knownHash, new Date().toISOString());

  // 注入固定 hash 函数，使 service 总是生成已存在的 hash
  const svcFixed = createManualEntryService({
    db,
    workspaceService,
    dailyReceiptRepo,
    _computeHash: () => knownHash,
  });

  assert.throws(
    () => svcFixed.createEntry({ ...BASE, customerNo: 'CN-COLLISION' }),
    (err) => {
      assert.equal(err.code, 'target_row_hash_collision');
      assert.equal(err.statusCode, 409);
      return true;
    }
  );
});

test('E0a t8: deductKrw 默认 0 → netKrw === grossKrw', (t) => {
  const { svc, db } = setup(t);
  const result = svc.createEntry({ ...BASE, customerNo: 'CN-DEDUCT', deductKrw: undefined });
  // 查 DB 行验证 netKrw
  const row = db.prepare(
    'SELECT net_krw, gross_krw FROM daily_receipt_export WHERE id = ?'
  ).get(result.id);
  assert.equal(row.net_krw, row.gross_krw, 'deductKrw=0 means netKrw=grossKrw');
});

test('E0a t9: 跨月 purchaseDate → actualWorkspaceKey 指向正确月', (t) => {
  const { svc, workspaceService } = setup(t);
  // 提前开 demo-2026-04
  workspaceService.open({ workspaceKey: 'demo-2026-04', operator: 'test' });
  const result = svc.createEntry({
    ...BASE,
    customerNo: 'CN-CROSS',
    workspaceKey: WS,             // May workspace
    purchaseDate: '2026-04-15',   // April purchase date → cross month
  });
  assert.equal(result.actualWorkspaceKey, 'demo-2026-04');
  assert.equal(result.workspaceKey, WS, 'original workspaceKey preserved');
});
