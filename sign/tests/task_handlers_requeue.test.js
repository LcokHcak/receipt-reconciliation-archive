'use strict';

/**
 * requeueTasks handler 直测(域4 HIGH#2,毒 sidecar 恢复主路径)。
 * 见 docs/边界测试设计.md「域4」:①空 taskIds→400 不排程 ②混合已审/未审→skip 已审
 * ③未审→queued 且 classificationConfirmed===false(防 recover 翻回 completed 空转)
 * ④requeued>0→scheduleBatch(priority);requeued=0→不排程不落盘。
 * 搭法照 tests/customer_batch_handlers.test.js:mock 全部依赖,直接调 handler(req,res,next)。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createWorkbenchTaskHandlers } = require('../services/handlers/workbench/task_handlers');
const { recoverCompletedStateAfterManualReview } = require('../lib/workbench_task_recovery');

function createRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

// OCR 故障期"空跑"的典型任务:docType=other/字段全空/分类被自动确认过
function makeTask(id, overrides = {}) {
  return {
    id,
    machineState: 'error',
    error: 'DashScope account limited',
    ocrError: 'DashScope account limited',
    classificationConfirmed: true,
    reviewed: false,
    rephotoRequested: false,
    docTypeAuto: 'other',
    docTypeFinal: 'other',
    ...overrides,
  };
}

function createHarness({ tasks = [], batchId = 'batch-1' } = {}) {
  const batch = { id: batchId, machineState: 'completed', tasks };
  const calls = { lock: [], loaded: [], access: [], synced: [], saved: [], scheduled: [] };
  const handlers = createWorkbenchTaskHandlers({
    withBatchWrite(id, action, options = {}) {
      calls.lock.push({ batchId: id, label: options.label || '' });
      return action();
    },
    loadBatch(id) {
      calls.loaded.push(id);
      assert.equal(id, batchId, 'requeue 只应加载被点名的批次');
      return batch;
    },
    assertBatchAccess(loadedBatch, user) {
      calls.access.push({ batchId: loadedBatch?.id, user: user || null });
    },
    syncRecognitionProgress(loadedBatch) {
      calls.synced.push(loadedBatch.id);
    },
    async saveBatchAsync(loadedBatch) {
      calls.saved.push(loadedBatch.id);
    },
    scheduleBatch(id, options) {
      calls.scheduled.push({ batchId: id, options });
    },
  });
  return { handlers, batch, calls };
}

// handler 是 forwardBatchAccessDenied 包装的 (req,res,next);正路不许走 next(error)
async function invoke(handler, req) {
  const res = createRes();
  const nextErrors = [];
  await handler(req, res, (error) => nextErrors.push(error));
  assert.equal(
    nextErrors.length,
    0,
    `handler 不应把错误交给 next:${nextErrors[0]?.message || nextErrors[0]}`
  );
  return res;
}

test('①空 taskIds → 400,不进锁不读批次不排程(防误触发整批重跑烧 API 费)', async () => {
  const { handlers, calls } = createHarness({ tasks: [makeTask('t1')] });

  // 缺 body / taskIds 非数组 / 空数组 三种写法都必须 400
  for (const body of [undefined, {}, { taskIds: 'not-array' }, { taskIds: [] }]) {
    const res = await invoke(handlers.requeueTasks, { params: { batchId: 'batch-1' }, body });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.ok, false);
    assert.match(String(res.body.error || ''), /taskIds/);
  }
  assert.equal(calls.lock.length, 0, '400 必须发生在 withBatchWrite 之前');
  assert.equal(calls.loaded.length, 0);
  assert.deepEqual(calls.scheduled, []);
  assert.deepEqual(calls.saved, []);
});

test('②混合 1 已审 + 1 未审 → requeued=1/skipped=1,已审票原样不动;未点名的票不碰', async () => {
  const reviewedTask = makeTask('t-reviewed', { reviewed: true, machineState: 'completed', error: '' });
  const pendingTask = makeTask('t-pending');
  const notRequested = makeTask('t-not-requested');
  const { handlers, calls } = createHarness({ tasks: [reviewedTask, pendingTask, notRequested] });

  const res = await invoke(handlers.requeueTasks, {
    params: { batchId: 'batch-1' },
    body: { taskIds: ['t-reviewed', 't-pending'] },
    user: { username: 'op1' },
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, batchId: 'batch-1', requeued: 1, skipped: 1 });

  // 已审票一个字段都不许动
  assert.equal(reviewedTask.machineState, 'completed');
  assert.equal(reviewedTask.classificationConfirmed, true);
  assert.equal(reviewedTask.reviewed, true);

  // 未点名的票完全不碰(显式 taskIds 是唯一入口)
  assert.equal(notRequested.machineState, 'error');
  assert.equal(notRequested.classificationConfirmed, true);
  assert.equal(notRequested.error, 'DashScope account limited');

  // 越权面:锁内先 assertBatchAccess 再改
  assert.deepEqual(calls.lock, [{ batchId: 'batch-1', label: 'requeueTasks' }]);
  assert.deepEqual(calls.access, [{ batchId: 'batch-1', user: { username: 'op1' } }]);
});

test('③未审票 → machineState=queued 且 classificationConfirmed===false(防恢复逻辑空转的关键)', async () => {
  const pendingTask = makeTask('t1');
  const { handlers, batch, calls } = createHarness({ tasks: [pendingTask] });

  await invoke(handlers.requeueTasks, {
    params: { batchId: 'batch-1' },
    body: { taskIds: ['t1'] },
  });

  assert.equal(pendingTask.machineState, 'queued');
  // 必须是显式 false(不是 undefined/保留 true):requeue 语义=重新分类+重抽字段
  assert.strictEqual(pendingTask.classificationConfirmed, false);
  assert.equal(pendingTask.error, '');
  assert.equal(pendingTask.ocrError, '');
  assert.equal(batch.machineState, 'queued');
  assert.deepEqual(calls.synced, ['batch-1']);
  assert.deepEqual(calls.saved, ['batch-1'], 'requeued>0 必须落盘');

  // 交叉契约:processBatch 前置的 recoverCompletedStateAfterManualReview 不得把它翻回 completed。
  // other 类型无必填字段,恢复条件天然满足——唯一拦住它的就是 classificationConfirmed=false。
  assert.equal(recoverCompletedStateAfterManualReview(pendingTask), false);
  assert.equal(pendingTask.machineState, 'queued', 'requeue 后必须留在识别队列里,不许被恢复逻辑吃掉');

  // 反证空转病理:若漏清 classificationConfirmed,恢复逻辑立刻把 queued 翻回 completed → 管道空转
  const zombie = makeTask('t-zombie', { machineState: 'queued', error: '', ocrError: '' });
  assert.equal(recoverCompletedStateAfterManualReview(zombie), true);
  assert.equal(zombie.machineState, 'completed', '(病理复现)不清确认位就会被翻回 completed');
});

test('④requeued>0 → scheduleBatch(batchId,{priority:true});requeued=0 → 不排程不落盘', async () => {
  // requeued > 0 → 插队排程
  {
    const { handlers, calls } = createHarness({ tasks: [makeTask('t1')] });
    await invoke(handlers.requeueTasks, {
      params: { batchId: 'batch-1' },
      body: { taskIds: ['t1'] },
    });
    assert.deepEqual(calls.scheduled, [{ batchId: 'batch-1', options: { priority: true } }]);
  }
  // requeued=0(已审 + 已标重拍全 skip)→ 不排程、不落盘、不动批次状态
  {
    const reviewedTask = makeTask('r1', { reviewed: true, machineState: 'completed' });
    const rephotoTask = makeTask('r2', { rephotoRequested: true });
    const { handlers, batch, calls } = createHarness({ tasks: [reviewedTask, rephotoTask] });
    const res = await invoke(handlers.requeueTasks, {
      params: { batchId: 'batch-1' },
      body: { taskIds: ['r1', 'r2'] },
    });
    assert.deepEqual(res.body, { ok: true, batchId: 'batch-1', requeued: 0, skipped: 2 });
    assert.deepEqual(calls.scheduled, [], 'requeued=0 不许触发识别管道');
    assert.deepEqual(calls.saved, [], 'requeued=0 不许写盘');
    assert.equal(batch.machineState, 'completed', '批次状态不动');
    assert.equal(rephotoTask.machineState, 'error', '已标重拍的任务不动');
  }
});
