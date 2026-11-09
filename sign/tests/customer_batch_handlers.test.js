const test = require('node:test');
const assert = require('node:assert/strict');

const { createCustomerBatchHandlers } = require('../services/customer_batch_handlers');

function createRes() {
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

function createHandlers(overrides = {}) {
  const scheduled = [];
  const loadedBatches = [];
  const lockCalls = []; // 记录每次 withBatchWrite(batchId, action, {label}),验证追加/换表都上锁
  const customersByWorkspace = new Map();
  const handlers = createCustomerBatchHandlers({
    withBatchWrite(batchId, action, options = {}) {
      lockCalls.push({ batchId, label: options.label || '' });
      return action();
    },
    customerIntakeService: {
      appendCustomerImagesFromFiles(args) {
        return {
          customerId: args.customerId,
          images: args.files.map((file, index) => ({ imageId: `img-${index + 1}`, name: file.originalname })),
        };
      },
      listCustomers(workspaceKey) {
        return customersByWorkspace.get(workspaceKey) || [{ customerId: 'customer-1' }];
      },
      listWorkspaces() {
        return [{ workspaceKey: 'workspace-1' }];
      },
      ...(overrides.customerIntakeService || {}),
    },
    customerBatchBridgeService: {
      importWorkspaceToBatch() {
        return { batch: { id: 'batch-imported' } };
      },
      appendWorkspaceToBatch() {
        return { appendedCustomers: 1, appendedTasks: 2 };
      },
      appendCustomerToBatch() {
        return { appendedCustomers: 1, appendedTasks: 3, batch: { id: 'batch-1' } };
      },
      ...(overrides.customerBatchBridgeService || {}),
    },
    scheduleBatch(batchId) {
      scheduled.push(batchId);
    },
    loadBatch(batchId) {
      loadedBatches.push(batchId);
      return { id: batchId, tasks: [{ id: 'task-1' }] };
    },
    summarizeBatch(batch, options) {
      return { id: batch.id, includeTasks: Boolean(options?.includeTasks) };
    },
  });
  return { handlers, scheduled, loadedBatches, lockCalls, customersByWorkspace };
}

test('customer batch handlers import a workspace and schedule its review batch', async () => {
  const { handlers, scheduled, loadedBatches } = createHandlers();
  const res = createRes();

  await handlers.importCustomerWorkspace({
    // 2026-07-09 起建批次必须绑团号表:最少要声明文件名(两步走),否则 400。
    body: { workspaceKey: 'workspace-1', batchName: '0505test', scenario: 'FullProcess', groupCodeSourceFile: '团号表.xlsx' },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(scheduled, ['batch-imported']);
  assert.deepEqual(loadedBatches, ['batch-imported']);
  assert.deepEqual(res.body, {
    ok: true,
    batchId: 'batch-imported',
    groupCodeStatus: 'none',
    batch: { id: 'batch-imported', includeTasks: false },
  });
});

test('建批次没绑团号表被 400 拒绝(不建批次不排程)', async () => {
  const bridgeCalls = [];
  const { handlers, scheduled } = createHandlers({
    customerBatchBridgeService: {
      importWorkspaceToBatch(args) {
        bridgeCalls.push(args);
        return { batch: { id: 'batch-should-not-exist' } };
      },
    },
  });
  const res = createRes();

  await handlers.importCustomerWorkspace({
    body: { workspaceKey: 'workspace-1', batchName: 'no-table', scenario: 'FullProcess' },
  }, res);

  assert.equal(res.statusCode, 400);
  assert.match(String(res.body?.error || ''), /团号表/);
  assert.equal(bridgeCalls.length, 0, '闸必须在 bridge 之前,不许建出批次');
  assert.deepEqual(scheduled, []);
});

test('两步走:只声明团号表文件名(不带文件)允许建批次并透传声明', async () => {
  const received = [];
  const { handlers } = createHandlers({
    customerBatchBridgeService: {
      importWorkspaceToBatch(args) {
        received.push(args);
        return { batch: { id: 'batch-declared' } };
      },
    },
  });
  const res = createRes();

  await handlers.importCustomerWorkspace({
    body: { workspaceKey: 'workspace-1', batchName: 'declared', scenario: 'FullProcess', allowEmpty: 'true', groupCodeSourceFile: 'gc-0709.xlsx' },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(received[0].groupCodeSourceFile, 'gc-0709.xlsx');
  assert.equal(received[0].allowEmpty, true);
});

test('customer batch handlers pass monthly group-code binding into new batch import', async () => {
  const received = [];
  const { handlers } = createHandlers({
    customerBatchBridgeService: {
      importWorkspaceToBatch(args) {
        received.push(args);
        return { batch: { id: 'batch-imported' } };
      },
    },
  });
  const res = createRes();

  await handlers.importCustomerWorkspace({
    body: {
      workspaceKey: 'workspace-1',
      batchName: '0505test',
      scenario: 'FullProcess',
      monthlyWorkspaceKey: '2026-05',
      groupCodeImportJobId: 'job-group-1',
      groupCodeSourceFile: '团号表.xlsx',
    },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(received[0].monthlyWorkspaceKey, '2026-05');
  assert.equal(received[0].groupCodeImportJobId, 'job-group-1');
  assert.equal(received[0].groupCodeSourceFile, '团号表.xlsx');
});

test('customer batch handlers append one customer and schedule only when tasks were added', async () => {
  const { handlers, scheduled } = createHandlers({
    customerBatchBridgeService: {
      appendCustomerToBatch({ workspaceKey, customerId, batchId }) {
        assert.equal(workspaceKey, 'workspace-1');
        assert.equal(customerId, 'customer-1');
        assert.equal(batchId, 'batch-1');
        return { appendedCustomers: 1, appendedTasks: 0 };
      },
    },
  });
  const res = createRes();

  await handlers.appendCustomerToBatch({
    body: { workspaceKey: 'workspace-1', customerId: 'customer-1', batchId: 'batch-1' },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(scheduled, []);
  assert.deepEqual(res.body.batch, { id: 'batch-1', includeTasks: true });
  assert.equal(res.body.appendedTasks, 0);
});

test('customer batch handlers append uploaded customer images and mirror batch append counts', async () => {
  const { handlers, scheduled } = createHandlers();
  const res = createRes();

  await handlers.appendCustomerImagesFromFiles({
    params: { workspaceKey: 'workspace-1', customerId: 'customer-1' },
    body: { batchId: 'batch-1', editManifest: JSON.stringify([{ fileName: 'receipt.jpg' }]) },
    files: [{ originalname: 'receipt.jpg' }],
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(scheduled, ['batch-1']);
  assert.equal(res.body.appendedCustomers, 1);
  assert.equal(res.body.appendedTasks, 3);
  assert.deepEqual(res.body.batch, { id: 'batch-1', includeTasks: true });
  assert.deepEqual(res.body.workspaces, [{ workspaceKey: 'workspace-1' }]);
});

test('追加图片/追加客户/追加工作区/换团号表 都必须走 withBatchWrite 锁(2026-07-13 修丢数据:否则与审核并发互吞)', async () => {
  // ① 追加图片(审核台常规操作,最易与审核并发)
  {
    const { handlers, lockCalls } = createHandlers();
    await handlers.appendCustomerImagesFromFiles({
      params: { workspaceKey: 'w', customerId: 'c' },
      body: { batchId: 'batch-X' },
      files: [{ originalname: 'r.jpg' }],
    }, createRes());
    assert.equal(lockCalls.length, 1, '追加图片必须经过 withBatchWrite');
    assert.equal(lockCalls[0].batchId, 'batch-X');
  }
  // ② 追加单客户
  {
    const { handlers, lockCalls } = createHandlers();
    await handlers.appendCustomerToBatch({ body: { workspaceKey: 'w', customerId: 'c', batchId: 'batch-Y' } }, createRes());
    assert.equal(lockCalls.length, 1);
    assert.equal(lockCalls[0].batchId, 'batch-Y');
  }
  // ③ 追加整个工作区
  {
    const { handlers, lockCalls } = createHandlers();
    await handlers.appendCustomerWorkspaceToBatch({ body: { workspaceKey: 'w', batchId: 'batch-Z' } }, createRes());
    assert.equal(lockCalls.length, 1);
    assert.equal(lockCalls[0].batchId, 'batch-Z');
  }
  // ④ 换团号表
  {
    const { handlers, lockCalls } = createHandlers({
      customerBatchBridgeService: { replaceBatchGroupCode() { return { pendingGroupCode: null, groupCodeStatus: 'parsing' }; } },
    });
    await handlers.replaceBatchGroupCode({
      params: { batchId: 'batch-G' },
      file: { path: '/tmp/gc.xlsx', originalname: 'gc.xlsx' },
    }, createRes());
    assert.ok(lockCalls.some((c) => c.batchId === 'batch-G'), '换团号表必须经过 withBatchWrite');
  }
});

test('追加工作区:T6-B 改道在当前锁外逐个 withBatchWrite(intended) 执行(死锁修复 审计HIGH line510)', async () => {
  const appendCustomerCalls = [];
  const { handlers, lockCalls, scheduled } = createHandlers({
    customerBatchBridgeService: {
      importWorkspaceToBatch() { return { batch: { id: 'x' } }; },
      appendWorkspaceToBatch() {
        // service 只收集改道,不就地执行
        return {
          appendedCustomers: 1,
          appendedTasks: 2,
          pendingRedirects: [
            { customerId: 'c1', intended: 'batchOld' },
            { customerId: 'c2', intended: 'batchOld2' },
          ],
        };
      },
      appendCustomerToBatch(args) {
        appendCustomerCalls.push(args);
        return { appendedCustomers: 1, appendedTasks: 1, batch: { id: args.batchId } };
      },
    },
  });

  const res = createRes();
  await handlers.appendCustomerWorkspaceToBatch({ body: { workspaceKey: 'wsT', batchId: 'batchNew' }, user: { username: 'op' } }, res);

  // 锁序列=[当前批次, 意向1, 意向2],三把锁各自单独获取(不嵌套)——当前锁先跑完释放,再逐个取意向锁
  assert.deepEqual(lockCalls.map((c) => c.batchId), ['batchNew', 'batchOld', 'batchOld2']);
  assert.equal(lockCalls[0].label, 'appendWorkspaceToBatch');
  assert.equal(lockCalls[1].label, 'appendWorkspaceRedirect', '意向批次走独立改道锁');
  assert.equal(lockCalls[2].label, 'appendWorkspaceRedirect');
  // 改道各自追加到意向批次(不是当前批次)
  assert.deepEqual(appendCustomerCalls.map((c) => c.batchId), ['batchOld', 'batchOld2']);
  assert.deepEqual(appendCustomerCalls.map((c) => c.customerId), ['c1', 'c2']);
  // 响应回报改道计数;意向批次各自插队补识别
  assert.equal(res.body.redirectedCustomers, 2);
  assert.equal(res.body.redirectedTasks, 2);
  assert.equal(res.body.redirectFailed, 0);
  assert.ok(scheduled.includes('batchOld') && scheduled.includes('batchOld2'), '有新任务的意向批次插队补识别');
});

test('追加工作区:单个改道失败不拖垮其余改道,计入 redirectFailed', async () => {
  const { handlers } = createHandlers({
    customerBatchBridgeService: {
      importWorkspaceToBatch() { return { batch: { id: 'x' } }; },
      appendWorkspaceToBatch() {
        return {
          appendedCustomers: 0,
          appendedTasks: 0,
          pendingRedirects: [
            { customerId: 'bad', intended: 'batchBad' },
            { customerId: 'ok', intended: 'batchOk' },
          ],
        };
      },
      appendCustomerToBatch(args) {
        if (args.customerId === 'bad') throw new Error('意向批次瞬断');
        return { appendedCustomers: 1, appendedTasks: 1, batch: { id: args.batchId } };
      },
    },
  });
  const res = createRes();
  await handlers.appendCustomerWorkspaceToBatch({ body: { workspaceKey: 'wsT', batchId: 'batchNew' }, user: { username: 'op' } }, res);
  assert.equal(res.body.ok, true, '整轮 sweep 仍成功');
  assert.equal(res.body.redirectFailed, 1);
  assert.equal(res.body.redirectedCustomers, 1, '坏改道后 ok 改道照常执行');
});

test('换团号表 owner 门禁(8模块审计HIGH):非本人 reviewer→403;本人/admin/无鉴权(内部)放行', async () => {
  function makeHandlers(bridgeCalled) {
    return createCustomerBatchHandlers({
      withBatchWrite: (batchId, action) => action(),
      customerIntakeService: { listWorkspaces: () => [], listCustomers: () => [] },
      customerBatchBridgeService: {
        replaceBatchGroupCode() { bridgeCalled.hit = true; return { pendingGroupCode: null, groupCodeStatus: 'parsing' }; },
      },
      scheduleBatch() {},
      // 批次归属 alice
      loadBatch: (id) => ({ id, ownerUsername: 'alice', ownerUserId: 11, tasks: [] }),
      summarizeBatch: (b) => ({ id: b.id }),
    });
  }
  const reqOf = (user) => ({ params: { batchId: 'batch-G' }, file: { path: '/tmp/gc.xlsx', originalname: 'gc.xlsx' }, user });

  // ① reviewer bob(非本人)→ 403,bridge 不被调用
  {
    const called = {}; const res = createRes();
    await makeHandlers(called).replaceBatchGroupCode(reqOf({ username: 'bob', userId: 22, role: 'reviewer' }), res);
    assert.equal(res.statusCode, 403, '非本人 reviewer 换表被拦');
    assert.match(res.body.error, /无权|团号表/);
    assert.ok(!called.hit, '被拦时绝不进 bridge 换表');
  }
  // ② 本人 alice → 放行
  {
    const called = {}; const res = createRes();
    await makeHandlers(called).replaceBatchGroupCode(reqOf({ username: 'alice', userId: 11, role: 'reviewer' }), res);
    assert.equal(res.statusCode, 200);
    assert.ok(called.hit, '本人可换自己批次的团号表');
  }
  // ③ admin → 放行(全局角色)
  {
    const called = {}; const res = createRes();
    await makeHandlers(called).replaceBatchGroupCode(reqOf({ username: 'root', userId: 1, role: 'admin' }), res);
    assert.equal(res.statusCode, 200);
    assert.ok(called.hit, 'admin 可换任意批次');
  }
  // ④ 无 req.user(内部/测试直调)→ 放行(canAccessAllOperatorData(null)=true,不破坏既有直调)
  {
    const called = {}; const res = createRes();
    await makeHandlers(called).replaceBatchGroupCode(reqOf(undefined), res);
    assert.equal(res.statusCode, 200);
    assert.ok(called.hit);
  }
});

test('追加图片:批次写盘在锁内执行(锁未释放前不返回),证明与审核串行', async () => {
  // 让 withBatchWrite 记录进入/离开顺序,append 的 bridge 在锁内跑
  const order = [];
  const handlers = createCustomerBatchHandlers({
    withBatchWrite(batchId, action) { order.push('lock:enter'); const r = action(); order.push('lock:exit'); return r; },
    customerIntakeService: {
      appendCustomerImagesFromFiles: (a) => ({ customerId: a.customerId, images: [] }),
      listWorkspaces: () => [], listCustomers: () => [],
    },
    customerBatchBridgeService: {
      appendCustomerToBatch() { order.push('bridge:write'); return { appendedCustomers: 1, appendedTasks: 1, batch: { id: 'b' } }; },
    },
    scheduleBatch() {}, loadBatch: (id) => ({ id, tasks: [] }), summarizeBatch: (b) => ({ id: b.id }),
  });
  await handlers.appendCustomerImagesFromFiles({ params: { workspaceKey: 'w', customerId: 'c' }, body: { batchId: 'b' }, files: [{ originalname: 'r.jpg' }] }, createRes());
  assert.deepEqual(order, ['lock:enter', 'bridge:write', 'lock:exit'], 'bridge 写盘必须夹在锁的进入/离开之间');
});

test('customer batch handlers keep required field validation close to the handoff module', async () => {
  const { handlers } = createHandlers();
  const res = createRes();

  await handlers.appendCustomerToBatch({ body: { workspaceKey: 'workspace-1' } }, res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: 'customerId is required' });
});
