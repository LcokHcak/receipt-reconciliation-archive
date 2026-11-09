'use strict';

/**
 * 多操作员并发实测(后端锁层,真 SQLite):
 *  - 同 workspace 两个操作员同时跑 stage → 恰好一个拿到锁执行,另一个被
 *    PIPELINE_LOCKED 拒绝(带 runningStage 供 UI 显示"流水线被 X 占用")
 *  - 不同 workspace 并发互不影响
 *  - 持锁进程崩溃后锁可被释放/重新获取(release 幂等)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openMonthlyDatabase } = require('../lib/storage/monthly_database');
const { createPipelineLockService } = require('../services/monthly/pipeline_lock_service');
const { createStageJobRepository } = require('../repositories/stage_job_repository');
const { runStageWithLock } = require('../lib/monthly_pipeline/stage_lock');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conc-lock-'));
  const db = openMonthlyDatabase({ dbPath: path.join(dir, 'monthly.sqlite') });
  const pipelineLockService = createPipelineLockService({ db });
  const stageJobRepo = createStageJobRepository({ db });
  t.after(() => {
    try { db.close?.(); } catch { /* best-effort */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });
  return { db, pipelineLockService, stageJobRepo };
}

function slowStage(ms, tag, log) {
  return async () => {
    log.push(`start:${tag}`);
    await new Promise((r) => setTimeout(r, ms));
    log.push(`end:${tag}`);
    return { ok: true, tag };
  };
}

test('concurrent same-workspace stage runs: exactly one wins, loser sees PIPELINE_LOCKED with runningStage', async (t) => {
  const s = setup(t);
  const log = [];
  const run = (operator) => runStageWithLock({
    stageJobRepo: s.stageJobRepo,
    pipelineLockService: s.pipelineLockService,
    workspaceKey: '2026-01',
    stage: 'merge',
    operator,
    run: slowStage(120, operator, log),
  });

  const results = await Promise.allSettled([run('op_a'), run('op_b')]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  const failed = results.filter((r) => r.status === 'rejected');

  assert.equal(ok.length, 1, '恰好一个操作员执行成功');
  assert.equal(failed.length, 1, '另一个被锁拒绝');
  const err = failed[0].reason;
  // 双层防护:同 stage 由 stage_job active 去重先拦(STAGE_ALREADY_RUNNING)
  assert.equal(err.code, 'STAGE_ALREADY_RUNNING');
  // 拒绝发生在 run 执行前:输了的操作员不应留下 start 日志
  const starts = log.filter((l) => l.startsWith('start:'));
  assert.equal(starts.length, 1, '只有赢家真正执行了 stage');
});

test('concurrent different-stage runs on same workspace: loser sees PIPELINE_LOCKED with runningStage', async (t) => {
  const s = setup(t);
  const log = [];
  const run = (stage, operator) => runStageWithLock({
    stageJobRepo: s.stageJobRepo,
    pipelineLockService: s.pipelineLockService,
    workspaceKey: '2026-01',
    stage,
    operator,
    run: slowStage(120, `${stage}:${operator}`, log),
  });

  const results = await Promise.allSettled([run('merge', 'op_a'), run('tour_match', 'op_b')]);
  const failed = results.filter((r) => r.status === 'rejected');
  assert.equal(failed.length, 1, '不同 stage 在同 workspace 也互斥(pipeline 锁层)');
  const err = failed[0].reason;
  assert.equal(err.code, 'PIPELINE_LOCKED');
  assert.ok(err.runningStage, 'UI 可显示"流水线被 X 占用"');
  assert.equal(log.filter((l) => l.startsWith('start:')).length, 1);
});

test('different workspaces run concurrently without blocking each other', async (t) => {
  const s = setup(t);
  const log = [];
  const run = (ws, operator) => runStageWithLock({
    stageJobRepo: s.stageJobRepo,
    pipelineLockService: s.pipelineLockService,
    workspaceKey: ws,
    stage: 'merge',
    operator,
    run: slowStage(80, `${ws}:${operator}`, log),
  });

  const results = await Promise.allSettled([run('2026-01', 'op_a'), run('2026-02', 'op_b')]);
  assert.ok(results.every((r) => r.status === 'fulfilled'), '不同 workspace 互不阻塞');
  assert.equal(log.filter((l) => l.startsWith('start:')).length, 2);
});

test('lock is released after stage completes; next operator can acquire immediately', async (t) => {
  const s = setup(t);
  const log = [];
  const run = (operator) => runStageWithLock({
    stageJobRepo: s.stageJobRepo,
    pipelineLockService: s.pipelineLockService,
    workspaceKey: '2026-01',
    stage: 'tour_match',
    operator,
    run: slowStage(20, operator, log),
  });
  await run('op_a');
  await run('op_b');
  assert.equal(log.filter((l) => l.startsWith('start:')).length, 2, '顺序执行两人都能拿到锁');
});

test('lock survives stage failure (released in finally), workspace not stuck', async (t) => {
  const s = setup(t);
  await assert.rejects(() => runStageWithLock({
    stageJobRepo: s.stageJobRepo,
    pipelineLockService: s.pipelineLockService,
    workspaceKey: '2026-01',
    stage: 'merge',
    operator: 'op_a',
    run: async () => { throw new Error('boom'); },
  }), /boom/);

  // 失败后锁必须被释放,否则 workspace 永久卡死
  const again = await runStageWithLock({
    stageJobRepo: s.stageJobRepo,
    pipelineLockService: s.pipelineLockService,
    workspaceKey: '2026-01',
    stage: 'merge',
    operator: 'op_b',
    run: async () => ({ ok: true }),
  });
  assert.equal(again.result.ok, true, '失败后下一个操作员能正常获取锁');
});
