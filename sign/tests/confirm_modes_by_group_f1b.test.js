'use strict';

// F1b(2026-07-20):confirmModesByGroup 原 SQL 只认 tour_match_status='matched',漏掉两类命中票
// → 审核台点「确认」永久无效、组卡 needs_confirm。真 SQLite 集成测试锁死盖戳边界:
//   盖:matched / skipped_mode_not_required / 无团号(tour_no NULL + pending)
//   不盖:待匹配中间态(pending 但 tour_no 非空,等增量匹配)/ remedy 类(tour_not_found 走补救)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openMonthlyDatabase } = require('../lib/storage/monthly_database');
const { createDailyReceiptRepository } = require('../repositories/daily_receipt_repository');

const WS = '2026-01';
const BATCH = 'batch_f1b';
const GROUP = 'CL20260101-001';

function seedRow(repo, receiptNo, tourNo, tourMatchStatus) {
  repo.insertMany([{
    workspaceKey: WS, receiptNo, tourNo, tourMatchStatus,
    shop: '乐天免税店', purchaseDate: '2026-01-10',
    billMatchStatus: 'unmatched', rowHash: `h-${receiptNo}`, importedAt: 't', sourceType: 'workbench',
    sourceBatchId: BATCH, sourceCustomerId: GROUP,
  }]);
}

test('F1b confirmModesByGroup:盖 matched/skipped/无团号,不盖待匹配/remedy', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f1b-'));
  const db = openMonthlyDatabase({ dbPath: path.join(dir, 'monthly.sqlite') });
  const repo = createDailyReceiptRepository({ db });
  t.after(() => {
    try { db.close?.(); } catch { /* best-effort */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  seedRow(repo, 'R_matched', 'T1', 'matched');
  seedRow(repo, 'R_skipped', 'T2', 'skipped_mode_not_required');
  seedRow(repo, 'R_notour', null, 'pending');     // 无团号:normalizeTourNo('无')→''→NULL
  seedRow(repo, 'R_await', 'T4', 'pending');       // 待匹配:tour_no 非空,增量匹配未跑完
  seedRow(repo, 'R_remedy', 'T5', 'tour_not_found');

  const changed = repo.confirmModesByGroup({
    workspaceKey: WS, sourceBatchId: BATCH, sourceCustomerId: GROUP, operator: 'op1',
  });
  assert.equal(changed, 3, '盖戳 3 行:matched + skipped + 无团号');

  const byReceipt = new Map(repo._listAll({ workspaceKey: WS }).map((r) => [r.receiptNo, r]));
  const confirmed = (no) => Boolean(byReceipt.get(no)?.modeConfirmedAt ?? byReceipt.get(no)?.mode_confirmed_at);
  assert.ok(confirmed('R_matched'), 'matched 盖戳');
  assert.ok(confirmed('R_skipped'), 'skipped_mode_not_required 盖戳(渠道模式有、审核员确认)');
  assert.ok(confirmed('R_notour'), '无团号(tour_no NULL + pending)盖戳,组才能 settled');
  assert.ok(!confirmed('R_await'), '待匹配(pending 但 tour_no 非空)不盖,等增量匹配');
  assert.ok(!confirmed('R_remedy'), 'tour_not_found 不盖,走补救台');
});

test('F1b 幂等:二次 confirm 不重复盖(mode_confirmed_at IS NULL 守卫)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f1b2-'));
  const db = openMonthlyDatabase({ dbPath: path.join(dir, 'monthly.sqlite') });
  const repo = createDailyReceiptRepository({ db });
  t.after(() => {
    try { db.close?.(); } catch { /* best-effort */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  seedRow(repo, 'R1', 'T1', 'skipped_mode_not_required');
  assert.equal(repo.confirmModesByGroup({ workspaceKey: WS, sourceBatchId: BATCH, sourceCustomerId: GROUP, operator: 'op1' }), 1, '首次盖 1');
  assert.equal(repo.confirmModesByGroup({ workspaceKey: WS, sourceBatchId: BATCH, sourceCustomerId: GROUP, operator: 'op2' }), 0, '二次盖 0(已确认不重复)');
});
