'use strict';

// #4 系统喊疼:计数器/小时摘要/前端上报端点 契约。
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { createOpsMetrics, opsMetrics } = require('../lib/ops_metrics');
const { createClientErrorRoutes } = require('../routes/client_error_routes');

test('ops_metrics:计数+样本+flush 只在有疼时打 ops_digest,窗口清零', () => {
  const logs = [];
  const metrics = createOpsMetrics({ logger: { warn: (msg, obj) => logs.push({ msg, obj }) } });
  metrics.flush();
  assert.equal(logs.length, 0); // 零异常不刷屏

  metrics.inc('api_500', { route: '/api/x', message: 'boom' });
  metrics.inc('api_500');
  metrics.inc('client_error', { user: 'op1', message: 'undefined is not a function' });
  const snap = metrics.snapshot();
  assert.equal(snap.counts.api_500, 2);
  assert.equal(snap.samples.client_error.user, 'op1');

  metrics.flush();
  assert.equal(logs.length, 1);
  assert.equal(logs[0].msg, 'ops_digest');
  assert.equal(logs[0].obj.counts.api_500, 2);
  assert.deepEqual(createOpsMetrics().snapshot().counts, {}); // 新窗口干净
  assert.deepEqual(metrics.snapshot().counts, {});
});

async function makeApp(t, user) {
  const logs = [];
  const app = express();
  app.use(express.json());
  createClientErrorRoutes({
    auth: { authenticateToken: (req, res, next) => { req.user = user; next(); } },
    logger: { warn: (msg, obj) => logs.push({ msg, obj }) },
  }).register(app);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, logs };
}

test('client-errors:落 client_error 日志+截断;永远 204;超窗静默吞;ops-digest 仅 admin', async (t) => {
  const { base, logs } = await makeApp(t, { username: 'op1', role: 'reviewer' });

  const first = await fetch(`${base}/api/client-errors`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'x'.repeat(600), stack: 's'.repeat(3000), url: '/review' }),
  });
  assert.equal(first.status, 204);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].msg, 'client_error');
  assert.equal(logs[0].obj.message.length, 500); // 截断
  assert.equal(logs[0].obj.stack.length, 2000);

  // 窗口限额:再打 35 条,只前 29 条(共 30)落日志,其余 204 静默
  for (let i = 0; i < 35; i += 1) {
    const res = await fetch(`${base}/api/client-errors`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: `e${i}` }),
    });
    assert.equal(res.status, 204);
  }
  assert.equal(logs.length, 30);

  // ops-digest:非 admin 403
  assert.equal((await fetch(`${base}/api/admin/ops-digest`)).status, 403);
  const adminApp = await makeApp(t, { username: 'boss', role: 'admin' });
  const digest = await fetch(`${adminApp.base}/api/admin/ops-digest`);
  assert.equal(digest.status, 200);
  const body = await digest.json();
  assert.ok(body.counts.client_error >= 30); // 共享 opsMetrics 单例吃到了上面的计数
  opsMetrics.flush(); // 清窗口,别污染别的测试
});
