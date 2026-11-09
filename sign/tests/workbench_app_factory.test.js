const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { registerCustomerLibraryRoutes } = require('../routes/customer_library_routes');
const { registerAuthRoutes } = require('../routes/auth_routes');
const { registerWorkbenchRoutes } = require('../routes/workbench_routes');
const { createWorkbenchApp } = require('../server/create_app');
const { UserService } = require('../services/user_service');

const WORKBENCH_HANDLER_NAMES = [
  'getHealth',
  'getState',
  'getMyTodos',
  'openSignatureBrowser',
  'closeSignatureBrowser',
  'getBatch',
  'deleteBatch',
  'importBatch',
  'importBatchLedger',
  'createManualReceiptFromTask',
  'setTaskDocBox',
  'getTaskOriginalImage',
  'rereadTaskBox',
// ⚠️ 这份名单是**桩**:它验的是"注册路由这段代码本身能跑",
// **不验**生产真的有这个 handler。0731 有过一次:新 handler 加了路由、
// 忘了进 workbench_server.js 的聚合表,服务启动即炸,而这里只要把名字
// 补进名单就绿了。真正管那件事的是 tests/route_handler_aggregate_table.test.js。
  'updateTask',
  'requeueTasks',
  'resplitTask',
  'approveSourceGroup',
  'settleSourceGroup',
  'confirmGroupModes',
  'correctGroupLedger',
  'getGroupTourCandidates',
  'confirmGroupTour',
  'unconfirmGroupTour',
  'markGroupTourResponded',
  'getTourPrior',
  'listSendbackQueue',
  'markSendbackDone',
  'deleteSourceGroupCustomer',
  'deleteTask',
  'queueTaskWebsiteSignature',
  'queueBatchWebsiteSignatures',
  'deleteWebsiteSignature',
  'saveManualSignature',
  'deleteManualSignature',
  'exportBatch',
  'exportCustomerData',
  'exportHyundaiDelivery',
  'exportLotteDeptDelivery',
  'exportModeDelivery',
];

const CUSTOMER_HANDLER_NAMES = [
  'getCustomerLibraryState',
  'setCustomerLibraryRoot',
  'listCustomerLibraryWorkspaces',
  'ensureCustomerLibraryWorkspace',
  'deleteCustomerLibraryWorkspace',
  'listWorkspaceCustomers',
  'deleteWorkspaceCustomer',
  'getCustomerImageFile',
  'confirmWorkspaceCustomerImage',
  'deleteWorkspaceCustomerImage',
  'createCustomer',
  'createCustomerFromFiles',
  'appendCustomerImagesFromFiles',
  'preprocessWorkspaceCustomers',
  'preprocessWorkspaceCustomer',
  'importCustomerWorkspace',
  'appendCustomerWorkspaceToBatch',
  'appendCustomerToBatch',
  'replaceBatchGroupCode',
  'listLibraryOrphans',
  'deleteLibraryOrphans',
];

function createJsonHandler(payload = { ok: true }) {
  return (_req, res) => res.json(payload);
}

function createHandlers(handlerNames, overrides = {}) {
  const handlers = {};
  handlerNames.forEach((name) => {
    handlers[name] = createJsonHandler({ ok: true, route: name });
  });
  return {
    ...handlers,
    ...overrides,
  };
}

test('createWorkbenchApp builds an app with injected dependencies and routes', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-app-factory-'));
  const appDir = path.join(tempRoot, 'app');
  const distDir = path.join(appDir, 'dist');
  const batchesRoot = path.join(tempRoot, 'batches');
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(distDir, { recursive: true });
  fs.mkdirSync(batchesRoot, { recursive: true });
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><title>Vue Shell</title>', 'utf8');

  const upload = {
    array() {
      return (_req, _res, next) => next();
    },
  };

  const app = createWorkbenchApp({
    projectRoot: tempRoot,
    appDir,
    batchesRoot,
    upload,
    registerWorkbenchRoutes,
    registerCustomerLibraryRoutes,
    workbenchHandlers: createHandlers(WORKBENCH_HANDLER_NAMES, {
      getHealth: createJsonHandler({ ok: true }),
    }),
    customerLibraryHandlers: createHandlers(CUSTOMER_HANDLER_NAMES, {
      getCustomerLibraryState: createJsonHandler({ ok: true, scope: 'customer-library' }),
    }),
  });

  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });

  t.after(() => {
    server.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const { port } = server.address();

  const healthResponse = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(healthResponse.status, 200);
  assert.deepEqual(await healthResponse.json(), { ok: true });
  // 版本水位(2026-07-07):每个响应带 X-App-Boot,长开的 SPA 据此发现后端已更新提示刷新
  assert.ok(healthResponse.headers.get('x-app-boot'), '响应应带 X-App-Boot 版本水位');

  const customerStateResponse = await fetch(`http://127.0.0.1:${port}/api/customer-library/state`);
  assert.equal(customerStateResponse.status, 200);
  assert.deepEqual(await customerStateResponse.json(), { ok: true, scope: 'customer-library' });

  const rootResponse = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual' });
  assert.equal(rootResponse.status, 302);
  assert.equal(rootResponse.headers.get('location'), '/app/dist/');

  const loginPageResponse = await fetch(`http://127.0.0.1:${port}/login`, { redirect: 'manual' });
  assert.equal(loginPageResponse.status, 302);
  assert.equal(loginPageResponse.headers.get('location'), '/app/dist/login');

  const vueFallbackResponse = await fetch(`http://127.0.0.1:${port}/app/dist/field-review/latest`);
  assert.equal(vueFallbackResponse.status, 200);
  assert.equal(await vueFallbackResponse.text(), '<!doctype html><title>Vue Shell</title>');
});

test('createWorkbenchApp can protect API routes with auth middleware', async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-app-auth-'));
  const appDir = path.join(tempRoot, 'app');
  const batchesRoot = path.join(tempRoot, 'batches');
  const trainExportsRoot = path.join(tempRoot, 'train-exports');
  const deniedStorageDir = path.join(batchesRoot, 'batch-denied', 'source');
  fs.mkdirSync(appDir, { recursive: true });
  fs.mkdirSync(batchesRoot, { recursive: true });
  fs.mkdirSync(trainExportsRoot, { recursive: true });
  fs.mkdirSync(deniedStorageDir, { recursive: true });
  fs.writeFileSync(path.join(deniedStorageDir, 'demo.txt'), 'secret batch file', 'utf8');
  fs.writeFileSync(path.join(trainExportsRoot, 'dataset.txt'), 'training data', 'utf8');

  const userService = new UserService({ dbPath: path.join(tempRoot, 'auth.sqlite') });
  const reviewer = await userService.createUser('reviewer', 'secret123', 'reviewer');

  const upload = {
    array() {
      return (_req, _res, next) => next();
    },
  };

  const app = createWorkbenchApp({
    projectRoot: tempRoot,
    appDir,
    batchesRoot,
    trainExportsRoot,
    upload,
    registerAuthRoutes,
    registerWorkbenchRoutes,
    registerCustomerLibraryRoutes,
    auth: {
      jwtSecret: 'test-secret',
      userService,
    },
    storageAccessMiddleware(req, res, next) {
      if (String(req.path || '').includes('batch-denied')) {
        return res.status(403).json({ error: 'batch access denied' });
      }
      return next();
    },
    workbenchHandlers: createHandlers(WORKBENCH_HANDLER_NAMES, {
      getHealth: createJsonHandler({ ok: true }),
    }),
    customerLibraryHandlers: createHandlers(CUSTOMER_HANDLER_NAMES),
  });

  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });

  t.after(() => {
    server.close();
    userService.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const healthResponse = await fetch(`${baseUrl}/api/health`);
  assert.equal(healthResponse.status, 200);

  const blockedResponse = await fetch(`${baseUrl}/api/state`);
  assert.equal(blockedResponse.status, 401);

  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'reviewer', password: 'secret123' }),
  });
  const cookie = loginResponse.headers.get('set-cookie');
  assert.equal(loginResponse.status, 200);

  const stateResponse = await fetch(`${baseUrl}/api/state`, {
    headers: { cookie },
  });
  assert.equal(stateResponse.status, 200);

  const deniedStorageResponse = await fetch(`${baseUrl}/storage/batch-denied/source/demo.txt`, {
    headers: { cookie },
  });
  assert.equal(deniedStorageResponse.status, 403);
  assert.deepEqual(await deniedStorageResponse.json(), { error: 'batch access denied' });

  // ⭐ 2026-08-01:上面那条**带着 cookie**,验的是「登录了但没这个批次的权限 → 403」。
  // 它从来没验过「**完全不登录**会怎样」—— 而 /storage 下面放的是批次原图:
  // 护照扫描件、小票照片。变异验证过:把 create_app.js 的
  // `const storageMiddlewares = [routeAuth.authenticateToken]` 改成 `= []`
  // (鉴权中间件整个摘掉),这个测试**照样绿**,而任何人不登录就能拉护照扫描件。
  // 代码上方的注释白纸黑字写着 "Protect /storage route",却没有任何断言在守它。
  const anonymousStorage = await fetch(`${baseUrl}/storage/batch-allowed/source/demo.txt`);
  assert.ok(anonymousStorage.status === 401 || anonymousStorage.status === 403,
    `不带任何凭据访问 /storage 返回了 ${anonymousStorage.status} —— `
    + '这下面是护照扫描件和小票照片,必须先过登录闸');
  // 反向对照:同一个路径**带上 cookie** 时不该是 401 ——
  // 否则上一条可能只是"这个路径本来就不存在",而不是"鉴权在起作用"
  const authedStorage = await fetch(`${baseUrl}/storage/batch-allowed/source/demo.txt`, {
    headers: { cookie },
  });
  assert.notEqual(authedStorage.status, 401,
    '带凭据时不该还是 401 —— 否则上一条证明不了鉴权,只证明了路径不通');

  const reviewerTrainExportResponse = await fetch(`${baseUrl}/train-exports/dataset.txt`, {
    headers: { cookie },
  });
  assert.equal(reviewerTrainExportResponse.status, 403);

  await userService.deleteUser(reviewer.id);
  const disabledTokenResponse = await fetch(`${baseUrl}/api/state`, {
    headers: { cookie },
  });
  assert.equal(disabledTokenResponse.status, 401);
});
