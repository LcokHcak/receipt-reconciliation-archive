const test = require('node:test');
const assert = require('node:assert/strict');

const { createWorkbenchScheduler } = require('../jobs/workbench_scheduler');

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function nextImmediate() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('workbench scheduler queues batches behind a global concurrency limit', async () => {
  const first = deferred();
  const second = deferred();
  const started = [];
  const scheduler = createWorkbenchScheduler({
    maxConcurrentBatches: 1,
    processBatch: async (batchId) => {
      started.push(batchId);
      if (batchId === 'batch-1') {
        await first.promise;
      } else {
        await second.promise;
      }
    },
  });

  scheduler.scheduleBatch('batch-1');
  scheduler.scheduleBatch('batch-2');
  scheduler.scheduleBatch('batch-2');
  await nextImmediate();

  assert.deepEqual(started, ['batch-1']);
  assert.deepEqual([...scheduler.activeBatches], ['batch-1']);
  assert.deepEqual(scheduler.pendingBatches, ['batch-2']);

  first.resolve();
  await nextImmediate();
  await nextImmediate();

  assert.deepEqual(started, ['batch-1', 'batch-2']);
  second.resolve();
});

test('workbench scheduler defers and coalesces queue drains to keep request handlers responsive', async () => {
  const deferredRuns = [];
  const started = [];
  const scheduler = createWorkbenchScheduler({
    maxConcurrentBatches: 2,
    deferRun: (run) => deferredRuns.push(run),
    processBatch: async (batchId) => {
      started.push(batchId);
    },
  });

  scheduler.scheduleBatch('batch-1');
  scheduler.scheduleBatch('batch-2');
  scheduler.scheduleBatch('batch-3');

  assert.deepEqual(started, []);
  assert.equal(deferredRuns.length, 1);
  assert.deepEqual(scheduler.pendingBatches, ['batch-1', 'batch-2', 'batch-3']);

  deferredRuns.shift()();
  assert.deepEqual([...scheduler.activeBatches], ['batch-1', 'batch-2']);
  assert.deepEqual(scheduler.pendingBatches, ['batch-3']);

  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(started, ['batch-1', 'batch-2']);
});

test('priority 插队:操作员批次排到补识别批次前面;已在队中的也能提到队首', async () => {
  // 2026-07-03 生产事故:5000+ 后台补识别把 FIFO 占满,新上传"等待识别"卡一个多小时。
  const gate = deferred();
  const started = [];
  const scheduler = createWorkbenchScheduler({
    maxConcurrentBatches: 1,
    processBatch: async (batchId) => {
      started.push(batchId);
      if (batchId === 'repair-0') await gate.promise; // 占住唯一槽位
    },
  });

  scheduler.scheduleBatch('repair-0');
  scheduler.scheduleBatch('repair-1');
  scheduler.scheduleBatch('repair-2');
  await nextImmediate();
  assert.deepEqual(scheduler.pendingBatches, ['repair-1', 'repair-2']);

  // 操作员新上传 → 插队到队首
  scheduler.scheduleBatch('operator-new', { priority: true });
  assert.deepEqual(scheduler.pendingBatches, ['operator-new', 'repair-1', 'repair-2']);

  // 已经排在队尾的批次被操作员触发 → 提到队首(不重复入队)
  scheduler.scheduleBatch('repair-2', { priority: true });
  assert.deepEqual(scheduler.pendingBatches, ['repair-2', 'operator-new', 'repair-1']);

  // 正在跑的批次再次 priority 调度 → 不动(幂等)
  scheduler.scheduleBatch('repair-0', { priority: true });
  assert.deepEqual([...scheduler.activeBatches], ['repair-0']);

  gate.resolve();
  await nextImmediate();
  await nextImmediate();
  await nextImmediate();
  assert.deepEqual(started.slice(0, 3), ['repair-0', 'repair-2', 'operator-new']);
});

test('resumeIncompleteBatches 新批次先恢复(id 倒序=当天的活优先于历史补跑)', async () => {
  const scheduled = [];
  const scheduler = createWorkbenchScheduler({
    maxConcurrentBatches: 1,
    deferRun: () => {}, // 不真跑,只看排队顺序
    processBatch: async () => {},
  });
  await scheduler.resumeIncompleteBatches({
    listBatchIds: () => ['batch_20260701_a', 'batch_20260703_c', 'batch_20260702_b'],
    loadBatch: (id) => ({ id, machineState: 'queued', tasks: [] }),
  });
  scheduled.push(...scheduler.pendingBatches);
  assert.deepEqual(scheduled, ['batch_20260703_c', 'batch_20260702_b', 'batch_20260701_a']);
});

test('workbench scheduler defaults to two active recognition batches', async () => {
  const previousLimit = process.env.WORKBENCH_MAX_ACTIVE_BATCHES;
  delete process.env.WORKBENCH_MAX_ACTIVE_BATCHES;
  const first = deferred();
  const second = deferred();
  const started = [];
  const scheduler = createWorkbenchScheduler({
    processBatch: async (batchId) => {
      started.push(batchId);
      if (batchId === 'batch-1') {
        await first.promise;
      } else {
        await second.promise;
      }
    },
  });

  try {
    scheduler.scheduleBatch('batch-1');
    scheduler.scheduleBatch('batch-2');
    scheduler.scheduleBatch('batch-3');
    await nextImmediate();

    assert.deepEqual(started, ['batch-1', 'batch-2']);
    assert.deepEqual([...scheduler.activeBatches], ['batch-1', 'batch-2']);
    assert.deepEqual(scheduler.pendingBatches, ['batch-3']);
  } finally {
    first.resolve();
    second.resolve();
    if (previousLimit === undefined) {
      delete process.env.WORKBENCH_MAX_ACTIVE_BATCHES;
    } else {
      process.env.WORKBENCH_MAX_ACTIVE_BATCHES = previousLimit;
    }
  }
});

// ── 停摆看门狗(2026-07-08 四批次静默悬死事故)────────────────────────────
// 病理:processBatch 协程在生产并发下于 chunk 间隙静默悬死(零报错零超时零日志),
// 双 activeBatches 守卫被永久占用 → 追加触发的 scheduleBatch 全部被吞,
// 批次永远"等待识别"。自愈:周期扫描停摆批次 → 强制释放双守卫 → 重新调度;
// run-token 防僵尸协程复活时误删新一轮运行的守卫。

test('run-token:强制释放后重跑,僵尸协程的 finally 不得误删新守卫', async () => {
  const zombie = deferred();
  const fresh = deferred();
  let calls = 0;
  const scheduler = createWorkbenchScheduler({
    maxConcurrentBatches: 2,
    processBatch: async () => {
      calls += 1;
      if (calls === 1) await zombie.promise; // 第一轮:悬死
      else await fresh.promise;             // 第二轮:正常
    },
  });

  scheduler.scheduleBatch('batch-stuck');
  await nextImmediate();
  assert.deepEqual([...scheduler.activeBatches], ['batch-stuck'], '第一轮占守卫');

  // 看门狗强制释放 → 重新调度 → 第二轮开跑
  assert.equal(scheduler.forceReleaseBatch('batch-stuck'), true, '释放时守卫确实被占');
  scheduler.scheduleBatch('batch-stuck');
  await nextImmediate();
  assert.equal(calls, 2, '第二轮必须真的开跑(守卫已释放)');
  assert.deepEqual([...scheduler.activeBatches], ['batch-stuck'], '第二轮持有守卫');

  // 僵尸复活:第一轮 promise 迟到落定 → 它的 finally 不得删掉第二轮的守卫
  zombie.resolve();
  await nextImmediate();
  await nextImmediate();
  assert.deepEqual([...scheduler.activeBatches], ['batch-stuck'],
    '僵尸 finally 不得误删新一轮守卫(run-token 校验)');

  fresh.resolve();
  await nextImmediate();
  await nextImmediate();
  assert.deepEqual([...scheduler.activeBatches], [], '第二轮正常结束后守卫清空');
});

test('forceReleaseBatch:未被占用时返回 false', () => {
  const scheduler = createWorkbenchScheduler({ processBatch: async () => {} });
  assert.equal(scheduler.forceReleaseBatch('nobody'), false);
});

test('sweepStalledBatches:停摆批次→释放双守卫+重调度+记日志;活跃/排队/无积压批次不动', async () => {
  const NOW = Date.parse('2026-07-08T04:00:00.000Z');
  const hang = deferred();
  const processed = [];
  const scheduler = createWorkbenchScheduler({
    maxConcurrentBatches: 3,
    processBatch: async (batchId) => {
      processed.push(batchId);
      if (batchId === 'b-stuck') await hang.promise; // 模拟悬死占守卫
    },
  });

  scheduler.scheduleBatch('b-stuck');
  await nextImmediate();

  const summaries = [
    { id: 'b-stuck', counts: { queued: 43, processing: 0 } },   // 停摆:守卫被占+进度陈旧
    { id: 'b-fresh', counts: { queued: 5, processing: 2 } },    // 活跃:进度新鲜
    { id: 'b-done', counts: { queued: 0, processing: 0 } },     // 无积压
    { id: 'b-never', counts: { queued: 8, processing: 0 } },    // 从未开跑:无进度对象,批次落盘时间陈旧
  ];
  const rawBatches = {
    'b-stuck': { recognitionProgress: { updatedAt: '2026-07-08T02:32:32.000Z' }, updatedAt: '2026-07-08T03:59:00.000Z' },
    'b-fresh': { recognitionProgress: { updatedAt: '2026-07-08T03:59:30.000Z' }, updatedAt: '2026-07-08T03:59:30.000Z' },
    'b-never': { recognitionProgress: null, updatedAt: '2026-07-08T02:00:00.000Z' },
  };
  const released = [];
  const logs = [];
  const revived = scheduler.sweepStalledBatches({
    listBatchSummaries: () => summaries,
    loadBatch: (id) => { if (!rawBatches[id]) throw new Error('should not load ' + id); return rawBatches[id]; },
    processorForceRelease: (id) => { released.push(id); return true; },
    stallThresholdMs: 5 * 60 * 1000,
    now: () => NOW,
    log: (msg, fields) => logs.push({ msg, fields }),
  });

  assert.deepEqual(revived.sort(), ['b-never', 'b-stuck'], '停摆+从未开跑的被复活;活跃/无积压不动');
  assert.deepEqual(released.sort(), ['b-never', 'b-stuck'], '处理器守卫被释放');
  assert.equal(logs.length, 2, '每个复活大声记一条');
  assert.ok(logs.every((l) => l.msg === 'batch_stall_revived'), '日志事件名固定,可 grep');

  await nextImmediate();
  // b-stuck 被重新调度真的开跑(第二轮);b-never 也开跑
  assert.ok(processed.filter((x) => x === 'b-stuck').length >= 2, 'b-stuck 第二轮开跑');
  assert.ok(processed.includes('b-never'));
  hang.resolve();
  await nextImmediate();
});

test('sweepStalledBatches:已在调度队列里排队的批次不算停摆(等槽位是正常状态)', async () => {
  const hangA = deferred();
  const scheduler = createWorkbenchScheduler({
    maxConcurrentBatches: 1,
    processBatch: async (id) => { if (id === 'a') await hangA.promise; },
  });
  scheduler.scheduleBatch('a'); // 占住唯一槽位
  scheduler.scheduleBatch('b'); // b 在 pendingBatches 排队
  await nextImmediate();

  const revived = scheduler.sweepStalledBatches({
    listBatchSummaries: () => [{ id: 'b', counts: { queued: 10, processing: 0 } }],
    loadBatch: () => ({ recognitionProgress: null, updatedAt: '2026-07-01T00:00:00.000Z' }),
    processorForceRelease: () => false,
    stallThresholdMs: 60_000,
    now: () => Date.parse('2026-07-08T04:00:00.000Z'),
    log: () => {},
  });
  assert.deepEqual(revived, [], '排队中的批次不动(会轮到它)');
  hangA.resolve();
  await nextImmediate();
});

test('sweepStalledBatches:chunk在飞(processing>0)用3倍硬上限,防误杀合法慢chunk', () => {
  const NOW = Date.parse('2026-07-08T04:00:00.000Z');
  const scheduler = createWorkbenchScheduler({ processBatch: async () => {} });
  const mk = (id, processing, lastBeatMinAgo) => ({
    summary: { id, counts: { queued: 3, processing } },
    raw: { recognitionProgress: { updatedAt: new Date(NOW - lastBeatMinAgo * 60_000).toISOString() } },
  });
  const cases = {
    'slow-chunk': mk('slow-chunk', 2, 8),   // 在飞+8分钟:合法慢chunk,不动(<15min硬上限)
    'dead-chunk': mk('dead-chunk', 2, 20),  // 在飞+20分钟:超硬上限,复活
    'gap-stall': mk('gap-stall', 0, 8),     // 无在飞+8分钟:间隙停摆(本次事故指纹),复活
  };
  const revived = scheduler.sweepStalledBatches({
    listBatchSummaries: () => Object.values(cases).map((c) => c.summary),
    loadBatch: (id) => cases[id].raw,
    processorForceRelease: () => true,
    stallThresholdMs: 5 * 60 * 1000,
    now: () => NOW,
    log: () => {},
  });
  assert.deepEqual(revived.sort(), ['dead-chunk', 'gap-stall']);
});

// F2(2026-07-20):批次的并发活动(追加建档/审核改字段)持续刷新 batch.updatedAt,会掩盖
// 个别 queued 任务的永久停摆——看门狗原以 lastBeat 判停摆,lastBeat 常新时 20+ 分钟不救。
// 修:孤儿批次(有积压+不在active+不在pending+processing=0)无视 lastBeat 直接救。
test('F2 sweepStalledBatches:孤儿批次(无协程处理+processing=0)即使 lastBeat 很新也救', async () => {
  const NOW = Date.parse('2026-07-20T04:00:00.000Z');
  const scheduler = createWorkbenchScheduler({ maxConcurrentBatches: 2, processBatch: async () => {} });
  // 不 scheduleBatch → 批次既不在 activeBatches 也不在 pendingBatches = 孤儿(重启中断处理循环)
  const revived = scheduler.sweepStalledBatches({
    listBatchSummaries: () => [{ id: 'b-orphan', counts: { queued: 5, processing: 0 } }],
    // lastBeat 仅 5 秒前(并发活动刚刷新过 updatedAt),远未过 stallThreshold
    loadBatch: () => ({ recognitionProgress: null, updatedAt: new Date(NOW - 5_000).toISOString() }),
    processorForceRelease: () => false,
    stallThresholdMs: 5 * 60 * 1000,
    now: () => NOW,
    log: () => {},
  });
  assert.deepEqual(revived, ['b-orphan'], '孤儿无视新 lastBeat 被救(并发活动刷新 updatedAt 不该掩盖停摆)');
});

test('F2 反向:processing>0 的批次即使不在 activeBatches 也按 lastBeat 判(不误当孤儿救)', () => {
  const NOW = Date.parse('2026-07-20T04:00:00.000Z');
  const scheduler = createWorkbenchScheduler({ maxConcurrentBatches: 2, processBatch: async () => {} });
  const revived = scheduler.sweepStalledBatches({
    // processing>0 = 有 chunk 在飞(可能合法慢),lastBeat 仅 5 秒前 → 不该当孤儿救
    listBatchSummaries: () => [{ id: 'b-inflight', counts: { queued: 2, processing: 3 } }],
    loadBatch: () => ({ recognitionProgress: { updatedAt: new Date(NOW - 5_000).toISOString() } }),
    processorForceRelease: () => false,
    stallThresholdMs: 5 * 60 * 1000,
    now: () => NOW,
    log: () => {},
  });
  assert.deepEqual(revived, [], 'chunk 在飞+进度新鲜 → 不救(防误杀合法慢 chunk)');
});
