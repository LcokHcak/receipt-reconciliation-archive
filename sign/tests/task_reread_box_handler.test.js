'use strict';

/**
 * P2-b「按框重读」处理器。
 *
 * 这条路的三条取舍全写在 handler 注释里 —— 注释不是保证,下面逐条钉:
 *   1. 只写 *Auto,绝不碰 *Final(重读是建议,拍板还是人)
 *   2. 只写读出来有值的字段(一次失败不该清掉上一轮读对的)
 *   3. OCR 在批次写锁**外面**(锁内只有写字段那几行)
 * 外加:没有人工框就该明确拒绝,而不是拿模型框凑合读一遍。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createWorkbenchTaskHandlers } = require('../services/handlers/workbench/task_handlers');

let tmpRoot;
test.before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reread-handler-'));
  // 解析器要的是 <客户目录>/images/<文件名>,少一层 images/ 就会判成'原图已经不在了'
  const dir = path.join(tmpRoot, '2026-07', 'CL20260701-001', 'images');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'photo.jpg'), 'not-a-real-jpeg');
});
test.after(() => { if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true }); });

function build({ task, reread, onSave = () => {} }) {
  const batch = { id: 'batch_x', tasks: [task] };
  const lockLog = [];
  const handlers = createWorkbenchTaskHandlers({
    activeBatches: new Map(),
    batchRepository: { hasBatch: () => true },
    customerIntakeService: {},
    customerLibraryRepository: {
      customerDir: (ws, cid) => path.join(tmpRoot, ws, cid),
      findCustomerByReviewReference: () => null,
    },
    loadBatch: () => batch,
    assertBatchAccess: () => {},
    removeBatchDirectory: () => {},
    removeTaskArtifacts: () => {},
    saveBatchAsync: async (b) => { onSave(b); },
    sqliteSyncService: null,
    summarizeBatch: () => ({}),
    syncRecognitionProgress: () => {},
    withBatchWrite: async (_id, fn) => { lockLog.push('lock-in'); const r = await fn(); lockLog.push('lock-out'); return r; },
    workbenchWriteService: {},
    getWorkbenchBatchLedgerImportService: () => null,
    rereadRegionFields: async (...args) => { lockLog.push('ocr'); return reread(...args); },
  });
  return { handlers, batch, task, lockLog };
}

async function invoke(handler) {
  const req = { params: { batchId: 'batch_x', taskId: 'task_1' }, user: { role: 'admin' } };
  const out = { statusCode: 200, body: null };
  const res = {
    status(c) { out.statusCode = c; return this; },
    json(b) { out.body = b; return this; },
  };
  let nextErr = null;
  await handler(req, res, (e) => { nextErr = e; });
  return { ...out, nextErr };
}

function taskWithBox(extra = {}) {
  return {
    id: 'task_1',
    sourceOriginalPath: '2026-07/CL20260701-001/photo.jpg',
    manualBox: [0.1, 0.1, 0.6, 0.6],
    docBoxSource: 'manual',
    ...extra,
  };
}

test('没有人工框 → 明确拒绝(不许拿模型框凑合读一遍)', async () => {
  const { handlers } = build({
    task: { id: 'task_1', sourceOriginalPath: '2026-07/CL20260701-001/photo.jpg', detectionBox: [0.1, 0.1, 0.6, 0.6] },
    reread: async () => { throw new Error('不该被调用') },
  });
  const r = await invoke(handlers.rereadTaskBox);
  assert.ok(r.nextErr, '应走错误通道');
  assert.equal(r.nextErr.status ?? r.nextErr.statusCode, 400);
  assert.match(String(r.nextErr.message), /没有人工框/);
});

test('⭐只写 *Auto,绝不碰 *Final', async () => {
  const task = taskWithBox({
    receiptStoreFinal: '人填的店', receiptNoFinal: '人填的号',
    receiptStoreAuto: '旧店', receiptNoAuto: '旧号',
  });
  const { handlers } = build({
    task,
    reread: async () => ({ source: 'qwen', fields: { store: '新店', receiptNo: '新号', purchaseDate: '2026-01-24', amount: '680,000' } }),
  });
  const r = await invoke(handlers.rereadTaskBox);
  assert.equal(r.body.updated, true);
  assert.equal(task.receiptStoreAuto, '新店');
  assert.equal(task.receiptNoAuto, '新号');
  assert.equal(task.purchaseDateAuto, '2026-01-24');
  assert.equal(task.receiptAmountAuto, '680,000');
  // 这两条是重点:审核员敲进去的东西不许被一次重读盖掉
  assert.equal(task.receiptStoreFinal, '人填的店', 'Final 被覆盖了 —— 等于替审核员做决定');
  assert.equal(task.receiptNoFinal, '人填的号', 'Final 被覆盖了');
});

test('⭐空值不覆盖:只读出一个字段,其余保持原样', async () => {
  const task = taskWithBox({ receiptStoreAuto: '旧店', receiptNoAuto: '旧号', receiptAmountAuto: '111' });
  const { handlers } = build({
    task,
    reread: async () => ({ source: 'qwen', fields: { store: '', receiptNo: '新号', purchaseDate: '', amount: '' } }),
  });
  const r = await invoke(handlers.rereadTaskBox);
  assert.equal(r.body.updated, true);
  assert.deepEqual(Object.keys(r.body.fields), ['receiptNoAuto'], '只该报更新了的那一个');
  assert.equal(task.receiptNoAuto, '新号');
  assert.equal(task.receiptStoreAuto, '旧店', '读不出就别动 —— 一次失败不能清掉上一轮读对的');
  assert.equal(task.receiptAmountAuto, '111');
});

test('全空 → 200 但 updated:false + 说明原因(不许伪装成成功)', async () => {
  const task = taskWithBox({ receiptNoAuto: '旧号' });
  let saved = false;
  const { handlers } = build({
    task,
    onSave: () => { saved = true; },
    reread: async () => ({ source: '', fields: { store: '', receiptNo: '', purchaseDate: '', amount: '' } }),
  });
  const r = await invoke(handlers.rereadTaskBox);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.updated, false);
  assert.ok(r.body.reason, '要说清为什么没更新,否则审核员会以为字段已经变了');
  assert.equal(task.receiptNoAuto, '旧号');
  assert.equal(saved, false, '什么都没变就别写盘');
});

test('⭐OCR 在批次写锁外面(锁内只有写字段那几行)', async () => {
  const { handlers, lockLog } = build({
    task: taskWithBox(),
    reread: async () => ({ source: 'qwen', fields: { store: 'X', receiptNo: '', purchaseDate: '', amount: '' } }),
  });
  await invoke(handlers.rereadTaskBox);
  assert.deepEqual(lockLog, ['ocr', 'lock-in', 'lock-out'],
    'qwen 一次约 18s,而批次写锁默认 30s —— 圈在锁里会把整个批次的写操作堵住');
});
