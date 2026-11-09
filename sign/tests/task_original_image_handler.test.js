'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createWorkbenchTaskHandlers } = require('../services/handlers/workbench/task_handlers');

// 「查看原图」端点(2026-07-06 切边补救):切片名回溯客户库 _original;含逃逸防御(审查 HIGH 意见)。
function buildHandlers({ imagesRoot, task }) {
  const batch = { id: 'batch_x', tasks: [task] };
  return createWorkbenchTaskHandlers({
    activeBatches: new Map(),
    batchRepository: { hasBatch: () => true },
    customerIntakeService: {},
    customerLibraryRepository: {
      customerDir: (ws, cid) => path.join(imagesRoot, ws, cid),
      findCustomerByReviewReference: () => null,
    },
    loadBatch: () => batch,
    assertBatchAccess: () => {},
    removeBatchDirectory: () => {},
    removeTaskArtifacts: () => {},
    saveBatchAsync: async () => {},
    sqliteSyncService: null,
    summarizeBatch: () => ({}),
    syncRecognitionProgress: () => {},
    withBatchWrite: async (_id, fn) => fn(),
    workbenchWriteService: {},
    getWorkbenchBatchLedgerImportService: () => null,
  });
}

async function invoke(handler, { taskId = 'task_1' } = {}) {
  const req = { params: { batchId: 'batch_x', taskId }, user: { role: 'admin' } };
  const result = { statusCode: 200, body: null, sentFile: '' };
  const res = {
    status(code) { result.statusCode = code; return this; },
    json(body) { result.body = body; return this; },
    sendFile(p) { result.sentFile = p; return this; },
  };
  let nextErr = null;
  await handler(req, res, (err) => { nextErr = err; });
  return { ...result, nextErr };
}

function makeCustomer(imagesRoot, files) {
  const dir = path.join(imagesRoot, 'ws1', 'CL20260706-001', 'images');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(dir, f), 'img');
  return dir;
}

test('original-image: 切片名回溯 _original;无切分后缀时供图自身', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'origimg_'));
  try {
    makeCustomer(root, ['02-0_original.jpg', '03-0_receipt_1.jpg', '01-1.jpg']);
    // 切片 → 找到同基名 _original
    const h1 = buildHandlers({
      imagesRoot: root,
      task: { id: 'task_1', sourceOriginalPath: 'ws1/CL20260706-001/03-0_receipt_1.jpg' },
    });
    const r1 = await invoke(h1.getTaskOriginalImage);
    assert.equal(r1.nextErr, null);
    assert.ok(r1.sentFile.endsWith('02-0_original.jpg'), `应回原图: ${r1.sentFile}`);

    // 未切过的图 → 自身即原图
    const h2 = buildHandlers({
      imagesRoot: root,
      task: { id: 'task_1', sourceOriginalPath: 'ws1/CL20260706-001/01-1.jpg' },
    });
    const r2 = await invoke(h2.getTaskOriginalImage);
    assert.ok(r2.sentFile.endsWith('01-1.jpg'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('original-image: 任务缺失/引用缺失/文件缺失 → 404', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'origimg404_'));
  try {
    makeCustomer(root, []);
    const h = buildHandlers({
      imagesRoot: root,
      task: { id: 'task_1', sourceOriginalPath: 'ws1/CL20260706-001/ghost.jpg' },
    });
    const missFile = await invoke(h.getTaskOriginalImage);
    assert.equal(missFile.nextErr?.status ?? missFile.statusCode, 404);

    const missTask = await invoke(h.getTaskOriginalImage, { taskId: 'nope' });
    assert.equal(missTask.nextErr?.status ?? missTask.statusCode, 404);

    const h2 = buildHandlers({ imagesRoot: root, task: { id: 'task_1', sourceOriginalPath: '' } });
    const missRef = await invoke(h2.getTaskOriginalImage);
    assert.equal(missRef.nextErr?.status ?? missRef.statusCode, 404);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('original-image: 路径逃逸一律 404(纵深防御,审查HIGH)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'origimg_sec_'));
  try {
    makeCustomer(root, ['01-1.jpg']);
    // 越界目标文件(不该被读到)
    fs.writeFileSync(path.join(root, 'secret.txt'), 'secret');
    const evil = [
      'ws1/CL20260706-001/../../secret.txt',      // fileName 段带 ..(split 后 parts>3,引用判 404)
      'ws1/CL20260706-001/..%2Fsecret.txt',
      'ws1/../CL20260706-001/01-1.jpg',
      '../ws1/CL20260706-001/01-1.jpg',
    ];
    for (const src of evil) {
      const h = buildHandlers({ imagesRoot: root, task: { id: 'task_1', sourceOriginalPath: src } });
      const r = await invoke(h.getTaskOriginalImage);
      assert.equal(r.nextErr?.status ?? r.statusCode, 404, `应拒绝: ${src}`);
      assert.equal(r.sentFile, '', `绝不能供图: ${src}`);
    }
    // Windows 反斜杠逃逸(单段内藏 ..\\)
    const h = buildHandlers({
      imagesRoot: root,
      task: { id: 'task_1', sourceOriginalPath: 'ws1/CL20260706-001/..\\..\\..\\secret.txt' },
    });
    const r = await invoke(h.getTaskOriginalImage);
    assert.equal(r.nextErr?.status ?? r.statusCode, 404);
    assert.equal(r.sentFile, '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
