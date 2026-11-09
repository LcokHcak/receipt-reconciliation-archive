'use strict';

// V2 Task8:代理工作台路由端到端(真 JWT + 真 express)。
// 断言:未登录 401;finance complete 在路由层就 403;reviewer scope 收窄贯穿 HTTP;
// 非法月 400 带 code;错误响应不暴露服务器路径。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cookieParser = require('cookie-parser');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');

const { authenticateToken, requireRole, generateToken } = require('../lib/auth/jwt_middleware');
const { createAgentWorkspaceRepository } = require('../repositories/agent_workspace_repository');
const { createWorkflowTaskRepository } = require('../repositories/workflow_task_repository');
const { createAgentWorkspaceService } = require('../services/agent_workspace_service');
const { registerAgentWorkspaceRoutes } = require('../routes/agent_workspace_routes');

const SECRET = 'agent-ws-routes-test-secret';
const ADMIN = { id: 1, userId: 1, username: 'admin', role: 'admin' };
const FINANCE = { id: 2, userId: 2, username: 'fin', role: 'finance' };
const REVIEWER = { id: 15, userId: 15, username: '小票22', role: 'reviewer' };

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ws-routes-'));
  const db = new DatabaseSync(path.join(dir, 'wb.sqlite'));
  const agentRepo = createAgentWorkspaceRepository({ db });
  const taskRepo = createWorkflowTaskRepository({ db });

  agentRepo.upsertCustomerAnchor({
    customerPk: 'ws1::CL-A1', calendarMonth: '2026-07', workspaceKey: 'ws1', customerId: 'CL-A1',
    ownerUserId: 15, ownerUsername: '小票22', agentKey: '永乐', agentName: '永乐', agentUnlabeled: false,
    customerName: 'CL-A1', activeBatchId: '', activeGroupKey: '', receivedAt: '2026-07-05T03:00:00.000Z',
    originalImageCount: 1, abnormalImageCount: 0,
  });
  agentRepo.upsertCustomerAnchor({
    customerPk: 'ws1::CL-B1', calendarMonth: '2026-07', workspaceKey: 'ws1', customerId: 'CL-B1',
    ownerUserId: 16, ownerUsername: '小票13', agentKey: '贝拉', agentName: '贝拉', agentUnlabeled: false,
    customerName: 'CL-B1', activeBatchId: '', activeGroupKey: '', receivedAt: '2026-07-05T04:00:00.000Z',
    originalImageCount: 1, abnormalImageCount: 0,
  });
  const task = taskRepo.createExpected({
    taskKey: 'k-a', calendarMonth: '2026-07', workspaceKey: 'ws1', customerId: 'CL-A1',
    taskType: 'send_upstream', subtype: 'send_17', createdAt: '2026-07-12T03:00:00.000Z',
  }).task;

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  registerAgentWorkspaceRoutes({
    app,
    auth: { authenticateToken: authenticateToken({ secret: SECRET }), requireRole },
    agentWorkspaceService: createAgentWorkspaceService({
      agentWorkspaceRepository: agentRepo,
      workflowTaskRepository: taskRepo,
      db,
    }),
  });
  // 与生产同形状的 AppError 出口(status/code,不带堆栈路径)
  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    res.status(error.status || 500).json({ error: error.message, code: error.code || 'internal_error' });
  });

  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => server.close());
  t.after(() => { try { db.close(); } catch { /* closed */ } });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const call = async (userOrNull, method, url, body) => {
    const headers = { 'content-type': 'application/json' };
    if (userOrNull) headers.cookie = `token=${generateToken(userOrNull, { secret: SECRET })}`;
    const res = await fetch(`${baseUrl}${url}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  return { call, task };
}

test('未登录 401;三角色读接口全通;finance complete 路由层 403', async (t) => {
  const { call, task } = await setup(t);

  assert.equal((await call(null, 'GET', '/api/agent-workspace/v1/summary?month=2026-07')).status, 401);

  for (const user of [ADMIN, FINANCE, REVIEWER]) {
    const r = await call(user, 'GET', '/api/agent-workspace/v1/summary?month=2026-07');
    assert.equal(r.status, 200);
    assert.ok(r.body.visibleAll);
  }

  const denied = await call(FINANCE, 'POST', `/api/agent-workspace/v1/tasks/${task.id}/complete`, {});
  assert.equal(denied.status, 403);

  const okDone = await call(ADMIN, 'POST', `/api/agent-workspace/v1/tasks/${task.id}/complete`, { note: 'x' });
  assert.equal(okDone.status, 200);
  assert.equal(okDone.body.task.status, 'done');
});

test('reviewer scope 贯穿 HTTP:summary/customers 只见自己;admin 全量', async (t) => {
  const { call } = await setup(t);
  const admin = await call(ADMIN, 'GET', '/api/agent-workspace/v1/customers?month=2026-07');
  assert.equal(admin.body.customers.length, 2);

  const rev = await call(REVIEWER, 'GET', '/api/agent-workspace/v1/customers?month=2026-07&ownerUserId=16');
  assert.equal(rev.body.customers.length, 1); // 冒充 16 也只看自己的 15
  assert.equal(rev.body.customers[0].customerId, 'CL-A1');
});

test('非法月 400 invalid_month;months 端点给前端默认月;错误体不带服务器路径', async (t) => {
  const { call } = await setup(t);
  const bad = await call(ADMIN, 'GET', '/api/agent-workspace/v1/summary?month=260701');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'invalid_month');
  assert.ok(!JSON.stringify(bad.body).includes('D:\\'));

  const months = await call(REVIEWER, 'GET', '/api/agent-workspace/v1/months');
  assert.equal(months.status, 200);
  assert.equal(months.body.months[0].month, '2026-07');
});
