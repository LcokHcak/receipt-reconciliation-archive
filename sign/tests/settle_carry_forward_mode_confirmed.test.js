'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openMonthlyDatabase } = require('../lib/storage/monthly_database');
const { createDailyReceiptRepository } = require('../repositories/daily_receipt_repository');
const { computeDailyRowHash } = require('../lib/monthly/daily_row_hash');

// 审计L518:重结算删旧行对「已确认模式(mode_confirmed_at)但账单未匹配」行无豁免 → 审核员模式背书
// 静默抹掉(settled 翻回 needs_confirm)。裸豁免旧行会双计,故采背书 carry-forward:settleGroupAtomic
// 删旧前快照确认行背书,按业务键注入重插后业务键不变的同一行;业务键变了则丢弃走重确认。

const WS = '2026-07';

function openTmpRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-fwd-'));
  const db = openMonthlyDatabase({ dbPath: path.join(dir, 'monthly.sqlite') });
  const repo = createDailyReceiptRepository({ db });
  t.after(() => {
    try { db.close?.(); } catch { /* best-effort */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });
  return repo;
}

// 种一条「已确认模式」的旧台账行,返回其 id
function seedConfirmedRow(repo, { ws = WS, receiptNo, shop, purchaseDate, modeConfirmedAt, modeConfirmedBy, manualLockedFields = null }) {
  const rowHash = computeDailyRowHash({ workspaceKey: ws, receiptNo, purchaseDate, shop });
  repo.insertMany([{
    workspaceKey: ws, receiptNo, shop, purchaseDate,
    billMatchStatus: 'unmatched', tourMatchStatus: 'matched',
    modeConfirmedAt, modeConfirmedBy, manualLockedFields,
    rowHash, importedAt: 't', sourceType: 'workbench',
  }]);
  return repo._listAll({ workspaceKey: ws }).find((r) => r.rowHash === rowHash).id;
}

function newRow({ ws = WS, receiptNo, shop, purchaseDate, modeConfirmedAt = null, modeConfirmedBy = null }) {
  return {
    workspaceKey: ws, receiptNo, shop, purchaseDate,
    billMatchStatus: 'unmatched', tourMatchStatus: 'matched',
    modeConfirmedAt, modeConfirmedBy,
    rowHash: computeDailyRowHash({ workspaceKey: ws, receiptNo, purchaseDate, shop }),
    importedAt: 't', sourceType: 'workbench',
  };
}

// ① load-bearing 双计守卫:确认行 + 任务票号经重识别变化(业务键变)+ re-settle → 只剩一行 + 背书丢弃
test('L518 双计守卫:确认行业务键变(重识别改票号)重结算 → 组只剩一行、背书丢弃(needs_confirm)', (t) => {
  const repo = openTmpRepo(t);
  const oldId = seedConfirmedRow(repo, { receiptNo: 'R1', shop: 'S', purchaseDate: '2026-07-10', modeConfirmedAt: '2026-07-01T00:00:00Z', modeConfirmedBy: 'alice' });

  // 重结算:删旧 R1,插新 R2(票号被重识别改了,业务键变)
  const res = repo.settleGroupAtomic({
    deletes: [{ workspaceKey: WS, ids: [oldId] }],
    insertBuckets: [{ workspaceKey: WS, rows: [newRow({ receiptNo: 'R2', shop: 'S', purchaseDate: '2026-07-10' })] }],
  });
  assert.deepEqual(res, { removed: 1, inserted: 1, skipped: 0 });

  const rows = repo._listAll({ workspaceKey: WS });
  assert.equal(rows.length, 1, '关键:不双计,组只剩一行');
  assert.equal(rows[0].receiptNo, 'R2', '留下的是新票号行');
  assert.equal(rows[0].modeConfirmedAt, null, '业务键变了→背书丢弃(翻 needs_confirm 要求重确认)');
});

// ② load-bearing 幸福路径:确认行 + 补票 re-settle(自身业务键不变)→ 背书保留 settled、单行
test('L518 幸福路径:确认行业务键不变(补票重结算)→ 背书 carry-forward 保留、仍单行', (t) => {
  const repo = openTmpRepo(t);
  const oldId = seedConfirmedRow(repo, { receiptNo: 'R1', shop: 'S', purchaseDate: '2026-07-10', modeConfirmedAt: '2026-07-01T00:00:00Z', modeConfirmedBy: 'alice' });

  // 重结算:删旧 R1,插新 R1(同业务键,背书未带)
  const res = repo.settleGroupAtomic({
    deletes: [{ workspaceKey: WS, ids: [oldId] }],
    insertBuckets: [{ workspaceKey: WS, rows: [newRow({ receiptNo: 'R1', shop: 'S', purchaseDate: '2026-07-10' })] }],
  });
  assert.deepEqual(res, { removed: 1, inserted: 1, skipped: 0 });

  const rows = repo._listAll({ workspaceKey: WS });
  assert.equal(rows.length, 1, '单行,无双计');
  assert.equal(rows[0].receiptNo, 'R1');
  assert.equal(rows[0].modeConfirmedAt, '2026-07-01T00:00:00Z', '业务键不变→背书 carry-forward 保留(不翻 needs_confirm)');
  assert.equal(rows[0].modeConfirmedBy, 'alice', '背书人一并保留');
});

// ③ #33 对齐:确认行锁了业务键(购买日期)→ 不 carry(背书归属有歧义,宁可重确认)
test('L518 #33对齐:确认行锁了业务键(purchase_date)→ 重结算不 carry 背书', (t) => {
  const repo = openTmpRepo(t);
  const oldId = seedConfirmedRow(repo, {
    receiptNo: 'R1', shop: 'S', purchaseDate: '2026-07-10',
    modeConfirmedAt: '2026-07-01T00:00:00Z', modeConfirmedBy: 'alice',
    manualLockedFields: '["purchase_date"]',
  });

  const res = repo.settleGroupAtomic({
    deletes: [{ workspaceKey: WS, ids: [oldId] }],
    insertBuckets: [{ workspaceKey: WS, rows: [newRow({ receiptNo: 'R1', shop: 'S', purchaseDate: '2026-07-10' })] }],
  });
  assert.equal(res.inserted, 1);
  const rows = repo._listAll({ workspaceKey: WS });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].modeConfirmedAt, null, '锁了业务键的确认行不 carry(与 #33 一致)');
});

// ④ 幂等:重插行已自带背书 → 不被快照覆盖
test('L518 幂等:重插行已自带 mode_confirmed → carry 不覆盖', (t) => {
  const repo = openTmpRepo(t);
  const oldId = seedConfirmedRow(repo, { receiptNo: 'R1', shop: 'S', purchaseDate: '2026-07-10', modeConfirmedAt: '2026-07-01T00:00:00Z', modeConfirmedBy: 'alice' });

  const res = repo.settleGroupAtomic({
    deletes: [{ workspaceKey: WS, ids: [oldId] }],
    insertBuckets: [{ workspaceKey: WS, rows: [newRow({ receiptNo: 'R1', shop: 'S', purchaseDate: '2026-07-10', modeConfirmedAt: '2026-08-01T00:00:00Z', modeConfirmedBy: 'bob' })] }],
  });
  assert.equal(res.inserted, 1);
  const rows = repo._listAll({ workspaceKey: WS });
  assert.equal(rows[0].modeConfirmedBy, 'bob', '重插行自带的新背书不被旧快照覆盖(幂等)');
  assert.equal(rows[0].modeConfirmedAt, '2026-08-01T00:00:00Z');
});

// ⑤ 跨月:确认行在 6 月,新行落 7 月(改购买日期)→ 业务键含 ws 不同,不 carry
test('L518 跨月:确认行删自 6 月、新行插 7 月 → 背书不跨月 carry(换月重判)', (t) => {
  const repo = openTmpRepo(t);
  const oldId = seedConfirmedRow(repo, { ws: '2026-06', receiptNo: 'R1', shop: 'S', purchaseDate: '2026-06-28', modeConfirmedAt: '2026-07-01T00:00:00Z', modeConfirmedBy: 'alice' });

  const res = repo.settleGroupAtomic({
    deletes: [{ workspaceKey: '2026-06', ids: [oldId] }],
    insertBuckets: [{ workspaceKey: '2026-07', rows: [newRow({ ws: '2026-07', receiptNo: 'R1', shop: 'S', purchaseDate: '2026-07-03' })] }],
  });
  assert.deepEqual(res, { removed: 1, inserted: 1, skipped: 0 });
  assert.equal(repo._listAll({ workspaceKey: '2026-06' }).length, 0, '6 月旧行已删');
  const julRows = repo._listAll({ workspaceKey: '2026-07' });
  assert.equal(julRows.length, 1, '7 月新行已入');
  assert.equal(julRows[0].modeConfirmedAt, null, '跨月不 carry 背书(换月=换上下文重判)');
});
