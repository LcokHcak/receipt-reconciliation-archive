'use strict';

/**
 * OpenAPI 里写的 x-roles 必须等于**真实路由**放行的角色(2026-08-01)。
 *
 * 病灶:tests/openapi_contract 里那几条 x-roles 断言,是拿 **openapi.json 和它自己**比 ——
 * 写死一个期望值,再去 openapi.json 里读同一个值。真实路由挂的是什么角色,
 * 从来不在断言范围内。变异验证过:把 `app.post('/api/batches/:batchId/export', ...adminOnly, ...)`
 * 放宽成 `...read`(三个角色全放行),那个测试**照样绿**。
 *
 * 而且这次一对拍就抓到一处**真分歧**(不是假想):
 *   openapi.json 写 /api/batches/{batchId}/export 是 ["admin","finance"]
 *   而 routes/workbench_routes.js:73 挂的是 adminOnly = **只有 admin**
 * 也就是说对外发布的契约多写了一个角色。财务照着文档以为自己能导出,实际会被 403;
 * 反过来,如果哪天有人照文档把代码"修正"成 admin+finance,就是**悄悄放宽了权限**。
 *
 * 这条闸的做法:用同一套 recorder 把真实路由录下来,逐条比 requiredRoles 与 x-roles。
 * 与 tests/route_auth_policy 的区别:那条守"代码里的角色别被改",
 * 这条守"**文档和代码别各说各话**"。
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { registerWorkbenchRoutes } = require('../routes/workbench_routes');

const ROOT = path.join(__dirname, '..');
const openApi = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'openapi.json'), 'utf8'));

function createAppRecorder() {
  const routes = [];
  const app = {};
  ['get', 'post', 'patch', 'put', 'delete'].forEach((method) => {
    app[method] = (routePath, ...handlers) => routes.push({ method, path: routePath, handlers });
  });
  return { app, routes };
}

// 与 tests/route_auth_policy 用的是同一套 stub 形状:
// 路由文件内部的 protect(...) 是由 auth.requireRole 组出来的,不是 auth 直接给的。
// (我第一版按 `protect` 写,录到 0 条带角色的路由 —— 靠下面那条自检当场发现。)
function createAuthStub() {
  return {
    authenticateToken(_req, _res, next) { next(); },
    requireRole(...roles) {
      const middleware = (_req, _res, next) => next();
      middleware.requiredRoles = roles;
      return middleware;
    },
  };
}

function recordWorkbenchRoutes() {
  const { app, routes } = createAppRecorder();
  const handlerNames = new Set();
  const handlers = new Proxy({}, {
    get(_t, name) {
      handlerNames.add(String(name));
      return function stub() {};
    },
    has() { return true; },
  });
  registerWorkbenchRoutes({
    app,
    upload: {
      array: () => (_req, _res, next) => next(),
      single: () => (_req, _res, next) => next(),
    },
    auth: createAuthStub(),
    handlers,
  });
  return routes;
}

// express 的 :param 与 openapi 的 {param}
const toOpenApiPath = (p) => String(p).replace(/:([A-Za-z0-9_]+)/g, '{$1}');

test('⭐openapi 的 x-roles 必须等于真实路由的 requiredRoles(不是拿文档核文档)', () => {
  const routes = recordWorkbenchRoutes();
  assert.ok(routes.length > 20, `只录到 ${routes.length} 条路由,录制方式失效了`);

  const mismatches = [];
  let compared = 0;
  for (const r of routes) {
    const guard = r.handlers.find((h) => h && h.requiredRoles);
    if (!guard) continue; // 无角色闸的(如 /api/health)不在本条射程
    const doc = openApi.paths?.[toOpenApiPath(r.path)]?.[r.method];
    if (!doc) continue; // "有路由没文档"由下一条守
    const declared = doc['x-roles'];
    if (!Array.isArray(declared)) {
      mismatches.push(`${r.method.toUpperCase()} ${r.path}:文档里没有 x-roles`);
      continue;
    }
    compared += 1;
    const a = [...guard.requiredRoles].sort().join(',');
    const b = [...declared].sort().join(',');
    if (a !== b) {
      mismatches.push(
        `${r.method.toUpperCase()} ${r.path}:代码放行 [${a}],文档写 [${b}]`,
      );
    }
  }

  assert.ok(compared > 10, `只比对了 ${compared} 条,取数方式可能失效`);
  assert.deepEqual(mismatches, [],
    '文档与代码的角色对不上。多写角色 → 用户照文档以为自己有权限,实际被 403;'
    + '少写 → 有人照文档"修正"代码时会悄悄放宽权限:\n  ' + mismatches.join('\n  '));
});

test('⭐没有"未登记"的接口(注册了路由却不在 openapi 里)', () => {
  const routes = recordWorkbenchRoutes();
  const undocumented = [];
  for (const r of routes) {
    const p = toOpenApiPath(r.path);
    if (!openApi.paths?.[p]?.[r.method]) undocumented.push(`${r.method.toUpperCase()} ${r.path}`);
  }
  assert.deepEqual(undocumented, [],
    '这些接口注册了但没进 openapi.json —— 对外契约缺一块,'
    + '而且新加的危险接口会这样悄悄溜进来:\n  ' + undocumented.join('\n  '));
});

test('自检:录制与路径转换真的有效(否则上面两条是空跑)', () => {
  const routes = recordWorkbenchRoutes();
  assert.ok(routes.some((r) => r.path === '/api/health'), '应录到 /api/health');
  assert.ok(routes.some((r) => r.handlers.some((h) => h && h.requiredRoles)),
    '应录到带角色闸的路由 —— 一条都没有说明 auth stub 没生效');
  assert.equal(toOpenApiPath('/api/batches/:batchId/tasks/:taskId'),
    '/api/batches/{batchId}/tasks/{taskId}', '路径转换要对');
  // 反向:一个不存在的路径不该在文档里查到
  assert.equal(openApi.paths?.['/api/definitely-not-a-route'], undefined);
});
