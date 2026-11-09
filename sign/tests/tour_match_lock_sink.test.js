'use strict';

// 8模块审计 HIGH:批次级「导入台账」跑 tour_match 无锁,与结算路径的加锁路径并发互踩。
// 修法=把 per-workspace 串行锁下沉进 tourMatchService.run 内部,三条调用路径自动互斥。
// 本测试守卫这次重构:run 内联锁后仍正常工作(rename runImpl + wrapper + 去 approve_settle 外层 wrap)。
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

function makeService(t) {
  const db = new DatabaseSync(':memory:');
  runMigrations(db, MIGRATIONS, { logger: { info() {}, warn() {}, error() {} } });
  t.after(() => db.close());
  const dailyReceiptRepo = createDailyReceiptRepository({ db });
  const groupCodeRepo = createGroupCodeRepository({ db });
  const pendingReviewRepo = createPendingReviewRepository({ db });
  const errorRecordRepo = createErrorRecordRepository({ db });
  const svc = createTourMatchService({ dailyReceiptRepo, groupCodeRepo, pendingReviewRepo, errorRecordRepo });
  return { db, dailyReceiptRepo, svc };
}

test('锁下沉:同 workspace 两个并发 run 串行完成、状态一致(无锁则互删待审记录踩花)', async (t) => {
  const WS = '2026-07';
  const { db, dailyReceiptRepo, svc } = makeService(t);

  // 一行 pending 且团号查不到(99999999 不在团号表)→ 每次 run 都会清旧待审再重建 tour_not_found;
  // 同 ws 并发两次串行执行,终态必须是单份 open 记录(无锁会互删/重建踩花,数目漂移)。
  dailyReceiptRepo.insertMany([{
    workspaceKey: WS, receiptNo: 'R-1', shop: 'LOTTE', purchaseDate: '2026-07-01',
    name: 'N', passportNo: 'P1', rowHash: 'h1', importedAt: '2026-07-01T00:00:00.000Z',
    sourceType: 'imported', ledgerStatus: 'posted', tourMatchStatus: 'pending', tourNo: '99999999',
  }]);

  // 模拟「导入台账」与「确认即结算」同 ws 并发触发 run
  const [a, b] = await Promise.all([
    svc.run({ workspaceKey: WS, operator: 'import' }),
    svc.run({ workspaceKey: WS, operator: 'settle' }),
  ]);
  assert.equal(a.workspaceKey, WS);
  assert.equal(b.workspaceKey, WS);
  assert.equal(a.scanned, 1);

  // 终态一致:该行的 open pending_review 恰为 1 份(串行清-建;并发踩花会 >1 或 0)
  const openN = db
    .prepare("SELECT COUNT(1) AS n FROM pending_review WHERE workspace_key = ? AND status = 'open'")
    .get(WS).n;
  assert.equal(openN, 1, '同 ws 两次 run 串行后,待审记录恰为单份');
});

test('锁下沉:不同 workspace 的 run 各自完成(不互相阻塞)', async (t) => {
  const { dailyReceiptRepo, svc } = makeService(t);
  dailyReceiptRepo.insertMany([
    { workspaceKey: '2026-07', receiptNo: 'A', shop: 'LOTTE', purchaseDate: '2026-07-01',
      name: 'N', passportNo: 'PA', rowHash: 'ha', importedAt: '2026-07-01T00:00:00.000Z',
      sourceType: 'imported', ledgerStatus: 'posted', tourMatchStatus: 'pending' },
    { workspaceKey: '2026-08', receiptNo: 'B', shop: 'LOTTE', purchaseDate: '2026-08-01',
      name: 'N', passportNo: 'PB', rowHash: 'hb', importedAt: '2026-08-01T00:00:00.000Z',
      sourceType: 'imported', ledgerStatus: 'posted', tourMatchStatus: 'pending' },
  ]);
  const [a, b] = await Promise.all([
    svc.run({ workspaceKey: '2026-07' }),
    svc.run({ workspaceKey: '2026-08' }),
  ]);
  assert.equal(a.workspaceKey, '2026-07');
  assert.equal(b.workspaceKey, '2026-08');
  assert.equal(a.scanned, 1);
  assert.equal(b.scanned, 1);
});

test('run 缺 workspaceKey 仍抛错(锁包装不吞前置校验)', async (t) => {
  const { svc } = makeService(t);
  await assert.rejects(() => svc.run({}), /workspaceKey required/);
});
