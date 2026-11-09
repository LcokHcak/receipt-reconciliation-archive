'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createCustomerLibraryHandlers } = require('../services/customer_library_handlers');

function fakeRes() {
  const res = {
    _status: 200,
    _body: null,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
  };
  return res;
}

// 库存:工作区 7 有三个客户。c1 批次已删(孤儿),c2 批次还在(非孤儿),c3 没导入过(非孤儿)。
function buildDeps({ existingBatchIds = new Set(), deleted = [] } = {}) {
  const library = {
    '7': [
      { customerId: 'c1', agentName: '本司', images: [{}, {}], review: { lastBatchId: 'batch_dead' } },
      { customerId: 'c2', agentName: '新琪', images: [{}], review: { lastBatchId: 'batch_live' } },
      { customerId: 'c3', agentName: '道辉', images: [{}, {}, {}], review: {} },
    ],
  };
  const customerIntakeService = {
    listWorkspaces: () => Object.keys(library),
    listCustomers: (ws) => library[ws] || [],
    deleteCustomer: ({ workspaceKey, customerId }) => { deleted.push(`${workspaceKey}/${customerId}`); return { ok: true }; },
  };
  return {
    deps: {
      customerIntakeService,
      workbenchStateService: { getCustomerLibraryState: () => ({}) },
      removeReviewCustomerGroup: async () => null,
      batchExists: (id) => existingBatchIds.has(id),
    },
    library,
    deleted,
  };
}

test('listLibraryOrphans 只列批次已删的客户(没导入/批次还在的都不算)', () => {
  const { deps } = buildDeps({ existingBatchIds: new Set(['batch_live']) });
  const handlers = createCustomerLibraryHandlers(deps);
  const res = fakeRes();
  handlers.listLibraryOrphans({ user: null }, res);

  assert.equal(res._body.ok, true);
  assert.equal(res._body.totalCustomers, 1, '只有 c1 是孤儿');
  assert.equal(res._body.totalImages, 2);
  assert.equal(res._body.orphans[0].customerId, 'c1');
  assert.equal(res._body.orphans[0].workspaceKey, '7');
  assert.equal(res._body.orphans[0].agentName, '本司');
});

test('deleteLibraryOrphans 删孤儿;批次又活过来的二次校验跳过', async () => {
  const deleted = [];
  // c1 批次仍死(可删);谎报 c2(批次还在)→ 应被二次校验拦下
  const { deps } = buildDeps({ existingBatchIds: new Set(['batch_live']), deleted });
  const handlers = createCustomerLibraryHandlers(deps);
  const res = fakeRes();
  await handlers.deleteLibraryOrphans(
    { user: null, body: { items: [{ workspaceKey: '7', customerId: 'c1' }, { workspaceKey: '7', customerId: 'c2' }] } },
    res
  );

  assert.equal(res._body.deleted, 1);
  assert.deepEqual(deleted, ['7/c1'], '只删了 c1,c2 因批次仍在被跳过');
  const c2 = res._body.results.find((r) => r.customerId === 'c2');
  assert.equal(c2.ok, false);
  assert.match(c2.error, /批次仍存在/);
});

test('deleteLibraryOrphans 拒删非孤儿:没导入过的活客户 + 不在库的坏 id(审计MEDIUM 加固)', async () => {
  const deleted = [];
  const { deps } = buildDeps({ existingBatchIds: new Set(['batch_live']), deleted });
  const handlers = createCustomerLibraryHandlers(deps);
  const res = fakeRes();
  await handlers.deleteLibraryOrphans(
    { user: null, body: { items: [
      { workspaceKey: '7', customerId: 'c3' },     // 没 lastBatchId=从没导入过=活客户,非孤儿
      { workspaceKey: '7', customerId: 'ghost' },  // 不在库(客户端自报坏 id)
    ] } },
    res
  );
  assert.equal(res._body.deleted, 0, '两个都不该删');
  assert.deepEqual(deleted, [], '物理删一次都没发生(此前 c3 会被误删)');
  const c3 = res._body.results.find((r) => r.customerId === 'c3');
  assert.equal(c3.ok, false); assert.match(c3.error, /活客户|非孤儿/);
  const ghost = res._body.results.find((r) => r.customerId === 'ghost');
  assert.equal(ghost.ok, false); assert.match(ghost.error, /不存在/);
});

test('deleteLibraryOrphans 尊重复核视图拒绝(already_settled)不物理删', async () => {
  const deleted = [];
  const { deps } = buildDeps({ existingBatchIds: new Set(), deleted }); // batch_dead 不存在 → c1 通过孤儿判定
  deps.removeReviewCustomerGroup = async () => ({ removed: false, reason: 'already_settled' });
  const handlers = createCustomerLibraryHandlers(deps);
  const res = fakeRes();
  await handlers.deleteLibraryOrphans(
    { user: null, body: { items: [{ workspaceKey: '7', customerId: 'c1' }] } }, res
  );
  assert.equal(res._body.deleted, 0);
  assert.deepEqual(deleted, [], '复核拒绝→不物理删(照 deleteWorkspaceCustomer 先例)');
  assert.match(res._body.results[0].error, /已结算|复核/);
});

test('deleteLibraryOrphans 空 items 返回 400', async () => {
  const { deps } = buildDeps();
  const handlers = createCustomerLibraryHandlers(deps);
  const res = fakeRes();
  await handlers.deleteLibraryOrphans({ user: null, body: { items: [] } }, res);
  assert.equal(res._status, 400);
});
