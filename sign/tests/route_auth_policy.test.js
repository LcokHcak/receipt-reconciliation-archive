const assert = require('node:assert/strict');
const test = require('node:test');

const { registerCustomerLibraryRoutes } = require('../routes/customer_library_routes');
const { registerWorkbenchRoutes } = require('../routes/workbench_routes');
const { createMonthlyRoutes } = require('../routes/monthly_routes');

function createAppRecorder() {
  const routes = [];
  const app = {};
  ['get', 'post', 'patch', 'delete'].forEach((method) => {
    app[method] = (routePath, ...handlers) => {
      routes.push({ method, path: routePath, handlers });
    };
  });
  return { app, routes };
}

function createUploadStub() {
  return {
    array() {
      return function uploadMiddleware(_req, _res, next) {
        next();
      };
    },
    single() {
      return function uploadMiddleware(_req, _res, next) {
        next();
      };
    },
  };
}

function createAuthStub() {
  return {
    authenticateToken(_req, _res, next) {
      next();
    },
    requireRole(...roles) {
      const middleware = (_req, _res, next) => next();
      middleware.requiredRoles = roles;
      return middleware;
    },
  };
}

function createHandlers(names) {
  return Object.fromEntries(names.map((name) => [name, (_req, res) => res.json({ ok: true })]));
}

test('workbench routes apply role middleware to protected operations', () => {
  const { app, routes } = createAppRecorder();
  registerWorkbenchRoutes({
    app,
    upload: createUploadStub(),
    auth: createAuthStub(),
    handlers: createHandlers([
      'getHealth',
      'getState',
      'getMyTodos',
      'openSignatureBrowser',
      'closeSignatureBrowser',
      'getBatch',
      'deleteBatch',
      'importBatch',
          'createManualReceiptFromTask',
  'getTaskOriginalImage',
      'updateTask',
      'approveSourceGroup',
      'deleteSourceGroupCustomer',
      'deleteTask',
      'queueTaskWebsiteSignature',
      'queueBatchWebsiteSignatures',
      'deleteWebsiteSignature',
      'saveManualSignature',
      'deleteManualSignature',
      'exportBatch',
      'exportCustomerData',
            ]),
  });

  const health = routes.find((route) => route.path === '/api/health');
  assert.equal(health.handlers.some((handler) => handler.requiredRoles), false);

  const state = routes.find((route) => route.path === '/api/state');
  assert.deepEqual(state.handlers.find((handler) => handler.requiredRoles).requiredRoles, [
    'admin',
    'reviewer',
    'finance',
  ]);

  const importBatch = routes.find((route) => route.path === '/api/batches/import');
  assert.deepEqual(importBatch.handlers.find((handler) => handler.requiredRoles).requiredRoles, [
    'admin',
    'reviewer',
  ]);

  const approveGroup = routes.find((route) => String(route.path).includes('/approve'));
  assert.deepEqual(approveGroup.handlers.find((handler) => handler.requiredRoles).requiredRoles, [
    'admin',
    'finance',
  ]);

  const exportBatch = routes.find((route) => route.path === '/api/batches/:batchId/export');
  assert.deepEqual(exportBatch.handlers.find((handler) => handler.requiredRoles).requiredRoles, ['admin']);

  // ⭐ 2026-08-01:这个文件叫 route_auth_policy,声称守 workbench 全部 API 的角色策略,
  // 尤其是「破坏性操作要收紧」—— 但**破坏性操作一条都没钉**。
  // 变异验证过:把 `app.delete('/api/batches/:batchId', ...finalReview, ...)`
  // 的 finalReview(admin+finance)换成宽松的一组,测试**照样绿**。
  // 删批次 = 一整批小票连同原图一起没了,而且没有回收站。
  // 下面把三条删除各自的角色钉死:改动必须是**有意的**,不能顺手放宽。
  const destructive = [
    // [path, method, 期望角色, 一句话说明它删掉的是什么]
    ['/api/batches/:batchId', 'delete', ['admin', 'finance'], '整批小票连同原图'],
    ['/api/batches/:batchId/tasks/:taskId', 'delete', ['admin', 'reviewer'], '单条任务'],
    ['/api/batches/:batchId/source-groups/:groupKey/customer', 'delete',
      ['admin', 'reviewer'], '客户组与客户的关联'],
  ];
  for (const [p, method, expected, what] of destructive) {
    const route = routes.find((r) => r.path === p && r.method === method);
    assert.ok(route, `找不到 ${method.toUpperCase()} ${p} —— 路由改名了,这条断言要跟着改`);
    const guard = route.handlers.find((h) => h.requiredRoles);
    assert.ok(guard, `${method.toUpperCase()} ${p} 没有任何角色闸 —— 它删的是${what}`);
    assert.deepEqual(guard.requiredRoles, expected,
      `${method.toUpperCase()} ${p}(删${what})的角色变了:`
      + `期望 ${JSON.stringify(expected)},实际 ${JSON.stringify(guard.requiredRoles)}。`
      + '破坏性操作放宽权限必须是有意的,不能顺手改');
  }

  const exportCustomerData = routes.find((route) => route.path === '/api/batches/:batchId/export-customer-data');
  assert.deepEqual(
    exportCustomerData.handlers.find((handler) => handler.requiredRoles).requiredRoles,
    ['admin', 'reviewer'],
  );
});

test('customer library routes separate intake, image review, and read-only access', () => {
  const { app, routes } = createAppRecorder();
  registerCustomerLibraryRoutes({
    app,
    upload: createUploadStub(),
    auth: createAuthStub(),
    handlers: createHandlers([
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
    ]),
  });

  const state = routes.find((route) => route.path === '/api/customer-library/state');
  assert.deepEqual(state.handlers.find((handler) => handler.requiredRoles).requiredRoles, [
    'admin',
    'reviewer',
    'finance',
  ]);

  const root = routes.find((route) => route.path === '/api/customer-library/root');
  assert.deepEqual(root.handlers.find((handler) => handler.requiredRoles).requiredRoles, ['admin']);

  const createCustomer = routes.find((route) => route.path === '/api/customer-library/customers');
  assert.deepEqual(createCustomer.handlers.find((handler) => handler.requiredRoles).requiredRoles, [
    'admin',
    'reviewer',
  ]);

  const deleteWorkspace = routes.find((route) => route.path === '/api/customer-library/workspaces/:workspaceKey');
  assert.deepEqual(deleteWorkspace.handlers.find((handler) => handler.requiredRoles).requiredRoles, [
    'admin',
  ]);

  const reviewImage = routes.find((route) => String(route.path).endsWith('/review'));
  assert.deepEqual(reviewImage.handlers.find((handler) => handler.requiredRoles).requiredRoles, [
    'admin',
    'reviewer',
  ]);
});

test('monthly routes expose new reviewer/finance roles and keep monthly entry reviewer-owned', () => {
  const { app, routes } = createAppRecorder();
  const routesModule = createMonthlyRoutes({
    workspaceService: {},
    importService: {},
    errorDetectionService: {},
    upload: createUploadStub(),
    groupCodeRepo: {},
    storeBillRepo: {},
    missingReceiptRepo: {},
    errorRecordRepo: {},
    importJobRepo: {},
    dailyReceiptRepo: {},
    tourMatchService: { run() {} },
    monthlyExportService: {},
  });

  routesModule.register(app, createAuthStub());

  const workspaces = routes.find((route) => route.method === 'get' && route.path === '/api/monthly/workspaces');
  assert.deepEqual(workspaces.handlers.find((handler) => handler.requiredRoles).requiredRoles, [
    'admin',
    'reviewer',
    'finance',
  ]);

  const tourMatch = routes.find((route) => route.path === '/api/monthly/workspaces/:workspaceKey/stages/tour-match');
  assert.ok(tourMatch.handlers.find((handler) => handler.requiredRoles).requiredRoles.includes('reviewer'));

  const status = routes.find((route) => route.path === '/api/monthly/workspaces/:workspaceKey/ledger/:id/status');
  assert.deepEqual(status.handlers.find((handler) => handler.requiredRoles).requiredRoles, [
    'admin',
    'reviewer',
  ]);

  const publish = routes.find((route) => route.path === '/api/monthly/workspaces/:workspaceKey/ledger/publish');
  const publishRoles = publish.handlers.find((handler) => handler.requiredRoles).requiredRoles;
  assert.deepEqual(publishRoles, ['admin', 'reviewer']);
  assert.equal(publishRoles.includes('finance'), false);

  const monthlyDataExport = routes.find(
    (route) => route.path === '/api/monthly/workspaces/:workspaceKey/exports/monthly-data'
  );
  assert.deepEqual(monthlyDataExport.handlers.find((handler) => handler.requiredRoles).requiredRoles, [
    'admin',
    'finance',
  ]);

  // SMG总账导入收权(2026-07-21 拍板:管理员账户专人上传)——中间件层锁死,
  // 不止锁 IMPORT_TYPES 配置表:守卫解析三元(guardKey==='admin'?admin:intake)改错这里会红
  const smgImport = routes.find(
    (route) => route.path === '/api/monthly/workspaces/:workspaceKey/imports/smg-ledger'
  );
  assert.deepEqual(smgImport.handlers.find((handler) => handler.requiredRoles).requiredRoles, [
    'admin',
  ]);
  const storeBillImport = routes.find(
    (route) => route.path === '/api/monthly/workspaces/:workspaceKey/imports/store-bill'
  );
  assert.deepEqual(storeBillImport.handlers.find((handler) => handler.requiredRoles).requiredRoles, [
    'admin',
    'reviewer',
  ], '其余导入类型保持 intake 不受收权影响');
});
