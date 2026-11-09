'use strict';

/**
 * P2-a:在**切片任务**上补小票时,把整张原图拷进批次,新任务指到那张图上。
 *
 * 为什么这事非做不可(0731 拿真批次量出来的):
 *   在切片任务上点「补小票」,老行为是照抄源任务的 sourceImagePath,
 *   于是补出来的任务 ①不能画框(canAcceptManualBox 拒切片)
 *                  ②交付撞 duplicate_crop_file(两条任务共用一个切片文件)
 *   —— 两头堵死,这个按钮在切片任务上等于白给。
 *   本地真批次 119 条任务里 7 条切片任务,全都卡在这里。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createWorkbenchTaskHandlers } = require('../services/handlers/workbench/task_handlers');
const { SPLIT_FILE_RE } = require('../lib/delivery_render');
const { canAcceptManualBox } = require('../lib/manual_doc_box');

let root;
test.before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'p2a-'));
  const imgs = path.join(root, 'lib', '2026-07', 'CL20260701-001', 'images');
  fs.mkdirSync(imgs, { recursive: true });
  // 切分前完整原图(客户库里,刻意不进批次)+ 它切出来的一片
  fs.writeFileSync(path.join(imgs, '02-mix1_original.jpg'), 'ORIGINAL-BYTES');
  fs.writeFileSync(path.join(imgs, '02-mix1_receipt_1.jpg'), 'SLICE-BYTES');
});
test.after(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

function build(sourceTask) {
  const calls = [];
  const batchId = 'batch_p2a';
  const batchRoot = path.join(root, 'batches', batchId);
  const handlers = createWorkbenchTaskHandlers({
    activeBatches: new Map(),
    batchRepository: {
      hasBatch: () => true,
      batchSubdirs: () => ({ root: batchRoot, source: path.join(batchRoot, 'source') }),
    },
    customerIntakeService: {},
    customerLibraryRepository: {
      customerDir: (ws, cid) => path.join(root, 'lib', ws, cid),
      findCustomerByReviewReference: () => null,
    },
    loadBatch: () => ({ id: batchId, tasks: [sourceTask] }),
    assertBatchAccess: () => {},
    removeBatchDirectory: () => {},
    removeTaskArtifacts: () => {},
    saveBatchAsync: async () => {},
    sqliteSyncService: null,
    summarizeBatch: () => ({}),
    syncRecognitionProgress: () => {},
    withBatchWrite: async (_id, fn) => fn(),
    workbenchWriteService: {
      createManualReceiptFromTask: async (args) => {
        calls.push(args);
        return { status: 200, body: { ok: true } };
      },
    },
    getWorkbenchBatchLedgerImportService: () => null,
  });
  return { handlers, calls, batchRoot };
}

async function invoke(handler) {
  const req = { params: { batchId: 'batch_p2a', taskId: 'task_1' }, body: {}, user: { role: 'admin' } };
  const res = { status() { return this; }, json() { return this; } };
  await handler(req, res, () => {});
}

const sliceTask = () => ({
  id: 'task_1',
  sourceImagePath: 'source/task_0001__02-mix1_receipt_1.jpg',
  sourceOriginalPath: '2026-07/CL20260701-001/02-mix1_receipt_1.jpg',
});

test('⭐切片任务补票:原图被拷进批次,新任务指到它', async () => {
  const { handlers, calls, batchRoot } = build(sliceTask());
  await invoke(handlers.createManualReceiptFromTask);
  assert.equal(calls.length, 1);
  const ov = calls[0].taskOverrides;
  assert.ok(ov && ov.sourceImagePath, '应给出新的图片路径');

  const copied = path.join(batchRoot, ov.sourceImagePath);
  assert.ok(fs.existsSync(copied), '原图要真的落进批次 source/(批次得自包含)');
  assert.equal(fs.readFileSync(copied, 'utf8'), 'ORIGINAL-BYTES',
    '拷的必须是**整张原图**,不是那片切片');
});

test('⭐拷进去的文件名不能又长成切片样 —— 否则新任务还是不能画框,原地转圈', async () => {
  const { handlers, calls } = build(sliceTask());
  await invoke(handlers.createManualReceiptFromTask);
  const rel = calls[0].taskOverrides.sourceImagePath;
  const name = rel.split('\\').join('/').split('/').pop();
  assert.equal(SPLIT_FILE_RE.test(name), false, `文件名 ${name} 又被判成切片了`);
  // 端到端确认:拿这个新路径去问画框判据,必须放行
  assert.equal(canAcceptManualBox({ sourceImagePath: rel }).ok, true,
    '补出来的任务必须真的能画框 —— 这才是这次改动的全部意义');
});

test('整图任务补票:老行为一字不改(不拷、不覆盖)', async () => {
  const { handlers, calls } = build({
    id: 'task_1',
    sourceImagePath: 'source/task_0001__02-mix1_original.jpg',
    sourceOriginalPath: '2026-07/CL20260701-001/02-mix1_original.jpg',
  });
  await invoke(handlers.createManualReceiptFromTask);
  assert.deepEqual(calls[0].taskOverrides, {}, '本来就能画框的任务不该被动');
});

test('原图回溯不到:照老样子建,不许因为拷贝失败就不让人补票', async () => {
  const { handlers, calls } = build({
    id: 'task_1',
    sourceImagePath: 'source/task_0001__nowhere_receipt_1.jpg',
    sourceOriginalPath: '2026-07/CL99999999-999/nowhere_receipt_1.jpg',
  });
  await invoke(handlers.createManualReceiptFromTask);
  assert.equal(calls.length, 1, '仍要建票');
  assert.deepEqual(calls[0].taskOverrides, {});
});

test('同一张原图补两次:文件名不撞', async () => {
  const a = build(sliceTask());
  await invoke(a.handlers.createManualReceiptFromTask);
  const b = build(sliceTask());
  await invoke(b.handlers.createManualReceiptFromTask);
  const n1 = a.calls[0].taskOverrides.sourceImagePath;
  const n2 = b.calls[0].taskOverrides.sourceImagePath;
  assert.notEqual(n1, n2, '两次补票不能落到同一个文件名上');
});
