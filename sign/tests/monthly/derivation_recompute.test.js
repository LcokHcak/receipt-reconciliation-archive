'use strict';

// 派生新鲜度状态机 + 按需重算编排。验证:上游变更标脏(取最浅)、阶段跑完推进
// (downstream 变脏 / 更浅保留)、ensureFresh 从脏阶段跑到 merge 清零。
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { runMigrations } = require('../../lib/storage/migration_runner');
const { createMonthlyWorkspaceRepository } = require('../../repositories/monthly_workspace_repository');
const { createDerivationRecomputeService } = require('../../services/monthly/derivation_recompute_service');
const { afterStageRun, shallower, stagesToRun } = require('../../lib/monthly_pipeline/derivation_stages');

const MIGRATIONS = path.join(__dirname, '..', '..', 'lib', 'storage', 'migrations');
const WS = '2026-01';

function setup(t) {
  const db = new DatabaseSync(':memory:');
  runMigrations(db, MIGRATIONS, { logger: { info() {}, warn() {}, error() {} } });
  db.exec(`INSERT INTO monthly_workspace (workspace_key, year, month, status, created_at, updated_at)
           VALUES ('${WS}', 2026, 1, 'open', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`);
  t.after(() => db.close());
  const workspaceRepo = createMonthlyWorkspaceRepository({ db });
  // ensureFresh 只读 monthlyDataRepo.countByWorkspace,用可控 stub(避免造完整 monthly_data 行)
  const monthlyData = { count: 0 };
  const monthlyDataRepo = { countByWorkspace: () => monthlyData.count };
  const ran = [];
  const stub = (name) => ({ run: async () => { ran.push(name); } });
  const svc = createDerivationRecomputeService({
    workspaceRepo, monthlyDataRepo,
    tourMatchService: stub('tour_match'),
    billMatchService: stub('bill_match'),
    mergeService: stub('merge'),
  });
  const markGenerated = () => { monthlyData.count = 1; };
  return { db, workspaceRepo, monthlyDataRepo, svc, ran, markGenerated };
}

test('纯状态机:shallower / afterStageRun / stagesToRun', () => {
  assert.equal(shallower('merge', 'tour_match'), 'tour_match');
  assert.equal(shallower(null, 'bill_match'), 'bill_match');
  // 手点 bill_match(无脏)→ merge 变脏(匹配变了合并过期)
  assert.equal(afterStageRun(null, 'bill_match'), 'merge');
  // 改了模式(脏=tour)却只手点 bill → 仍 tour(tour 没重跑)
  assert.equal(afterStageRun('tour_match', 'bill_match'), 'tour_match');
  // 跑完 merge → 新鲜
  assert.equal(afterStageRun('merge', 'merge'), null);
  assert.deepEqual(stagesToRun('bill_match'), ['bill_match', 'merge']);
  assert.deepEqual(stagesToRun(null), []);
});

test('markDirty 取最浅;扣点(merge)后再改模式(tour)→ 升到 tour', (t) => {
  const { svc } = setup(t);
  assert.equal(svc.markDirty(WS, 'merge'), 'merge');
  assert.equal(svc.markDirty(WS, 'tour_match'), 'tour_match', '更浅覆盖');
  assert.equal(svc.markDirty(WS, 'merge'), 'tour_match', '更深不动');
});

test('ensureFresh:脏=merge(改扣点)只重跑 merge', async (t) => {
  const { svc, ran, markGenerated } = setup(t);
  // 制造"已生成过"(monthly_data 非空)避免被当首次
  markGenerated();
  svc.markDirty(WS, 'merge');
  const res = await svc.ensureFresh({ workspaceKey: WS });
  assert.deepEqual(res.ran, ['merge'], '改扣点不该重跑昂贵的 bill_match');
  assert.deepEqual(ran, ['merge']);
  assert.equal(svc.getDirtyFrom(WS), null, '跑完清零');
});

test('ensureFresh:脏=tour(改模式)重跑全链 tour→bill→merge', async (t) => {
  const { svc, markGenerated } = setup(t);
  markGenerated();
  svc.markDirty(WS, 'tour_match');
  const res = await svc.ensureFresh({ workspaceKey: WS });
  assert.deepEqual(res.ran, ['tour_match', 'bill_match', 'merge']);
  assert.equal(svc.getDirtyFrom(WS), null);
});

test('ensureFresh:从没生成过(monthly_data 空)→ 至少跑 merge', async (t) => {
  const { svc } = setup(t);
  assert.equal(svc.isStale(WS), true, '空库视为 stale');
  const res = await svc.ensureFresh({ workspaceKey: WS });
  assert.ok(res.ran.includes('merge'));
});

test('ensureFresh:新鲜且已生成 → no-op', async (t) => {
  const { svc, ran, markGenerated } = setup(t);
  markGenerated();
  const res = await svc.ensureFresh({ workspaceKey: WS });
  assert.deepEqual(res.ran, []);
  assert.deepEqual(ran, []);
});
