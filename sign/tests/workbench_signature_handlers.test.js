const test = require('node:test');
const assert = require('node:assert/strict');

const { createWorkbenchSignatureHandlers } = require('../services/workbench_signature_handlers');

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test('signature handlers open and close the browser through the worker payload adapter', async () => {
  const calls = [];
  const handlers = createWorkbenchSignatureHandlers({
    signatureSiteWorker: {
      openBrowser: async () => ({ state: 'open' }),
      closeBrowser: async () => ({ state: 'closed' }),
    },
    buildSignatureServicePayload: (service) => {
      calls.push(service);
      return { serviceState: service.state };
    },
    workbenchWriteService: {},
  });

  const openRes = createResponse();
  await handlers.openSignatureBrowser({}, openRes);
  assert.equal(openRes.statusCode, 200);
  assert.deepEqual(openRes.body, { serviceState: 'open' });

  const closeRes = createResponse();
  await handlers.closeSignatureBrowser({}, closeRes);
  assert.equal(closeRes.statusCode, 200);
  assert.deepEqual(closeRes.body, { serviceState: 'closed' });
  assert.deepEqual(calls, [{ state: 'open' }, { state: 'closed' }]);
});

test('signature handlers delegate task signature actions with route params and body payloads', async () => {
  const calls = [];
  const handlers = createWorkbenchSignatureHandlers({
    signatureSiteWorker: {},
    workbenchWriteService: {
      queueTaskWebsiteSignature: async (input) => {
        calls.push(['queue-task', input]);
        return { status: 202, body: { queued: true } };
      },
      saveManualSignature: async (input) => {
        calls.push(['save-manual', input]);
        return { status: 200, body: { ok: true } };
      },
    },
  });

  const queueRes = createResponse();
  await handlers.queueTaskWebsiteSignature({
    params: { batchId: 'batch_1', taskId: 'task_1' },
  }, queueRes);
  assert.equal(queueRes.statusCode, 202);
  assert.deepEqual(queueRes.body, { queued: true });

  const saveRes = createResponse();
  await handlers.saveManualSignature({
    params: { batchId: 'batch_1', taskId: 'task_1' },
    body: { dataUrl: 'data:image/png;base64,abc' },
  }, saveRes);
  assert.equal(saveRes.statusCode, 200);
  assert.deepEqual(saveRes.body, { ok: true });
  assert.deepEqual(calls, [
    ['queue-task', { batchId: 'batch_1', taskId: 'task_1' }],
    ['save-manual', { batchId: 'batch_1', taskId: 'task_1', dataUrl: 'data:image/png;base64,abc' }],
  ]);
});

test('signature handlers block cross-operator batch access before writing', async () => {
  let writeCalled = false;
  const handlers = createWorkbenchSignatureHandlers({
    signatureSiteWorker: {},
    loadBatch: (batchId) => ({ id: batchId, ownerUsername: 'alice' }),
    assertBatchAccess: () => {
      throw new Error('batch access denied');
    },
    workbenchWriteService: {
      queueTaskWebsiteSignature: async () => {
        writeCalled = true;
        return { status: 202, body: { queued: true } };
      },
    },
  });

  const res = createResponse();
  await handlers.queueTaskWebsiteSignature({
    params: { batchId: 'batch_1', taskId: 'task_1' },
    user: { username: 'bob', role: 'reviewer' },
  }, res);

  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'batch access denied' });
  assert.equal(writeCalled, false);
});

// ── 0729 权限审计:owner 闸的"依赖没接"与"检查通过"长得一样 ─────────────────
// ensureBatchAccess 里写着 `if (!loadBatch || !assertBatchAccess) return;` ——
// 依赖没接就**静默放行**。这在测试里是方便的(不用造这两个桩),
// 但代价是:哪天有人重构装配、漏传其中一个,5 个签名端点会一起失去 owner 校验,
// 而没有任何信号。今天在别处修的 safeLoadBatch 是同一个形状,只是这次落在**权限**上。
//
// 运行时行为不动(改成抛错会连带影响既有测试的构造方式);
// 改为在这里锁住**生产装配**:两个依赖必须都传。
test('生产装配必须给签名 handler 传 loadBatch + assertBatchAccess(否则 owner 闸静默失效)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const server = fs.readFileSync(path.join(__dirname, '..', 'workbench_server.js'), 'utf8');
  const i = server.indexOf('createWorkbenchSignatureHandlers({');
  assert.ok(i > 0, '生产装配点还在');
  const block = server.slice(i, server.indexOf('})', i));
  assert.match(block, /\bloadBatch\b/, '缺 loadBatch → ensureBatchAccess 会静默放行');
  assert.match(block, /\bassertBatchAccess\b/, '缺 assertBatchAccess → 同上');
});

// 全部 5 个受 batchId 约束的签名端点都要过 ensureBatchAccess —— 少一个就是一个越权口子
test('五个 batchId 端点都调用 ensureBatchAccess(漏一个就是一个越权口子)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'services/workbench_signature_handlers.js'), 'utf8');
  // 带分号才是调用;不带的是 `function ensureBatchAccess(req) {` 那行定义,别数进去
  const calls = (src.match(/ensureBatchAccess\(req\);/g) || []).length;
  assert.equal(calls, 5, `期望 5 处调用,实际 ${calls} —— 新增 batchId 端点时别忘了加`);
});
