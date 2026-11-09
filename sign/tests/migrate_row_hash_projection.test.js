'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openMonthlyDatabase } = require('../lib/storage/monthly_database');
const { createDailyReceiptRepository } = require('../repositories/daily_receipt_repository');
const { computeDailyRowHash } = require('../lib/monthly/daily_row_hash');
const { normalizeReceiptNoDigits } = require('../lib/workbench_field_normalizer');

// 审计L496:跨月迁移 migrateRow 原用原始 receipt_no 直接 computeDailyRowHash(无投影),而桥接
// dailyRowHashOf 对 DEPT/兜底(receiptNoHashProjection='digits')行用剥杠数字投影。两口径不一致 →
// ①碰撞检测(findByRowHashStmt)漏检,与桥接同票在目标月落两行双计;②迁移行 row_hash 与桥接约定
// 不符,后续桥接 INSERT OR IGNORE(UNIQUE ws,row_hash)也不撞→再产重复行。
// 修:migrateRow 从「源月存储 row_hash 匹配 hash(raw) 还是 hash(digits)」反推投影,对目标月施同一投影。

const SRC = '2026-05';
const TGT = '2026-06';

function openTmpRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-hash-'));
  const db = openMonthlyDatabase({ dbPath: path.join(dir, 'monthly.sqlite') });
  const repo = createDailyReceiptRepository({ db });
  t.after(() => {
    try { db.close?.(); } catch { /* best-effort */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });
  return repo;
}

// 模拟桥接以「数字投影」入库:receipt_no 存原样(带杠),row_hash 用剥杠数字算(DEPT/兜底行口径)
function seedDigitsRow(repo, { receiptNoRaw, shop, purchaseDate, ws = SRC }) {
  const digits = normalizeReceiptNoDigits(receiptNoRaw);
  const rowHash = computeDailyRowHash({ workspaceKey: ws, receiptNo: digits, purchaseDate, shop });
  repo.insertMany([{ workspaceKey: ws, receiptNo: receiptNoRaw, shop, purchaseDate, rowHash, importedAt: 't', sourceType: 'workbench' }]);
  return repo._listAll({ workspaceKey: ws }).find((r) => r.rowHash === rowHash);
}

test('L496: 数字投影行(带杠交易编号)跨月迁移 → 目标 row_hash 用数字投影(与桥接同口径)', (t) => {
  const repo = openTmpRepo(t);
  const row = seedDigitsRow(repo, { receiptNoRaw: '1234-5678-90', shop: 'LOTTE_DEPT', purchaseDate: '2026-05-10' });
  assert.ok(row, '种子行已入');

  const res = repo.migrateRow({ sourceWorkspaceKey: SRC, targetWorkspaceKey: TGT, dailyReceiptId: row.id, newPurchaseDate: '2026-06-10' });

  const digits = normalizeReceiptNoDigits('1234-5678-90');
  const expectDigits = computeDailyRowHash({ workspaceKey: TGT, receiptNo: digits, purchaseDate: '2026-06-10', shop: 'LOTTE_DEPT' });
  const expectRaw = computeDailyRowHash({ workspaceKey: TGT, receiptNo: '1234-5678-90', purchaseDate: '2026-06-10', shop: 'LOTTE_DEPT' });
  assert.equal(res.rowHash, expectDigits, '迁移行 hash 用数字投影(与桥接 dailyRowHashOf 一致)');
  assert.notEqual(res.rowHash, expectRaw, '不是修前的原样口径');
});

test('L496: 桥接已在目标月放同票(数字投影)→ 迁移数字投影行报 409 碰撞(修前漏检双计)', (t) => {
  const repo = openTmpRepo(t);
  const row = seedDigitsRow(repo, { receiptNoRaw: '1234-5678-90', shop: 'LOTTE_DEPT', purchaseDate: '2026-05-10' });
  // 桥接以数字投影在目标月放了同一张票(新月购买日)
  const digits = normalizeReceiptNoDigits('1234-5678-90');
  const targetHash = computeDailyRowHash({ workspaceKey: TGT, receiptNo: digits, purchaseDate: '2026-06-10', shop: 'LOTTE_DEPT' });
  repo.insertMany([{ workspaceKey: TGT, receiptNo: '1234-5678-90', shop: 'LOTTE_DEPT', purchaseDate: '2026-06-10', rowHash: targetHash, importedAt: 't', sourceType: 'workbench' }]);

  assert.throws(
    () => repo.migrateRow({ sourceWorkspaceKey: SRC, targetWorkspaceKey: TGT, dailyReceiptId: row.id, newPurchaseDate: '2026-06-10' }),
    (e) => e.code === 'target_row_hash_collision',
    '数字投影对齐后正确检出目标月已有同票(不再静默双计)',
  );
  assert.equal(repo._listAll({ workspaceKey: TGT }).length, 1, '碰撞时目标月仍只有 1 行(未双计)');
});

test('L496: raw 投影行(免税店带杠票号)跨月迁移 → 保持 raw,不与共享数字的 digits 行假碰撞', (t) => {
  const repo = openTmpRepo(t);
  // 免税店行:桥接存 raw hash(receipt_no 原样带杠,hash 也用原样)
  const rawReceipt = '0326-1635-00159';
  const rawHash = computeDailyRowHash({ workspaceKey: SRC, receiptNo: rawReceipt, purchaseDate: '2026-05-10', shop: 'THE SHILLA' });
  repo.insertMany([{ workspaceKey: SRC, receiptNo: rawReceipt, shop: 'THE SHILLA', purchaseDate: '2026-05-10', rowHash: rawHash, importedAt: 't', sourceType: 'workbench' }]);
  const row = repo._listAll({ workspaceKey: SRC }).find((r) => r.rowHash === rawHash);
  // 目标月放一个「数字相同但走 digits 投影」的不同票(hash 用剥杠数字)——不应与 raw 行碰撞
  const digits = normalizeReceiptNoDigits(rawReceipt);
  const digitsHash = computeDailyRowHash({ workspaceKey: TGT, receiptNo: digits, purchaseDate: '2026-06-10', shop: 'THE SHILLA' });
  repo.insertMany([{ workspaceKey: TGT, receiptNo: digits, shop: 'THE SHILLA', purchaseDate: '2026-06-10', rowHash: digitsHash, importedAt: 't', sourceType: 'workbench' }]);

  // raw 行迁移:推断为 raw 投影 → 目标 hash 用原样 → 与上面 digits 行不撞(不误 409)
  const res = repo.migrateRow({ sourceWorkspaceKey: SRC, targetWorkspaceKey: TGT, dailyReceiptId: row.id, newPurchaseDate: '2026-06-10' });
  const expectRaw = computeDailyRowHash({ workspaceKey: TGT, receiptNo: rawReceipt, purchaseDate: '2026-06-10', shop: 'THE SHILLA' });
  assert.equal(res.rowHash, expectRaw, 'raw 投影行保持原样口径(letters/dashed 免税店行不被误剥杠)');
  assert.equal(repo._listAll({ workspaceKey: TGT }).length, 2, '两张不同票各自在目标月(无假碰撞挡住合法迁移)');
});

test('L496: 纯数字票号(raw===digits)迁移无歧义,不受影响', (t) => {
  const repo = openTmpRepo(t);
  const receipt = '0326163500159'; // 无杠,raw===digits
  const rowHash = computeDailyRowHash({ workspaceKey: SRC, receiptNo: receipt, purchaseDate: '2026-05-10', shop: 'THE SHILLA' });
  repo.insertMany([{ workspaceKey: SRC, receiptNo: receipt, shop: 'THE SHILLA', purchaseDate: '2026-05-10', rowHash, importedAt: 't', sourceType: 'workbench' }]);
  const row = repo._listAll({ workspaceKey: SRC }).find((r) => r.rowHash === rowHash);

  const res = repo.migrateRow({ sourceWorkspaceKey: SRC, targetWorkspaceKey: TGT, dailyReceiptId: row.id, newPurchaseDate: '2026-06-10' });
  const expect = computeDailyRowHash({ workspaceKey: TGT, receiptNo: receipt, purchaseDate: '2026-06-10', shop: 'THE SHILLA' });
  assert.equal(res.rowHash, expect, '纯数字票号 raw===digits,两投影同哈希,迁移无歧义');
});

// 功能测试发现(2026-07-24):migrateRow 重置 bill_match=unmatched 却不清 conflict_fields →
// 目标月账单冲突复核队列(只按 conflict_fields 非空过滤,不看 bill_match_status)冒幽灵冲突。
// 修:migrateRowStmt SET 补 conflict_fields=NULL(照 sibling resetBillMatchStmt)。
test('迁移清 conflict_fields:目标月不冒幽灵账单冲突', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-conflict-'));
  const db = openMonthlyDatabase({ dbPath: path.join(dir, 'monthly.sqlite') });
  const repo = createDailyReceiptRepository({ db });
  t.after(() => {
    try { db.close?.(); } catch { /* best-effort */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  const row = seedDigitsRow(repo, { receiptNoRaw: '90112526006433', shop: 'LOTTE', purchaseDate: '2026-05-10' });
  // 源月这行本有账单字段冲突(conflict_fields 非空)
  db.prepare("UPDATE daily_receipt_export SET conflict_fields = ? WHERE id = ?")
    .run(JSON.stringify([{ field: 'net_usd', daily: 100, bill: 120 }]), row.id);
  assert.equal(repo.listBillReviewConflicts({ workspaceKey: SRC }).length, 1, '迁移前源月该行在冲突队列');

  repo.migrateRow({ sourceWorkspaceKey: SRC, targetWorkspaceKey: TGT, dailyReceiptId: row.id, newPurchaseDate: '2026-06-10' });

  assert.equal(repo.listBillReviewConflicts({ workspaceKey: TGT }).length, 0, '目标月无幽灵冲突(conflict_fields 已随 bill_match 重置清空)');
  assert.equal(repo.listBillReviewConflicts({ workspaceKey: SRC }).length, 0, '源月该行已迁走');
});
