'use strict';

// #5 重识别回灌批次(2026-07-14 审计):重识别成功且客户挂在批次 → 锁内自动追加新切片回批次。
// 曾经:重识别只更新客户库,批次里旧切图任务永不替换,审核台一直审旧图还全绿假信号。

const test = require('node:test');
const assert = require('node:assert/strict');

const { createWorkbenchCustomerHandlers } = require('../services/handlers/workbench/customer_handlers');

function createRes() {
  return {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

function buildHandlers(overrides = {}) {
  const calls = { append: [], lock: [], schedule: [] };
  const handlers = createWorkbenchCustomerHandlers({
    customerDocumentPreprocessService: {
      preprocessCustomer: async () => ({
        customer: { customerId: 'CL1', review: { lastBatchId: 'batch_1' } },
        summary: { inputImages: 2, outputImages: 3, splitImages: 1 },
      }),
      preprocessWorkspace: async () => ({
        results: [
          // 切了图且挂批次 → 该回灌(CL019 缺护照就是这一类漏了)
          { customer: { customerId: 'CL1', review: { lastBatchId: 'batch_1' } }, summary: { splitImages: 1 } },
          // 切了图但没挂批次 → 不回灌(还没进任何批次)
          { customer: { customerId: 'CL2', review: { lastBatchId: '' } }, summary: { splitImages: 2 } },
          // 挂了批次但没切图 → 不回灌(没有新切片会漏)
          { customer: { customerId: 'CL3', review: { lastBatchId: 'batch_1' } }, summary: { splitImages: 0 } },
        ],
        summary: { customers: 3, splitImages: 3 },
      }),
      ...(overrides.preprocess || {}),
    },
    customerImageReviewService: {},
    customerIntakeService: { listCustomers: () => [] },
    customerBatchBridgeService: {
      appendCustomerToBatch: async (args) => { calls.append.push(args); return { appendedTasks: 2, staleRemoved: 1 }; },
      ...(overrides.bridge || {}),
    },
    withBatchWrite: (batchId, action, opts = {}) => { calls.lock.push({ batchId, label: opts.label }); return action(); },
    scheduleBatch: (batchId, opts) => { calls.schedule.push({ batchId, ...opts }); },
    batchExists: overrides.batchExists || (() => true),
  });
  return { handlers, calls };
}

const REQ = { params: { workspaceKey: 'ws1', customerId: 'CL1' }, user: { username: 'op1' } };

test('重识别成功且客户挂批次 → 锁内自动回灌(追加新切片+清旧任务)并插队识别', async () => {
  const { handlers, calls } = buildHandlers();
  const res = createRes();
  await handlers.preprocessWorkspaceCustomer(REQ, res, (err) => { throw err; });

  assert.equal(res.body.ok, true);
  assert.equal(calls.append.length, 1, '必须自动回灌批次');
  assert.equal(calls.append[0].batchId, 'batch_1');
  assert.equal(calls.append[0].customerId, 'CL1');
  assert.deepEqual(calls.lock, [{ batchId: 'batch_1', label: 'reprocessAppendToBatch' }], '回灌必须走批次写锁');
  assert.deepEqual(calls.schedule, [{ batchId: 'batch_1', priority: true }], '有新任务要插队识别');
  assert.deepEqual(res.body.batchAppend, { batchId: 'batch_1', appendedTasks: 2, staleRemoved: 1 });
  assert.equal(res.body.batchAppendError, null);
});

test('客户没挂批次/批次已删 → 不回灌,重识别照常返回', async () => {
  const { handlers, calls } = buildHandlers({ batchExists: () => false });
  const res = createRes();
  await handlers.preprocessWorkspaceCustomer(REQ, res, (err) => { throw err; });
  assert.equal(res.body.ok, true);
  assert.equal(calls.append.length, 0);
  assert.equal(res.body.batchAppend, null);
});

test('回灌失败不推翻重识别本身:ok 仍 true,batchAppendError 显式回报', async () => {
  const { handlers, calls } = buildHandlers({
    bridge: { appendCustomerToBatch: async () => { throw new Error('磁盘瞬断'); } },
  });
  const res = createRes();
  await handlers.preprocessWorkspaceCustomer(REQ, res, (err) => { throw err; });
  assert.equal(res.body.ok, true, '客户库已更新,重识别是成功的');
  assert.match(String(res.body.batchAppendError), /磁盘瞬断/);
  assert.equal(calls.schedule.length, 0);
});

// ── 批量(整工作区)预处理同样回灌批次:CL019 缺护照 bug 修复(2026-07-22 生产实证)──
// 单客户预处理早有回灌安全网,批量路径此前遗漏 → 切图和批次自动追加撞时序,追加只抓到未切的
// 第一张,切出的护照区漏在库里进不了批次,审核台见"缺护照"。
const WS_REQ = { params: { workspaceKey: 'ws1' }, user: { username: 'op1' } };

test('批量预处理:只对「切了图且已挂批次」的客户回灌,其余不动', async () => {
  const { handlers, calls } = buildHandlers();
  const res = createRes();
  await handlers.preprocessWorkspaceCustomers(WS_REQ, res, (err) => { throw err; });

  assert.equal(res.body.ok, true);
  // CL1 切图+挂批次 → 回灌;CL2 没挂批次、CL3 没切图 → 跳过
  assert.equal(calls.append.length, 1, '只回灌 CL1 一个');
  assert.equal(calls.append[0].customerId, 'CL1');
  assert.equal(calls.append[0].batchId, 'batch_1');
  assert.deepEqual(calls.lock, [{ batchId: 'batch_1', label: 'bulkPreprocessAppendToBatch' }], '走批次写锁');
  assert.deepEqual(calls.schedule, [{ batchId: 'batch_1', priority: true }], '有新切片插队识别');
  assert.deepEqual(res.body.reappended, [{ customerId: 'CL1', batchId: 'batch_1', appendedTasks: 2 }]);
});

test('批量预处理:批次已删则不回灌,预处理照常返回', async () => {
  const { handlers, calls } = buildHandlers({ batchExists: () => false });
  const res = createRes();
  await handlers.preprocessWorkspaceCustomers(WS_REQ, res, (err) => { throw err; });
  assert.equal(res.body.ok, true);
  assert.equal(calls.append.length, 0);
  assert.deepEqual(res.body.reappended, []);
});

test('批量预处理:单个客户回灌抛错不推翻整批,其余客户照常', async () => {
  // 让 CL1 回灌抛错,再补一个 CL4(切图+挂批次)验证 CL1 失败不拖累后续
  const { handlers, calls } = buildHandlers({
    preprocess: {
      preprocessWorkspace: async () => ({
        results: [
          { customer: { customerId: 'CL1', review: { lastBatchId: 'batch_1' } }, summary: { splitImages: 1 } },
          { customer: { customerId: 'CL4', review: { lastBatchId: 'batch_2' } }, summary: { splitImages: 1 } },
        ],
        summary: { customers: 2, splitImages: 2 },
      }),
    },
    bridge: {
      appendCustomerToBatch: async (args) => {
        calls.append.push(args);
        if (args.customerId === 'CL1') throw new Error('CL1 磁盘瞬断');
        return { appendedTasks: 1 };
      },
    },
  });
  const res = createRes();
  await handlers.preprocessWorkspaceCustomers(WS_REQ, res, (err) => { throw err; });

  assert.equal(res.body.ok, true, '整批预处理仍成功');
  assert.equal(calls.append.length, 2, 'CL1 抛错后仍继续尝试 CL4');
  assert.deepEqual(res.body.reappended, [{ customerId: 'CL4', batchId: 'batch_2', appendedTasks: 1 }], '只有 CL4 成功回灌');
});
