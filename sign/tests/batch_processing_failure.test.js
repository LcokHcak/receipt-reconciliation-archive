'use strict';

/**
 * batch_processing_service 失败/恢复面直测(域4 HIGH#3)。
 * 见 docs/边界测试设计.md「域4·OCR/切图」:markTaskOcrFailure 不覆盖人工改的 docTypeFinal /
 * pendingTasks 过滤 / run-token 悬死老协程不误删新守卫。
 *
 * markTaskOcrFailure 未导出 → 走可达的真实路径:createBatchProcessingService 全 mock 依赖
 * 实例化,注入会 reject 的 modelPipelineOrchestrator.runPersistedStage(第一阶段 classification
 * 即抛)→ processChunk 抛 → processBatchChunkFailure 对 processing 中的任务逐个
 * markTaskOcrFailure——这正是"OCR 服务故障(DashScope 账户受限)整 chunk 失败"的生产路径。
 * qwenOcrBackend 注入 stub 仅为选中 qwen 管道函数(不落 PaddleX);阶段被 mock 拒绝,
 * 不会真调千问、不写 sidecar。批次目录用临时目录(batchJsonPath 需真实存在供 existsSync)。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createBatchProcessingService } = require('../services/batch_processing_service');

const BATCH_ID = 'batch-under-test';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(cond, what = 'condition') {
  for (let i = 0; i < 500; i += 1) {
    if (cond()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`waitFor 超时:${what}`);
}

function failingOrchestrator(message) {
  return {
    async runPersistedStage() {
      throw new Error(message);
    },
  };
}

function makeTask(id, overrides = {}) {
  return {
    id,
    machineState: 'queued',
    sourceType: '',
    sourceImagePath: `images/${id}.jpg`,
    error: '',
    ocrError: '',
    reviewed: false,
    reviewedAt: '',
    classificationConfirmed: false,
    needsReview: false,
    reviewReasons: [],
    docTypeAuto: 'receipt',
    docTypeFinal: '',
    ...overrides,
  };
}

function createHarness(t, { tasks, orchestrator }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-batch-fail-'));
  fs.writeFileSync(path.join(tmpDir, 'batch.json'), '{}'); // 只为 fs.existsSync 闸门
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const batch = { id: BATCH_ID, machineState: 'queued', tasks };
  const activeBatches = new Set();
  const saves = [];
  const service = createBatchProcessingService({
    activeBatches,
    batchDir: () => tmpDir,
    batchJsonPath: () => path.join(tmpDir, 'batch.json'),
    batchSubdirs: () => ({ rawJson: tmpDir }),
    withBatchWrite: (batchId, action) => action(),
    loadBatch: () => batch,
    saveBatchAsync: async () => {
      saves.push(batch.machineState);
    },
    saveJson: () => {},
    modelPipelineOrchestrator: orchestrator,
    documentTypeModel: null,
    passportFieldModel: null,
    receiptFieldModel: null,
    // 选中 qwen 管道(惰性,阶段被 mock 拒绝后不会真调);若误落 Paddle 管道会试跑外部进程
    qwenOcrBackend: {
      async extractAnalyses() {
        throw new Error('测试不应真调千问');
      },
    },
    paddleOcrOptions: {},
    paddleBatchChunkSize: 10,
    resolveTask: (loadedBatch, taskId) =>
      (loadedBatch.tasks || []).find((item) => item.id === taskId) || null,
    recalcTask: () => {},
    touchTask: () => {},
    syncRecognitionProgress: () => ({}),
    hasAutoConfirmedDocType: () => false,
    markClassificationConfirmed: () => {},
    clearSignatureRegionAsset: () => {},
    clearAutoFinalSignatureAsset: () => {},
    canAutoQueueWebsiteSignature: () => false,
    queueAutomaticWebsiteSignature: async () => {},
  });
  return { service, batch, activeBatches, saves };
}

test('①OCR 故障:人工改过的 docTypeFinal(≠Auto 且非空)不被覆盖,只标 error/needsReview', async (t) => {
  // 审核员已把机判 receipt 改成 passport(并终审过)——故障重跑不得吃掉人工判断
  const manual = makeTask('t-manual', {
    docTypeAuto: 'receipt',
    docTypeFinal: 'passport',
    reviewed: true,
    reviewedAt: '2026-07-01T00:00:00.000Z',
    classificationConfirmed: true,
  });
  const { service, activeBatches } = createHarness(t, {
    tasks: [manual],
    orchestrator: failingOrchestrator('DashScope 账户受限(mock 故障)'),
  });

  await service.processBatch(BATCH_ID);

  assert.equal(manual.machineState, 'error');
  assert.match(manual.error, /DashScope 账户受限/);
  assert.match(manual.ocrError, /DashScope 账户受限/);
  assert.equal(manual.needsReview, true);
  assert.deepEqual(manual.reviewReasons, ['ocr_failed']);
  assert.equal(manual.reviewed, false, '失败票必须打回待审');
  assert.equal(manual.reviewedAt, '');
  assert.equal(manual.classificationConfirmed, false);
  assert.equal(manual.docTypeAuto, 'other', '机判恒重置为 other(它本来就是机器的)');
  assert.equal(manual.docTypeFinal, 'passport', '⭐人工改过的 docTypeFinal 绝不覆盖');
  assert.equal(activeBatches.size, 0, '守卫必须释放');
});

test('②docTypeFinal 空 或 等于 Auto(机器跟随态)→ 失败时置 other', async (t) => {
  const emptyFinal = makeTask('t-empty', { docTypeAuto: 'receipt', docTypeFinal: '' });
  const sameAsAuto = makeTask('t-same', { docTypeAuto: 'receipt', docTypeFinal: 'receipt' });
  const { service } = createHarness(t, {
    tasks: [emptyFinal, sameAsAuto],
    orchestrator: failingOrchestrator('mock OCR down'),
  });

  await service.processBatch(BATCH_ID);

  for (const task of [emptyFinal, sameAsAuto]) {
    assert.equal(task.machineState, 'error');
    assert.equal(task.docTypeAuto, 'other');
    assert.equal(task.docTypeFinal, 'other', '未被人工改过的 Final 跟随重置为 other');
    assert.deepEqual(task.reviewReasons, ['ocr_failed']);
  }
});

test('③pendingTasks 过滤:manual 来源/已 completed/无图 全跳过,不吃故障标记', async (t) => {
  const manualSource = makeTask('t-manual-src', { sourceType: 'manual', docTypeFinal: 'receipt' });
  const completed = makeTask('t-completed', { machineState: 'completed', docTypeFinal: 'receipt' });
  const noImage = makeTask('t-no-image', { sourceImagePath: '', docTypeFinal: 'receipt' });
  const pending = makeTask('t-pending');
  const { service, activeBatches } = createHarness(t, {
    tasks: [manualSource, completed, noImage, pending],
    orchestrator: failingOrchestrator('mock OCR down'),
  });

  await service.processBatch(BATCH_ID);

  // 只有真正待识别的那张被标失败
  assert.equal(pending.machineState, 'error');
  assert.deepEqual(pending.reviewReasons, ['ocr_failed']);

  // 三张被过滤的:状态/错误/类型一个都不动
  assert.equal(manualSource.machineState, 'queued', 'manual 来源不进识别管道');
  assert.equal(completed.machineState, 'completed', '已完成的不重跑');
  assert.equal(noImage.machineState, 'queued', '无图任务不进识别管道');
  for (const task of [manualSource, completed, noImage]) {
    assert.equal(task.error, '');
    assert.equal(task.ocrError, '');
    assert.equal(task.docTypeFinal, 'receipt');
    assert.deepEqual(task.reviewReasons, []);
  }
  assert.equal(activeBatches.size, 0);
});

test('④run-token:看门狗强杀后悬死老协程迟到收尾,finally 不得误删新一轮守卫', async (t) => {
  // 可控悬挂的 orchestrator:每次 runPersistedStage 挂一个 deferred(第一阶段即悬住)
  const stalls = [];
  const orchestrator = {
    runPersistedStage() {
      const d = deferred();
      stalls.push(d);
      return d.promise;
    },
  };
  const { service, activeBatches } = createHarness(t, {
    tasks: [makeTask('t1')],
    orchestrator,
  });

  // run1 悬死在第一个 chunk 的 classification 阶段
  const run1 = service.processBatch(BATCH_ID);
  await waitFor(() => stalls.length === 1, 'run1 进入阶段');
  assert.ok(activeBatches.has(BATCH_ID), 'run1 持有守卫');

  // 看门狗强制释放守卫(生产 watchdog 自愈动作)→ 新一轮重跑
  activeBatches.delete(BATCH_ID);
  const run2 = service.processBatch(BATCH_ID);
  await waitFor(() => stalls.length === 2, 'run2 进入阶段');
  assert.ok(activeBatches.has(BATCH_ID), 'run2 重新持有守卫');

  // 老协程迟到复活并收尾(chunk 失败路径)——它的 finally 不得删 run2 的守卫
  stalls[0].reject(new Error('stalled coroutine revived'));
  await run1;
  assert.ok(activeBatches.has(BATCH_ID), '⭐老协程 finally 不许误删新一轮守卫(否则同批次可三重并发)');

  // 守卫仍在 → 第三次调用被去重,不新开协程
  await service.processBatch(BATCH_ID);
  assert.equal(stalls.length, 2, '守卫在手时重复调用必须直接返回');

  // run2 自己收尾 → 守卫由 run2 释放,批次可再被调度
  stalls[1].reject(new Error('second run finished'));
  await run2;
  assert.equal(activeBatches.size, 0, 'run2 正常释放守卫');
});
