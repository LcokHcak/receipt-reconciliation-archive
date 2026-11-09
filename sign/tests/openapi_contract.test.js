const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

function toOpenApiPath(expressPath) {
  return expressPath.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function extractExpressRoutes(relativePath) {
  const source = read(relativePath);
  const routes = [];
  const routePattern = /app\.(get|post|patch|delete)\(\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = routePattern.exec(source))) {
    routes.push({
      method: match[1],
      expressPath: match[2],
      openApiPath: toOpenApiPath(match[2]),
    });
  }
  return routes;
}

test('OpenAPI document covers the registered Express API routes', () => {
  const openApi = JSON.parse(read('docs/openapi.json'));
  const routes = [
    ...extractExpressRoutes('routes/auth_routes.js'),
    ...extractExpressRoutes('routes/workbench_routes.js'),
    ...extractExpressRoutes('routes/customer_library_routes.js'),
  ];

  assert.equal(openApi.openapi, '3.0.3');
  assert.equal(openApi.info.title, 'Sign Workbench API');
  assert.ok(openApi.components.securitySchemes.cookieAuth);

  for (const route of routes) {
    assert.ok(
      openApi.paths[route.openApiPath],
      `Missing OpenAPI path for ${route.method.toUpperCase()} ${route.expressPath}`
    );
    assert.ok(
      openApi.paths[route.openApiPath][route.method],
      `Missing OpenAPI method for ${route.method.toUpperCase()} ${route.expressPath}`
    );
  }
});

test('OpenAPI document records route authorization roles for key workflows', () => {
  const openApi = JSON.parse(read('docs/openapi.json'));

  assert.deepEqual(openApi.paths['/api/health'].get.security, []);
  assert.deepEqual(openApi.paths['/api/state'].get['x-roles'], [
    'admin',
    'reviewer',
    'finance',
  ]);
  assert.deepEqual(openApi.paths['/api/batches/import'].post['x-roles'], ['admin', 'reviewer']);
  assert.deepEqual(openApi.paths['/api/customer-library/workspaces/{workspaceKey}/customers/{customerId}/images/{imageId}/review'].post['x-roles'], [
    'admin',
    'reviewer',
  ]);
  // 2026-08-01 更正:这里原来钉的是 ['admin','finance'],而真实路由挂的是
  // adminOnly = **只有 admin**(routes/workbench_routes.js:73)。
  // 这条断言一直绿,因为它拿 **openapi.json 和一个写死的期望值**比 ——
  // 真实路由放行什么,从来不在射程里。于是对外发布的契约多写了一个角色:
  // 财务照文档以为自己能导出、实际被 403;更糟的是反方向 ——
  // 有人照文档把代码"修正"成 admin+finance,那就是**悄悄放宽了权限**。
  // 真对拍见 tests/openapi_roles_match_real_routes.test.js(那条会拿真实路由核)。
  assert.deepEqual(openApi.paths['/api/batches/{batchId}/export'].post['x-roles'], ['admin']);
});
