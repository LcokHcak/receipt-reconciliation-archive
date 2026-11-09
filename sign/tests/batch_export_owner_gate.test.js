'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createWorkbenchBatchHandlers } = require('../services/handlers/workbench/batch_handlers');
const { assertBatchAccess } = require('../lib/operator_scope');

// 审计H1:exportCustomerData 此前独缺 owner 闸,reviewer 可越权下载他人批次全部客户图。
// 兄弟导出 exportHyundai/Lotte/Mode 都有 assertBatchAccess,本测试锁死"四个导出都必须过 owner 闸"。
function makeHandlers(exportSpy) {
  const batch = { id: 'b1', ownerUsername: 'op1', tasks: [] };
  return createWorkbenchBatchHandlers({
    loadBatch: (id) => (id === 'b1' ? batch : null),
    assertBatchAccess, // 真实 owner 判定(operator_scope)
    summarizeBatch: () => ({}),
    workbenchExportService: { exportBatch: async () => ({}) },
    workbenchWriteService: {},
    batchCustomerDataExportService: { exportZip: async (...a) => { exportSpy.push(a); return { zipPath: '/tmp/x.zip', downloadName: 'x.zip', cleanup: () => {} }; } },
    hyundaiDeliveryExportService: { exportZip: async () => ({ zipPath: '/tmp/x.zip', downloadName: 'x.zip', cleanup: () => {} }) },
    lotteDeptDeliveryExportService: { exportZip: async () => ({ zipPath: '/tmp/x.zip', downloadName: 'x.zip', cleanup: () => {} }) },
    modeDeliveryExportService: { exportZip: async () => ({ zipPath: '/tmp/x.zip', downloadName: 'x.zip', cleanup: () => {} }) },
  });
}

function fakeRes() {
  return {
    statusCode: 200, body: null, headersSent: false,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    download() { return this; },
  };
}

test('exportCustomerData:非 owner reviewer → 打包前被 owner 闸拦(exportZip 不被调用)', async () => {
  const exportSpy = [];
  const handlers = makeHandlers(exportSpy);
  const res = fakeRes();
  let forwarded = null;
  // forwardAsync 把抛错交给 next;owner 闸抛 "batch access denied"
  await handlers.exportCustomerData(
    { params: { batchId: 'b1' }, user: { username: 'intruder', role: 'reviewer' } },
    res,
    (err) => { forwarded = err; },
  );
  assert.ok(forwarded, '非 owner 必须被拦并交给 next(error)');
  assert.match(String(forwarded.message), /batch access denied/);
  assert.equal(exportSpy.length, 0, '越权时 exportZip 绝不能被调用(否则已泄漏客户图)');
});

test('exportCustomerData:owner 本人 → 放行进入导出', async () => {
  const exportSpy = [];
  const handlers = makeHandlers(exportSpy);
  const res = fakeRes();
  let forwarded = null;
  await handlers.exportCustomerData(
    { params: { batchId: 'b1' }, user: { username: 'op1', role: 'reviewer' } },
    res,
    (err) => { forwarded = err; },
  );
  assert.equal(forwarded, null, 'owner 本人不应被拦');
  assert.equal(exportSpy.length, 1, 'owner 放行后应进入 exportZip');
});

test('exportCustomerData:admin 全局角色 → 放行(与兄弟导出同口径)', async () => {
  const exportSpy = [];
  const handlers = makeHandlers(exportSpy);
  const res = fakeRes();
  let forwarded = null;
  await handlers.exportCustomerData(
    { params: { batchId: 'b1' }, user: { username: 'boss', role: 'admin' } },
    res,
    (err) => { forwarded = err; },
  );
  assert.equal(forwarded, null);
  assert.equal(exportSpy.length, 1);
});
