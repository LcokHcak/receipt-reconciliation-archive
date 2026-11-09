'use strict';

/**
 * B3: 未收清单「已处理」持久化。
 * 验证 resolve 落库后 listUnreceived 不再返回该项(刷新不复活),
 * 且 item_key 与 customer_reconciliation_service 同口径。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openMonthlyDatabase } = require('../lib/storage/monthly_database');
const { createStoreBillRepository } = require('../repositories/store_bill_repository');
const { createImportJobRepository } = require('../repositories/import_job_repository');
const {
  createUnreceivedResolutionRepository,
} = require('../repositories/unreceived_resolution_repository');
const {
  createCustomerReconciliationService,
  unreceivedItemKey,
} = require('../services/monthly/customer_reconciliation_service');

const WS = '2026-01';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unrecv-'));
  const db = openMonthlyDatabase({ dbPath: path.join(dir, 'monthly.sqlite') });
  const storeBillRepo = createStoreBillRepository({ db });
  smgJobId = createImportJobRepository({ db }).create({
    workspaceKey: WS, jobType: 'smg_ledger', sourceFile: 'SMG总账.xlsx', operator: 'op', startedAt: 't',
  });
  const resolutionRepo = createUnreceivedResolutionRepository({ db });
  const recon = createCustomerReconciliationService({
    db,
    unreceivedResolutionRepo: resolutionRepo,
  });
  t.after(() => {
    try { db.close?.(); } catch { /* best-effort */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });
  return { db, storeBillRepo, resolutionRepo, recon };
}

let smgJobId = null;
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
    importJobId: smgJobId, // 未收=SMG总账口径
    ...extras,
  }]);
}

test('resolve removes the item from listUnreceived and persists the key', (t) => {
  const s = setup(t);
  seedBill(s.storeBillRepo);

  const before = s.recon.listUnreceived(WS);
  assert.equal(before.length, 1);
  assert.equal(before[0].receipt_no, 'R100');

  const itemKey = unreceivedItemKey({ passportNo: 'P1', name: 'LI MING', receiptNo: 'R100' });
  const result = s.resolutionRepo.resolveMany({
    workspaceKey: WS,
    items: [{ itemKey, passportNo: 'P1', name: 'LI MING', receiptNo: 'R100' }],
    action: 'delay',
    reason: '客户已承诺补交',
    resolvedBy: 'tester',
  });
  assert.equal(result.resolved, 1);

  const after = s.recon.listUnreceived(WS);
  assert.equal(after.length, 0, '已处理项不应再出现在未收清单');

  assert.ok(s.resolutionRepo.listKeys(WS).has(itemKey));
  const rows = s.resolutionRepo.list(WS);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'delay');
  assert.equal(rows[0].resolvedBy, 'tester');
});

test('resolveMany is idempotent (upsert) and unresolve brings the item back', (t) => {
  const s = setup(t);
  seedBill(s.storeBillRepo);
  const itemKey = unreceivedItemKey({ passportNo: 'P1', name: 'LI MING', receiptNo: 'R100' });

  s.resolutionRepo.resolveMany({ workspaceKey: WS, items: [{ itemKey }], action: 'delay' });
  s.resolutionRepo.resolveMany({ workspaceKey: WS, items: [{ itemKey }], action: 'void' });
  assert.equal(s.resolutionRepo.list(WS).length, 1, 'upsert 不应产生重复行');
  assert.equal(s.resolutionRepo.list(WS)[0].action, 'void', '应覆盖为最新动作');

  s.resolutionRepo.unresolve({ workspaceKey: WS, itemKey });
  assert.equal(s.recon.listUnreceived(WS).length, 1, '撤销后该项重新出现');
});

test('resolveMany rejects unsupported action', (t) => {
  const s = setup(t);
  assert.throws(
    () => s.resolutionRepo.resolveMany({ workspaceKey: WS, items: [{ itemKey: 'x' }], action: 'bogus' }),
    /unsupported_action/
  );
});
