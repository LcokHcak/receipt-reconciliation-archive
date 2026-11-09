'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openMonthlyDatabase } = require('../../lib/storage/monthly_database');
const { createGroupCodeRepository } = require('../../repositories/group_code_repository');
const { createDailyReceiptRepository } = require('../../repositories/daily_receipt_repository');
const { createPendingReviewRepository } = require('../../repositories/pending_review_repository');
const { createErrorRecordRepository } = require('../../repositories/error_record_repository');
const { createTourMatchService } = require('../../services/monthly/tour_match_service');

const WS = '2026-01';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-rerun-'));
  const db = openMonthlyDatabase({ dbPath: path.join(dir, 'monthly.sqlite') });
  const groupCodeRepo = createGroupCodeRepository({ db });
  const dailyReceiptRepo = createDailyReceiptRepository({ db });
  const pendingReviewRepo = createPendingReviewRepository({ db });
  const errorRecordRepo = createErrorRecordRepository({ db });
  t.after(() => {
    try { db.close?.(); } catch { /* best effort */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
  return { db, groupCodeRepo, dailyReceiptRepo, pendingReviewRepo, errorRecordRepo };
}

const count = (db, sql, ...a) => Number(db.prepare(sql).get(...a).c);

test('tour_match 重跑前清掉这批行旧的 TM 阻塞项/待补救,不累积', async (t) => {
  const s = setup(t);
  // 一条待匹配行,团号不在团号表 → 会判 tour_not_found
  s.dailyReceiptRepo.insertMany([{
    workspaceKey: WS, receiptNo: 'R-X', tourNo: 'X999',
    name: 'A', passportNo: 'P1', shop: 'lotte', purchaseDate: '2026-01-14',
    rowHash: 'd1', importedAt: 't',
  }]);
  const dailyId = Number(s.db.prepare('SELECT id FROM daily_receipt_export WHERE workspace_key=?').get(WS).id);

  // 预置「上一轮残留」:2 条 stale TM 错误 + 1 条 stale 待补救,指向这条行
  s.errorRecordRepo.insertMany([
    { workspaceKey: WS, errorType: 'TM_TOUR_NOT_FOUND', receiptNo: 'R-X', status: 'open', detectedAt: 'old1' },
    { workspaceKey: WS, errorType: 'TM_TOUR_NOT_FOUND', receiptNo: 'R-X', status: 'open', detectedAt: 'old2' },
  ]);
  s.pendingReviewRepo.insertMany([
    { workspaceKey: WS, sourceTable: 'daily_receipt_export', sourceId: dailyId,
      reasonType: 'tour_not_found', status: 'open', createdAt: 'old' },
  ]);

  assert.equal(count(s.db, "SELECT COUNT(*) c FROM error_record WHERE workspace_key=? AND error_type LIKE 'TM%'", WS), 2);
  assert.equal(count(s.db, 'SELECT COUNT(*) c FROM pending_review WHERE workspace_key=? AND source_id=?', WS, dailyId), 1);

  const svc = createTourMatchService({
    dailyReceiptRepo: s.dailyReceiptRepo,
    groupCodeRepo: s.groupCodeRepo,
    pendingReviewRepo: s.pendingReviewRepo,
    errorRecordRepo: s.errorRecordRepo,
  });
  const result = await svc.run({ workspaceKey: WS });
  assert.equal(result.tourNotFound, 1);

  // 重跑后:旧的 2 条 stale + 1 待补救被清,只剩本轮新生成的各 1 条(不累积成 3 / 2)。
  assert.equal(
    count(s.db, "SELECT COUNT(*) c FROM error_record WHERE workspace_key=? AND error_type LIKE 'TM%'", WS),
    1, 'TM 错误应只剩本轮 1 条,不累积',
  );
  assert.equal(
    count(s.db, 'SELECT COUNT(*) c FROM pending_review WHERE workspace_key=? AND source_id=?', WS, dailyId),
    1, '待补救应只剩本轮 1 条',
  );
});

test('deleteOpenByReceiptNos / deleteOpenBySourceIds 空集是 no-op', (t) => {
  const s = setup(t);
  assert.equal(s.errorRecordRepo.deleteOpenByReceiptNos({ workspaceKey: WS, receiptNos: [] }), 0);
  assert.equal(s.pendingReviewRepo.deleteOpenBySourceIds({ workspaceKey: WS, sourceIds: [] }), 0);
});

test('tour_match stale cleanup chunks very large id lists under SQLite variable limits', (t) => {
  const s = setup(t);
  s.errorRecordRepo.insertMany([
    { workspaceKey: WS, errorType: 'TM_TOUR_NOT_FOUND', receiptNo: 'R-39999', status: 'open', detectedAt: 'old' },
  ]);
  s.pendingReviewRepo.insertMany([
    {
      workspaceKey: WS,
      sourceTable: 'daily_receipt_export',
      sourceId: 39999,
      reasonType: 'tour_not_found',
      status: 'open',
      createdAt: 'old',
    },
  ]);

  const manyReceiptNos = Array.from({ length: 40000 }, (_, i) => `R-${i}`);
  const manySourceIds = Array.from({ length: 40000 }, (_, i) => i);

  assert.equal(
    s.errorRecordRepo.deleteOpenByReceiptNos({ workspaceKey: WS, receiptNos: manyReceiptNos }),
    1,
  );
  assert.equal(
    s.pendingReviewRepo.deleteOpenBySourceIds({ workspaceKey: WS, sourceIds: manySourceIds }),
    1,
  );
  assert.equal(count(s.db, 'SELECT COUNT(*) c FROM error_record WHERE workspace_key=?', WS), 0);
  assert.equal(count(s.db, 'SELECT COUNT(*) c FROM pending_review WHERE workspace_key=?', WS), 0);
});
