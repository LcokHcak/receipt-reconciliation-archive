const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { registerAuthRoutes } = require('../routes/auth_routes');
const { UserService } = require('../services/user_service');

async function createAuthServer(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-auth-routes-'));
  const userService = new UserService({ dbPath: path.join(dir, 'auth.sqlite') });
  await userService.createUser('admin', 'secret123', 'admin');

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  registerAuthRoutes({
    app,
    jwtSecret: 'test-secret',
    userService,
  });

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
  };
}

test('auth routes login, read current user, refresh, and logout via httpOnly cookie', async (t) => {
  const { baseUrl } = await createAuthServer(t);

  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'secret123' }),
  });

  assert.equal(loginResponse.status, 200);
  const cookie = loginResponse.headers.get('set-cookie');
  assert.match(cookie, /token=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);

  const meResponse = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { cookie },
  });
  assert.equal(meResponse.status, 200);
  assert.equal((await meResponse.json()).user.username, 'admin');

  const refreshResponse = await fetch(`${baseUrl}/api/auth/refresh`, {
    method: 'POST',
    headers: { cookie },
  });
  assert.equal(refreshResponse.status, 200);
  assert.match(refreshResponse.headers.get('set-cookie'), /token=/);

  const logoutResponse = await fetch(`${baseUrl}/api/auth/logout`, {
    method: 'POST',
  });
  assert.equal(logoutResponse.status, 200);
  assert.match(logoutResponse.headers.get('set-cookie'), /Max-Age=0/);
});

test('auth routes reject invalid credentials', async (t) => {
  const { baseUrl } = await createAuthServer(t);

  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'wrong' }),
  });

  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, 'Invalid credentials');
});
