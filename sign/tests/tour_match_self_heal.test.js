'use strict';

// 数据一致性回归:台账行经非-tour-match 路径变成 matched 后,上一轮留下的
// open pending_review + TM_ error_record 是孤儿,会让首页「阻塞项/待补救」与台账
// 实际状态对不上。tour-match 每次跑时应自愈清掉这些孤儿。
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { runMigrations } = require('../lib/storage/migration_runner');
const { createDailyReceiptRepository } = require('../repositories/daily_receipt_repository');
const { createGroupCodeRepository } = require('../repositories/group_code_repository');
const { createPendingReviewRepository } = require('../repositories/pending_review_repository');
const { createErrorRecordRepository } = require('../repositories/error_record_repository');
const { createTourMatchService } = require('../services/monthly/tour_match_service');

const MIGRATIONS = path.join(__dirname, '..', 'lib', 'storage', 'migrations');
const WS = '2026-01';

test('tour-match 自愈:已 matched 台账行的陈旧 pending / TM error 被清,matched 不被打回', async (t) => {
  const db = new DatabaseSync(':memory:');
  runMigrations(db, MIGRATIONS, { logger: { info() {}, warn() {}, error() {} } });
  t.after(() => db.close());

  const dailyReceiptRepo = createDailyReceiptRepository({ db });
  const groupCodeRepo = createGroupCodeRepository({ db });
  const pendingReviewRepo = createPendingReviewRepository({ db });
  const errorRecordRepo = createErrorRecordRepository({ db });

  // 一行「已 matched」的台账(模拟手工补救/重分类把它设成 matched)
  dailyReceiptRepo.insertMany([{
    workspaceKey: WS, receiptNo: 'R-1', shop: 'THE SHILLA', purchaseDate: '2026-01-15',
    name: 'N', passportNo: 'P1', rowHash: 'h1', importedAt: '2026-01-01T00:00:00.000Z',
    sourceType: 'imported', ledgerStatus: 'posted', tourMatchStatus: 'matched',
  }]);
  const row = dailyReceiptRepo._listAll({ workspaceKey: WS })[0];

  // 制造陈旧孤儿:open pending + TM error 指向这行(它现在已 matched)
  pendingReviewRepo.insertMany([{
    workspaceKey: WS, sourceTable: 'daily_receipt_export', sourceId: row.id,
    reasonType: 'tour_not_found', detail: { stale: true }, status: 'open', createdAt: 't',
  }]);
  errorRecordRepo.insertMany([{
    workspaceKey: WS, errorType: 'TM_TOUR_NOT_FOUND', receiptNo: 'R-1', tourNo: 'T1',
    detectedAt: '2026-01-01T00:00:00.000Z',
  }]);
  assert.equal(
    db.prepare("SELECT COUNT(1) AS n FROM error_record WHERE workspace_key = ? AND status = 'open'").get(WS).n,
    1,
    '前置:物理表里有 1 条陈旧 TM error',
  );
  assert.equal(
    errorRecordRepo.countByType(WS).filter((e) => String(e.error_type || '').startsWith('TM_')).length,
    0,
    '陈旧 TM error 不应再计入首页阻塞项',
  );
  assert.equal(
    db.prepare("SELECT COUNT(1) AS n FROM pending_review WHERE workspace_key = ? AND status = 'open'").get(WS).n,
    1,
    '前置:物理表里有 1 条陈旧 pending',
  );
  assert.equal(pendingReviewRepo.countOpen(WS), 0, '陈旧 pending 不应再计入待人工确认');

  // 跑团号匹配(group_code 空)→ 自愈应清掉孤儿
  const svc = createTourMatchService({ dailyReceiptRepo, groupCodeRepo, pendingReviewRepo, errorRecordRepo });
  await svc.run({ workspaceKey: WS });

  assert.equal(pendingReviewRepo.countOpen(WS), 0, '陈旧 pending 应被清');
  assert.equal(
    db.prepare("SELECT COUNT(1) AS n FROM pending_review WHERE workspace_key = ? AND status = 'open'").get(WS).n,
    0,
    '陈旧 pending 应从物理表清掉',
  );
  const tmErrors = errorRecordRepo.countByType(WS) || [];
  assert.ok(
    !tmErrors.some((e) => String(e.error_type ?? e.errorType ?? '').startsWith('TM')),
    'TM error 应被清',
  );
  const after = dailyReceiptRepo._listAll({ workspaceKey: WS })[0];
  assert.equal(after.tourMatchStatus, 'matched', 'matched 行不应被打回 pending');
});

test('百货P4:空团号+百货常量保模式收口 matched;非百货残留模式照旧清空强制人工', async (t) => {
  const db = new DatabaseSync(':memory:');
  runMigrations(db, MIGRATIONS, { logger: { info() {}, warn() {}, error() {} } });
  t.after(() => db.close());

  const dailyReceiptRepo = createDailyReceiptRepository({ db });
  const groupCodeRepo = createGroupCodeRepository({ db });
  const pendingReviewRepo = createPendingReviewRepository({ db });
  const errorRecordRepo = createErrorRecordRepository({ db });

  dailyReceiptRepo.insertMany([
    // 百货行被 reset 打回 pending(换表重跑场景):模式常量必须保住
    {
      workspaceKey: WS, receiptNo: '12345678', shop: 'LOTTE_DEPT', purchaseDate: '2026-07-01',
      name: 'N1', passportNo: 'P1', rowHash: 'dept1', importedAt: '2026-07-08T00:00:00.000Z',
      sourceType: 'workbench', ledgerStatus: 'posted',
      tourMatchStatus: 'pending', modeRaw: '乐天百货',
    },
    // 对照:空团号且无模式 → 维持 pending 原行为
    {
      workspaceKey: WS, receiptNo: 'R-CTRL', shop: 'LOTTE', purchaseDate: '2026-07-01',
      name: 'N2', passportNo: 'P2', rowHash: 'ctrl1', importedAt: '2026-07-08T00:00:00.000Z',
      sourceType: 'imported', ledgerStatus: 'posted', tourMatchStatus: 'pending',
    },
  ]);

  const svc = createTourMatchService({ dailyReceiptRepo, groupCodeRepo, pendingReviewRepo, errorRecordRepo });
  await svc.run({ workspaceKey: WS });

  const rows = dailyReceiptRepo._listAll({ workspaceKey: WS });
  const dept = rows.find((r) => r.receiptNo === '12345678');
  const ctrl = rows.find((r) => r.receiptNo === 'R-CTRL');
  assert.equal(dept.modeRaw, '乐天百货', '百货模式常量不得被空团号分支清空');
  assert.equal(dept.tourMatchStatus, 'matched', '模式已定的行收口 matched,不再永远 pending');
  assert.equal(ctrl.tourMatchStatus, 'pending', '空团号无模式的行维持 pending 原行为');
  assert.ok(!ctrl.modeRaw, '对照行模式仍空');
});

test('百货P4边界:空团号+非百货残留模式(陈旧复合键)→ 照旧清空维持 pending,不自动救', async (t) => {
  const db = new DatabaseSync(':memory:');
  runMigrations(db, MIGRATIONS, { logger: { info() {}, warn() {}, error() {} } });
  t.after(() => db.close());

  const dailyReceiptRepo = createDailyReceiptRepository({ db });
  const groupCodeRepo = createGroupCodeRepository({ db });
  const pendingReviewRepo = createPendingReviewRepository({ db });
  const errorRecordRepo = createErrorRecordRepository({ db });

  dailyReceiptRepo.insertMany([{
    workspaceKey: WS, receiptNo: 'R-STALE', shop: 'LOTTE', purchaseDate: '2026-07-01',
    name: 'N', passportNo: 'P', rowHash: 'stale1', importedAt: '2026-07-08T00:00:00.000Z',
    sourceType: 'imported', ledgerStatus: 'posted',
    tourMatchStatus: 'pending', modeRaw: '乐天SG-本司', // 上轮失败残留的非百货模式
  }]);

  const svc = createTourMatchService({ dailyReceiptRepo, groupCodeRepo, pendingReviewRepo, errorRecordRepo });
  await svc.run({ workspaceKey: WS });

  const row = dailyReceiptRepo._listAll({ workspaceKey: WS })[0];
  assert.equal(row.tourMatchStatus, 'pending', '非百货残留模式不得自动收口 matched(强制人工再判)');
});

// B2/M4(2026-07-16 同步一致性审计):自愈只清 tour 类,绝不连带删同行的 second_pass_candidate
test('自愈越界修复:matched 行上的 open second_pass_candidate 不被 tour-match 扫掉', async (t) => {
  const db = new DatabaseSync(':memory:');
  runMigrations(db, MIGRATIONS, { logger: { info() {}, warn() {}, error() {} } });
  t.after(() => db.close());

  const dailyReceiptRepo = createDailyReceiptRepository({ db });
  const groupCodeRepo = createGroupCodeRepository({ db });
  const pendingReviewRepo = createPendingReviewRepository({ db });
  const errorRecordRepo = createErrorRecordRepository({ db });

  // tour matched + bill unmatched 的行,second_pass 给它立了二次候选
  dailyReceiptRepo.insertMany([{
    workspaceKey: WS, receiptNo: 'R-SP', shop: 'THE SHILLA', purchaseDate: '2026-01-15',
    name: 'N', passportNo: 'P9', rowHash: 'hsp', importedAt: '2026-01-01T00:00:00.000Z',
    sourceType: 'imported', ledgerStatus: 'posted', tourMatchStatus: 'matched', billMatchStatus: 'unmatched',
  }]);
  const row = dailyReceiptRepo._listAll({ workspaceKey: WS }).find((r) => r.receiptNo === 'R-SP');
  pendingReviewRepo.insertMany([
    { workspaceKey: WS, sourceTable: 'daily_receipt_export', sourceId: row.id,
      reasonType: 'second_pass_candidate', detail: { candidates: [{ billId: 1 }] }, status: 'open', createdAt: 't' },
    { workspaceKey: WS, sourceTable: 'daily_receipt_export', sourceId: row.id,
      reasonType: 'tour_not_found', detail: { stale: true }, status: 'open', createdAt: 't' },
  ]);

  const svc = createTourMatchService({ dailyReceiptRepo, groupCodeRepo, pendingReviewRepo, errorRecordRepo });
  await svc.run({ workspaceKey: WS });

  const remain = pendingReviewRepo.list({ workspaceKey: WS, status: 'open', limit: 10 });
  assert.deepEqual(remain.map((r) => r.reasonType), ['second_pass_candidate'],
    'tour 类孤儿被清,second_pass_candidate 必须幸存(此前被连带删=账单候选提示静默消失)');
});
