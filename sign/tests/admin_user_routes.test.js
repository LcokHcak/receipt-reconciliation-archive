'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const cookieParser = require('cookie-parser');
const express = require('express');

const { generateToken } = require('../lib/auth/jwt_middleware');
const { createAdminUserRoutes } = require('../routes/admin_user_routes');
const { UserService } = require('../services/user_service');

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-user-routes-'));
  const userService = new UserService({ dbPath: path.join(dir, 'users.sqlite') });
  const jwtSecret = 'admin-route-test-secret';

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  createAdminUserRoutes({
    userService,
    auth: { jwtSecret, userService },
  }).register(app);

  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });

  t.after(() => {
    server.close();
    userService.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    jwtSecret,
    userService,
  };
}

function tokenCookie(user, jwtSecret) {
  const token = generateToken(user, { secret: jwtSecret });
  return `token=${token}`;
}

test('admin user routes protect admin APIs and block self-disable', async (t) => {
  const { baseUrl, jwtSecret, userService } = await setup(t);
  const admin = await userService.createUser('admin', 'secret123', 'admin');

  const anonymousRes = await fetch(`${baseUrl}/api/admin/users`);
  assert.equal(anonymousRes.status, 401);

  // ⭐ 2026-08-01:上面只验了「匿名 → 401」,那是 tokenMiddleware 的活。
  // roleGuard('admin') 守的是**另一件事**:登录了但不是 admin 的人能不能进。
  // 而这件事从来没有断言。变异验证过:把 `roleGuard('admin')` 从 protect 里删掉、
  // 只留登录校验,这个测试**照样绿** —— 而任何审核员/财务都能列全部账号、
  // 改别人角色、重置别人密码、停用同事。路由文件头注释写着「仅 admin 角色可访问」。
  const reviewer = await userService.createUser('r_probe', 'secret123', 'reviewer');
  const reviewerCookie = tokenCookie(reviewer, jwtSecret);
  for (const [method, path_, body] of [
    ['GET', '/api/admin/users', null],
    ['POST', '/api/admin/users', { username: 'x', password: 'secret123', role: 'reviewer' }],
    // 路径按 routes/admin_user_routes.js 的真实注册来写:
    // 改角色是 PATCH /:id(不是 /:id/role),重置密码是 /:id/reset-password。
    // 我第一版按"想当然"写成 /role 和 /password,拿到 404 —— 而 404 不是 403,
    // 断言当场红。这本身说明这组断言真的在打到路由,不是空跑。
    ['PATCH', `/api/admin/users/${admin.id}`, { role: 'reviewer' }],
    ['POST', `/api/admin/users/${admin.id}/reset-password`, { password: 'newsecret123' }],
    ['DELETE', `/api/admin/users/${admin.id}`, null],
  ]) {
    const res = await fetch(`${baseUrl}${path_}`, {
      method,
      headers: { cookie: reviewerCookie, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(res.status, 403,
      `${method} ${path_}:非 admin 的登录用户返回了 ${res.status},应该是 403。`
      + 'roleGuard(\'admin\') 守的就是这一条 —— 少了它,审核员能改所有人的角色和密码');
  }
  // 反向对照:同样这些请求,admin 不该是 403(否则上面只证明了"路径不通")
  const adminList = await fetch(`${baseUrl}/api/admin/users`, {
    headers: { cookie: tokenCookie(admin, jwtSecret) },
  });
  assert.notEqual(adminList.status, 403, 'admin 自己必须进得去,否则上面那组证明不了角色闸');

  const selfDeleteRes = await fetch(`${baseUrl}/api/admin/users/${admin.id}`, {
    method: 'DELETE',
    headers: { cookie: tokenCookie(admin, jwtSecret) },
  });
  assert.equal(selfDeleteRes.status, 400);

  const stillActive = await userService.getUserById(admin.id);
  assert.equal(stillActive.is_active, 1);
});

test('disabled user tokens are rejected after user status changes', async (t) => {
  const { baseUrl, jwtSecret, userService } = await setup(t);
  const admin = await userService.createUser('admin', 'secret123', 'admin');
  const reviewer = await userService.createUser('reviewer', 'secret123', 'reviewer');
  const reviewerCookie = tokenCookie(reviewer, jwtSecret);

  const deleteRes = await fetch(`${baseUrl}/api/admin/users/${reviewer.id}`, {
    method: 'DELETE',
    headers: { cookie: tokenCookie(admin, jwtSecret) },
  });
  assert.equal(deleteRes.status, 200);

  const staleTokenRes = await fetch(`${baseUrl}/api/admin/users`, {
    headers: { cookie: reviewerCookie },
  });
  assert.equal(staleTokenRes.status, 401);
});
