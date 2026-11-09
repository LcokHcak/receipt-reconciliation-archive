'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { handleImport } = require('../routes/monthly/route_utils');

test('store-bill import route forwards the UI-selected bucket folder', async () => {
  let captured = null;
  const handler = handleImport({
    workspaceService: {
      getOrThrow(workspaceKey) {
        return { workspaceKey, status: 'open' };
      },
    },
    importService: {
      async importStoreBill(opts) {
        captured = opts;
        // 异步导入:job 建好即回调(路由据此先响应 jobId)
        if (typeof opts.onJobCreated === 'function') opts.onJobCreated(7);
        return { id: 7, bucketFolder: opts.bucketFolder };
      },
    },
    jobType: 'store_bill',
  });

  const req = {
    params: { workspaceKey: 'demo-2026-06' },
    body: { bucketFolder: '爱宝客' },
    file: {
      path: 'C:\\tmp\\ipark.xlsx',
      originalname: 'ipark.xlsx',
    },
    user: { username: 'tester' },
  };
  const res = createJsonResponse();

  await handler(req, res);
  await new Promise((r) => setImmediate(r)); // 等后台 invokeImport 触发 onJobCreated

  assert.equal(res.statusCode, 200);
  // bucketFolder 仍透传到 importService(captured),这是本测试要验的"转发"
  assert.equal(captured.bucketFolder, '爱宝客');
  assert.equal(captured.workspaceKey, 'demo-2026-06');
  assert.equal(captured.sourceFileName, 'ipark.xlsx');
  // 异步导入:路由先返回 running job(id),最终结果由前端轮询 import-jobs/:id
  assert.equal(res.body.job.id, 7);
  assert.equal(res.body.job.status, 'running');
});

function createJsonResponse() {
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
