const test = require('node:test');
const assert = require('node:assert/strict');

const { createCustomerLibraryHandlers } = require('../services/customer_library_handlers');

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

function createHandlers({ customerIntakeService, workbenchStateService, removeReviewCustomerGroup, ...rest } = {}) {
  return createCustomerLibraryHandlers({
    ...rest,
    customerIntakeService: customerIntakeService || {
      setActiveRoot(rootPath) {
        return `active:${rootPath}`;
      },
      listWorkspaces() {
        return ['workspace-a', 'workspace-b'];
      },
      listMonths() {
        return ['workspace-a', 'workspace-b'];
      },
      ensureWorkspace(workspaceKey) {
        return `D:/library/${workspaceKey}`;
      },
      listCustomers(workspaceKey) {
        return [{ customerId: 'CL-001', workspaceKey }];
      },
      createCustomer({ workspaceKey, agentName, images }) {
        return {
          customer: { customerId: 'CL-001', workspaceKey, agentName, images },
          customers: [{ customerId: 'CL-001' }],
        };
      },
      async createCustomerFromFiles({ workspaceKey, agentName, files, editManifest }) {
        return {
          customer: { customerId: 'CL-002', workspaceKey, agentName, fileCount: files.length, editManifest },
          customers: [{ customerId: 'CL-002' }],
        };
      },
      deleteWorkspace({ workspaceKey, force }) {
        return { deleted: true, workspaceKey, force };
      },
      deleteCustomer({ workspaceKey, customerId, force }) {
        return { deleted: true, workspaceKey, customerId, force };
      },
    },
    workbenchStateService: workbenchStateService || {
      getCustomerLibraryState() {
        return { activeRoot: 'D:/library' };
      },
    },
    removeReviewCustomerGroup,
  });
}

test('customer library handlers keep workspace management response contracts', () => {
  const handlers = createHandlers();

  const setRootRes = createJsonResponse();
  handlers.setCustomerLibraryRoot({ body: { rootPath: 'D:/next-library' } }, setRootRes);
  assert.deepEqual(setRootRes.body, {
    ok: true,
    activeRoot: 'active:D:/next-library',
    workspaceKey: 'workspace-b',
    workspaces: ['workspace-a', 'workspace-b'],
    months: ['workspace-a', 'workspace-b'],
  });

  const ensureRes = createJsonResponse();
  handlers.ensureCustomerLibraryWorkspace({ body: { workspaceKey: 'workspace-c' } }, ensureRes);
  assert.deepEqual(ensureRes.body, {
    ok: true,
    workspaceKey: 'workspace-c',
    workspacePath: 'D:/library/workspace-c',
    workspaces: ['workspace-a', 'workspace-b'],
    months: ['workspace-a', 'workspace-b'],
  });

  const listRes = createJsonResponse();
  handlers.listCustomerLibraryWorkspaces({}, listRes);
  assert.deepEqual(listRes.body, {
    ok: true,
    workspaceKey: 'workspace-b',
    workspaces: ['workspace-a', 'workspace-b'],
    months: ['workspace-a', 'workspace-b'],
  });
});

test('customer library handlers keep customer create, upload, list, and delete contracts', async () => {
  const handlers = createHandlers();

  const listRes = createJsonResponse();
  handlers.listWorkspaceCustomers({ params: { workspaceKey: 'workspace-a' } }, listRes);
  assert.deepEqual(listRes.body, {
    ok: true,
    workspaceKey: 'workspace-a',
    monthKey: 'workspace-a',
    customers: [{ customerId: 'CL-001', workspaceKey: 'workspace-a' }],
  });

  const createRes = createJsonResponse();
  handlers.createCustomer({
    body: { workspaceKey: 'workspace-a', agentName: 'Agent Kim', images: [{ imageId: 'img_001' }] },
  }, createRes);
  assert.deepEqual(createRes.body, {
    ok: true,
    customer: {
      customerId: 'CL-001',
      workspaceKey: 'workspace-a',
      agentName: 'Agent Kim',
      images: [{ imageId: 'img_001' }],
    },
    customers: [{ customerId: 'CL-001' }],
    workspaceKey: 'workspace-a',
    workspaces: ['workspace-a', 'workspace-b'],
  });

  const uploadRes = createJsonResponse();
  await handlers.createCustomerFromFiles({
    body: {
      workspaceKey: 'workspace-a',
      agentName: 'Agent Lee',
      batchId: 'batch-a', // 批次前置:上传必须带当前审核批次
      editManifest: JSON.stringify([{ mode: 'single' }]),
    },
    files: [{ path: 'upload-a.jpg' }],
  }, uploadRes);
  assert.equal(uploadRes.body.ok, true);
  assert.equal(uploadRes.body.customer.customerId, 'CL-002');
  assert.deepEqual(uploadRes.body.customer.editManifest, [{ mode: 'single' }]);
  assert.deepEqual(uploadRes.body.workspaces, ['workspace-a', 'workspace-b']);

  const deleteCustomerRes = createJsonResponse();
  await handlers.deleteWorkspaceCustomer({
    params: { workspaceKey: 'workspace-a', customerId: 'CL-001' },
  }, deleteCustomerRes);
  assert.equal(deleteCustomerRes.body.deleted, true);
  assert.equal(deleteCustomerRes.body.force, true);
  assert.deepEqual(deleteCustomerRes.body.customers, [{ customerId: 'CL-001', workspaceKey: 'workspace-a' }]);

  const deleteWorkspaceRes = createJsonResponse();
  await handlers.deleteCustomerLibraryWorkspace({
    params: { workspaceKey: 'workspace-a' },
  }, deleteWorkspaceRes);
  assert.equal(deleteWorkspaceRes.body.deleted, true);
  assert.equal(deleteWorkspaceRes.body.workspaceKey, 'workspace-b');
});

test('批次前置:建档上传缺batchId/批次不存在/工作区不符 → 400,合法则放行', async () => {
  const handlers = createHandlers({
    batchExists: (id) => id === 'batch-a',
    loadBatchForGuard: (id) => (id === 'batch-a' ? { id, monthlyWorkspaceKey: 'workspace-a' } : null),
  });
  const baseReq = (extra = {}) => ({
    body: { workspaceKey: 'workspace-a', agentName: 'Agent Lee', ...extra },
    files: [{ path: 'u.jpg' }],
  });

  // 缺 batchId → 400
  const r1 = createJsonResponse();
  await handlers.createCustomerFromFiles(baseReq(), r1);
  assert.equal(r1.statusCode, 400);
  assert.match(r1.body.error, /先建立|当前审核批次/);

  // 批次不存在 → 400
  const r2 = createJsonResponse();
  await handlers.createCustomerFromFiles(baseReq({ batchId: 'batch-deleted' }), r2);
  assert.equal(r2.statusCode, 400);
  assert.match(r2.body.error, /不存在/);

  // 批次工作区 ≠ 上传工作区 → 400(跨工作区串台方向的守卫)
  const handlers2 = createHandlers({
    batchExists: () => true,
    loadBatchForGuard: () => ({ monthlyWorkspaceKey: 'workspace-b' }),
  });
  const r3 = createJsonResponse();
  await handlers2.createCustomerFromFiles(baseReq({ batchId: 'batch-b' }), r3);
  assert.equal(r3.statusCode, 400);
  assert.match(r3.body.error, /工作区.*不一致/);

  // 合法 → 放行
  const r4 = createJsonResponse();
  await handlers.createCustomerFromFiles(baseReq({ batchId: 'batch-a' }), r4);
  assert.equal(r4.body.ok, true);
});

test('customer library delete syncs an unreviewed customer group out of the review batch', async () => {
  const calls = [];
  const handlers = createHandlers({
    removeReviewCustomerGroup: async (args) => {
      calls.push(args);
      return { removed: true, batchId: 'batch-a', groupKey: 'CL-001' };
    },
  });
  const reqUser = { id: 9, userId: 9, username: 'reviewer-a', role: 'reviewer' };

  const res = createJsonResponse();
  await handlers.deleteWorkspaceCustomer({
    params: { workspaceKey: 'workspace-a', customerId: 'CL-001' },
    user: reqUser,
  }, res);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].workspaceKey, 'workspace-a');
  assert.equal(calls[0].customerId, 'CL-001');
  assert.equal(calls[0].operatorUser.username, 'reviewer-a');
  assert.deepEqual(res.body.reviewSync, { removed: true, batchId: 'batch-a', groupKey: 'CL-001' });
});

test('customer library handlers return 400 for missing required request fields', async () => {
  const handlers = createHandlers();

  const missingRootRes = createJsonResponse();
  handlers.setCustomerLibraryRoot({ body: {} }, missingRootRes);
  assert.equal(missingRootRes.statusCode, 400);
  assert.deepEqual(missingRootRes.body, { error: 'rootPath is required' });

  const missingCreateAgentRes = createJsonResponse();
  handlers.createCustomer({ body: { workspaceKey: 'workspace-a' } }, missingCreateAgentRes);
  assert.equal(missingCreateAgentRes.statusCode, 400);
  assert.deepEqual(missingCreateAgentRes.body, { error: 'agentName is required' });

  const missingUploadFilesRes = createJsonResponse();
  await handlers.createCustomerFromFiles({
    body: { workspaceKey: 'workspace-a', agentName: 'Agent Lee', batchId: 'batch-a' },
    files: [],
  }, missingUploadFilesRes);
  assert.equal(missingUploadFilesRes.statusCode, 400);
  assert.deepEqual(missingUploadFilesRes.body, { error: 'No files uploaded' });
});

test('customer library handlers pass current operator into customer listing and creation', async () => {
  const calls = [];
  const handlers = createHandlers({
    customerIntakeService: {
      setActiveRoot() {},
      listWorkspaces() {
        return ['workspace-a'];
      },
      listMonths() {
        return ['workspace-a'];
      },
      ensureWorkspace() {},
      listCustomers(workspaceKey, operatorUser) {
        calls.push({ type: 'list', workspaceKey, operatorUser });
        return [{ customerId: 'CL20260518-001', ownerUsername: operatorUser?.username }];
      },
      createCustomer(args) {
        calls.push({ type: 'create', args });
        return {
          customer: { customerId: 'CL20260518-001', ownerUsername: args.ownerUser?.username },
          customers: [],
        };
      },
      async createCustomerFromFiles(args) {
        calls.push({ type: 'upload', args });
        return {
          customer: { customerId: 'CL20260518-002', ownerUsername: args.ownerUser?.username },
          customers: [],
        };
      },
      deleteWorkspace() {},
      deleteCustomer() {},
    },
  });

  const reqUser = { id: 7, userId: 7, username: 'alice', role: 'reviewer' };

  const listRes = createJsonResponse();
  handlers.listWorkspaceCustomers({ params: { workspaceKey: 'workspace-a' }, user: reqUser }, listRes);
  assert.equal(calls[0].type, 'list');
  assert.equal(calls[0].operatorUser.username, 'alice');

  const createRes = createJsonResponse();
  handlers.createCustomer({
    body: { workspaceKey: 'workspace-a', agentName: 'Agent A' },
    user: reqUser,
  }, createRes);
  assert.equal(calls[1].type, 'create');
  assert.equal(calls[1].args.ownerUser.username, 'alice');
  assert.equal(createRes.body.customer.ownerUsername, 'alice');

  const uploadRes = createJsonResponse();
  await handlers.createCustomerFromFiles({
    body: { workspaceKey: 'workspace-a', agentName: 'Agent A', batchId: 'batch-a' },
    files: [{ path: 'upload-a.jpg' }],
    user: reqUser,
  }, uploadRes);
  assert.equal(calls[2].type, 'upload');
  assert.equal(calls[2].args.ownerUser.username, 'alice');
  assert.equal(uploadRes.body.customer.ownerUsername, 'alice');
});

test('customer library handlers scope workspace listings to the current operator', () => {
  const calls = [];
  const handlers = createHandlers({
    customerIntakeService: {
      setActiveRoot(rootPath) {
        return `active:${rootPath}`;
      },
      listWorkspaces(operatorUser) {
        calls.push({ type: 'listWorkspaces', operatorUser });
        return operatorUser?.username === 'alice' ? ['alice-workspace'] : ['all-workspace'];
      },
      listMonths(operatorUser) {
        calls.push({ type: 'listMonths', operatorUser });
        return operatorUser?.username === 'alice' ? ['alice-workspace'] : ['all-workspace'];
      },
      ensureWorkspace(workspaceKey, options) {
        calls.push({ type: 'ensureWorkspace', workspaceKey, options });
        return `D:/library/${workspaceKey}`;
      },
      listCustomers() {
        return [];
      },
      createCustomer() {
        return { customer: {}, customers: [] };
      },
      async createCustomerFromFiles() {
        return { customer: {}, customers: [] };
      },
      deleteWorkspace() {},
      deleteCustomer() {},
    },
  });
  const reqUser = { id: 7, userId: 7, username: 'alice', role: 'reviewer' };

  const listRes = createJsonResponse();
  handlers.listCustomerLibraryWorkspaces({ user: reqUser }, listRes);
  assert.deepEqual(listRes.body.workspaces, ['alice-workspace']);
  assert.equal(calls[0].operatorUser.username, 'alice');

  const ensureRes = createJsonResponse();
  handlers.ensureCustomerLibraryWorkspace({
    body: { workspaceKey: 'alice-workspace' },
    user: reqUser,
  }, ensureRes);
  assert.equal(calls.find((call) => call.type === 'ensureWorkspace').options.ownerUser.username, 'alice');
  assert.deepEqual(ensureRes.body.workspaces, ['alice-workspace']);
});

// ── 0729 静默排查:批次记录读不出来时,跨工作区护栏被短路跳过 ─────────────
// 旧写法 `try { return loadBatch(id) } catch { return null }` 把「没接加载器」和
// 「加载器抛错(batch.json 损坏)」压成同一个 null,而护栏写作
// `batchWorkspace && batchWorkspace !== workspaceKey` —— 左值为空就短路,护栏形同虚设。
// 后果不是丢图:客户会正常建档,但下游桥接的第二道护栏会判它跨工作区并跳过,
// 客户从此**悬在库里、永远进不了任何批次的审核队列**,而没有一处告诉操作员为什么。
test('批次记录读不出来(batch.json 损坏)→ 当场 400,不得放行到一个稍后必被跳过的批次', async () => {
  const handlers = createHandlers({
    batchExists: () => true, // 目录还在,所以 batchExists 是过的
    loadBatchForGuard: () => { throw new Error('Unexpected end of JSON input'); },
  });
  const res = createJsonResponse();
  await handlers.createCustomerFromFiles({
    body: { workspaceKey: 'workspace-a', agentName: 'Agent Lee', batchId: 'batch-broken' },
    files: [{ path: 'u.jpg' }],
  }, res);

  assert.equal(res.statusCode, 400, '必须拦下,而不是静默放行');
  assert.match(res.body.error, /读不出来|损坏/, '说清是批次记录坏了');
  assert.match(res.body.error, /重选或新建批次/, '给出可执行的下一步');
  assert.match(res.body.error, /Unexpected end of JSON input/, '带上技术信息便于排查');
});

test('没接批次加载器时不误拦(护栏不适用 ≠ 护栏失败)', async () => {
  // loadBatchForGuard 未提供 → 无从校验工作区,但这不是故障,不该拦住正常上传
  const handlers = createHandlers({ batchExists: () => true });
  const res = createJsonResponse();
  await handlers.createCustomerFromFiles({
    body: { workspaceKey: 'workspace-a', agentName: 'Agent Lee', batchId: 'batch-a' },
    files: [{ path: 'u.jpg' }],
  }, res);
  assert.equal(res.body.ok, true, '两种 null 必须分开:没接 ≠ 读失败');
});
