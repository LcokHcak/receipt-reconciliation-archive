'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { createApiErrorMiddleware } = require('../lib/api_error_middleware');
const { AppError, ForbiddenError } = require('../lib/errors');

// 审计H2:后置路由的错误漏过前置错误处理器→尾部处理器兜住,返回 JSON(非 Express finalhandler)。
async function bootWithTailHandler(t, mountThrower) {
  const app = express();
  app.use(express.json());
  // 模拟 create_app 的前置错误处理器"过早注册":这里先挂一个只处理 /early 的错误处理器
  app.get('/early/boom', (req, res, next) => next(new Error('early boom')));
  app.use((error, req, res, next) => {
    if (error && String(req.path).startsWith('/early')) return res.status(599).json({ from: 'early-handler' });
    return next(error);
  });
  // 后置路由(排在前置错误处理器之后)——正是 library/config/overview 的处境
  mountThrower(app);
  const calls = [];
  app.use(createApiErrorMiddleware({
    logger: { error: (msg, meta) => calls.push({ msg, meta }) },
    opsMetrics: { inc: (metric) => calls.push({ metric }) },
  }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());
  const call = async (path) => {
    const r = await fetch(`${base}${path}`);
    let body; try { body = await r.json(); } catch { body = null; }
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, body, ct };
  };
  return { call, calls };
}

test('后置路由 next(error) 普通错 → 尾部处理器 JSON 500 + api_500 计数 + logger', async (t) => {
  const { call, calls } = await bootWithTailHandler(t, (app) => {
    app.get('/api/library/boom', (req, res, next) => next(new Error('kaboom')));
  });
  const r = await call('/api/library/boom');
  assert.equal(r.status, 500);
  assert.ok(r.ct.includes('application/json'), '必须是 JSON 而非 finalhandler 的 text/html');
  assert.equal(r.body.code, 'internal_error');
  assert.ok(!/kaboom/.test(JSON.stringify(r.body)), '不得泄漏原始错误消息/堆栈');
  assert.ok(calls.some((c) => c.msg === 'api_handler_error'), 'logger 应打点');
  assert.ok(calls.some((c) => c.metric === 'api_500'), 'api_500 应计数');
});

test('后置路由 AppError → 尾部处理器映射其状态码(如 403)', async (t) => {
  const { call } = await bootWithTailHandler(t, (app) => {
    app.get('/api/library/forbidden', (req, res, next) => next(new ForbiddenError('这不是你的批次')));
  });
  const r = await call('/api/library/forbidden');
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'forbidden');
  assert.equal(r.body.error, '这不是你的批次');
});

test('Express5 async 拒绝(无显式 next)也被尾部处理器兜住', async (t) => {
  const { call } = await bootWithTailHandler(t, (app) => {
    app.get('/api/library/async-throw', async () => { throw new AppError('炸了', { status: 409, code: 'conflict' }); });
  });
  const r = await call('/api/library/async-throw');
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'conflict');
});

test('前置处理器已接住的路由不受影响(尾部处理器不越权接管)', async (t) => {
  const { call } = await bootWithTailHandler(t, () => {});
  const r = await call('/early/boom');
  assert.equal(r.status, 599); // 仍走前置处理器
  assert.equal(r.body.from, 'early-handler');
});

test('非 /api 路径的错误不被尾部处理器 JSON 化(交回默认链)', async (t) => {
  const { call } = await bootWithTailHandler(t, (app) => {
    app.get('/static/boom', (req, res, next) => next(new Error('x')));
  });
  const r = await call('/static/boom');
  assert.equal(r.status, 500); // Express 默认 finalhandler
  assert.ok(!r.ct.includes('application/json'), '非 /api 不 JSON 化');
});
