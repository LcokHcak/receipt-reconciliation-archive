'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  pickChangedBatchIds,
  refreshChangedBatches,
  createProjectionRefreshScheduler,
} = require('../lib/agent_workspace/projection_refresh');

test('pickChangedBatchIds:只挑 mtime >= sinceMs 的批次', () => {
  const mtimes = { a: 100, b: 200, c: 300 };
  const mtimeOf = (id) => mtimes[id];
  assert.deepEqual(pickChangedBatchIds({ batchIds: ['a', 'b', 'c'], mtimeOf, sinceMs: 200 }), ['b', 'c']);
  assert.deepEqual(pickChangedBatchIds({ batchIds: ['a', 'b', 'c'], mtimeOf, sinceMs: 0 }), ['a', 'b', 'c'], 'since<=0=全算改过');
  assert.deepEqual(pickChangedBatchIds({ batchIds: ['a'], mtimeOf, sinceMs: 999 }), []);
});

test('pickChangedBatchIds:stat 抛错的批次跳过(不炸)', () => {
  const mtimeOf = (id) => { if (id === 'bad') throw new Error('ENOENT'); return 500; };
  assert.deepEqual(pickChangedBatchIds({ batchIds: ['bad', 'ok'], mtimeOf, sinceMs: 100 }), ['ok']);
  assert.deepEqual(pickChangedBatchIds({ batchIds: ['x'], mtimeOf: null, sinceMs: 0 }), []);
});

test('refreshChangedBatches:load 改动批次并 syncBatches', () => {
  const loaded = [];
  const synced = [];
  const res = refreshChangedBatches({
    changedBatchIds: ['b1', 'b2'],
    loadBatch: (id) => { loaded.push(id); return { id }; },
    syncBatches: (batches) => { synced.push(...batches.map((b) => b.id)); },
  });
  assert.deepEqual(loaded, ['b1', 'b2']);
  assert.deepEqual(synced, ['b1', 'b2']);
  assert.deepEqual(res, { synced: 2, failedLoad: 0, syncError: false });
});

test('refreshChangedBatches:空列表=no-op;load 失败被隔离仍同步其余', () => {
  assert.deepEqual(refreshChangedBatches({ changedBatchIds: [] }), { synced: 0, failedLoad: 0, syncError: false });
  const synced = [];
  const res = refreshChangedBatches({
    changedBatchIds: ['ok', 'bad', 'ok2'],
    loadBatch: (id) => { if (id === 'bad') throw new Error('corrupt'); return { id }; },
    syncBatches: (batches) => synced.push(...batches.map((b) => b.id)),
  });
  assert.deepEqual(synced, ['ok', 'ok2'], '坏批次跳过,好的照常同步');
  assert.equal(res.failedLoad, 1);
  assert.equal(res.synced, 2);
});

test('refreshChangedBatches:syncBatches 抛错被吞(不炸定时器)', () => {
  const res = refreshChangedBatches({
    changedBatchIds: ['b1'],
    loadBatch: (id) => ({ id }),
    syncBatches: () => { throw new Error('db locked'); },
  });
  assert.equal(res.syncError, true);
  assert.equal(res.synced, 0);
});

test('scheduler:重入守卫——上一轮没跑完,下一轮跳过;跑完后能再跑', async () => {
  let active = 0;
  let maxConcurrent = 0;
  let runs = 0;
  let release = null;
  let blockNext = true; // 只让第一轮卡住,便于验证重入守卫
  const sched = createProjectionRefreshScheduler({
    runOnce: async () => {
      runs += 1; active += 1; maxConcurrent = Math.max(maxConcurrent, active);
      if (blockNext) await new Promise((r) => { release = r; });
      active -= 1;
    },
    intervalMs: 1000,
  });
  const p1 = sched.tickNow(); // 第一轮:卡住(running=true 同步置位)
  await sched.tickNow(); // 第二轮:running=true → 跳过,不进 runOnce
  assert.equal(runs, 1, '第二轮被重入守卫挡下');
  blockNext = false;
  release(); // 放行第一轮
  await p1;
  assert.equal(sched.isRunning(), false, '第一轮完成后 running 复位');
  await sched.tickNow(); // 第三轮:可跑(不再卡)
  assert.equal(runs, 2, '前一轮跑完后能再跑');
  assert.equal(maxConcurrent, 1, '任意时刻只一轮在跑');
});

test('scheduler:runOnce 抛错不炸定时器,下一轮照跑', async () => {
  let runs = 0;
  const sched = createProjectionRefreshScheduler({
    runOnce: async () => { runs += 1; throw new Error('boom'); },
  });
  await sched.tickNow();
  await sched.tickNow();
  assert.equal(runs, 2, '抛错后 running 复位,下一轮仍跑');
  assert.equal(sched.isRunning(), false);
});

test('scheduler:intervalMs<=0 = 禁用(不注册定时器)', () => {
  let started = 0;
  const sched = createProjectionRefreshScheduler({
    runOnce: () => {},
    intervalMs: 0,
    setIntervalFn: () => { started += 1; return { unref() {} }; },
  });
  sched.start();
  assert.equal(started, 0, 'intervalMs=0 不启动定时器');
});

test('scheduler:start 注册定时器 + stop 清除;unref 防止阻塞退出', () => {
  const timers = [];
  let cleared = 0;
  const sched = createProjectionRefreshScheduler({
    runOnce: () => {},
    intervalMs: 5000,
    setIntervalFn: (fn, ms) => { const t = { fn, ms, unref() { this.unrefed = true; } }; timers.push(t); return t; },
    clearIntervalFn: () => { cleared += 1; },
  });
  sched.start();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 5000);
  assert.equal(timers[0].unrefed, true, 'unref 了');
  sched.start(); // 幂等:不重复注册
  assert.equal(timers.length, 1);
  sched.stop();
  assert.equal(cleared, 1);
});
