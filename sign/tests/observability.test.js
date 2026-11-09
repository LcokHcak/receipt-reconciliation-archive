'use strict';

/**
 * Tests for the structured request logger + health endpoints (M1).
 *
 * - request_id is generated when the client doesn't send one
 * - existing X-Request-Id header is reused
 * - X-Request-Id is reflected back on the response
 * - logger is JSON-line; each line has reqId + status + ms + route
 * - 5xx routes are logged at level=error, 4xx at warn, 2xx at info
 * - /healthz always 200, /readyz reflects probe results (200 vs 503)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const {
  createRequestLogger,
  logger,
  newRequestId,
  withRequestContext,
  currentContext,
} = require('../lib/request_logger');
const { createHealthRoutes } = require('../lib/health_routes');

function captureStdio(fn) {
  const out = [];
  const err = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { err.push(String(chunk)); return true; };
  try {
    return Promise.resolve(fn()).finally(() => {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    });
  } catch (error) {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    throw error;
  }
}

async function startApp(setup) {
  const app = express();
  app.use(createRequestLogger());
  setup(app);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { app, server, baseUrl };
}

test('newRequestId returns 16-hex chars', () => {
  const id = newRequestId();
  assert.match(id, /^[0-9a-f]{16}$/);
});

test('withRequestContext / currentContext propagate reqId', () => {
  withRequestContext({ reqId: 'abc123' }, () => {
    assert.equal(currentContext().reqId, 'abc123');
  });
});

test('logger writes JSON lines with level + msg + ts', async () => {
  await captureStdio(() => {
    logger.info('hello', { foo: 1 });
  }).then(() => {});
  // Capture again to actually inspect the output:
  let captured = '';
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { captured += String(chunk); return true; };
  try {
    logger.info('hello', { foo: 1 });
  } finally {
    process.stdout.write = orig;
  }
  const line = JSON.parse(captured.trim());
  assert.equal(line.lvl, 'info');
  assert.equal(line.msg, 'hello');
  assert.equal(line.foo, 1);
  assert.ok(line.ts);
});

test('createRequestLogger reflects X-Request-Id and logs status/ms', async (t) => {
  const { server, baseUrl } = await startApp((app) => {
    app.get('/ok', (req, res) => res.json({ id: req.id }));
    app.get('/boom', (_req, _res, next) => next(new Error('boom')));
    app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  });
  t.after(() => server.close());

  // generated reqId
  const r1 = await fetch(`${baseUrl}/ok`);
  const id1 = r1.headers.get('x-request-id');
  assert.match(id1, /^[0-9a-f]{16}$/);
  const body1 = await r1.json();
  assert.equal(body1.id, id1);

  // client-supplied reqId is reused
  const r2 = await fetch(`${baseUrl}/ok`, { headers: { 'x-request-id': 'caller-trace-1' } });
  assert.equal(r2.headers.get('x-request-id'), 'caller-trace-1');

  // 500 path also reflects reqId
  const r3 = await fetch(`${baseUrl}/boom`);
  assert.equal(r3.status, 500);
  assert.match(r3.headers.get('x-request-id'), /^[0-9a-f]{16}$/);
});

test('createHealthRoutes: /healthz always 200; /readyz 503 on probe failure', async (t) => {
  let dbOk = true;
  const probes = {
    db: () => {
      if (!dbOk) throw new Error('db unreachable');
      return { ok: true };
    },
  };
  const app = express();
  createHealthRoutes({ probes, meta: { service: 'test' } }).register(app);
  const server = await new Promise((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const h = await fetch(`${baseUrl}/healthz`);
  assert.equal(h.status, 200);
  const hb = await h.json();
  assert.equal(hb.status, 'ok');
  assert.equal(hb.service, 'test');

  const r = await fetch(`${baseUrl}/readyz`);
  assert.equal(r.status, 200);
  const rb = await r.json();
  assert.equal(rb.checks.db.ok, true);

  dbOk = false;
  const r2 = await fetch(`${baseUrl}/readyz`);
  assert.equal(r2.status, 503);
  const rb2 = await r2.json();
  assert.equal(rb2.status, 'not_ready');
  assert.equal(rb2.checks.db.ok, false);
  assert.match(rb2.checks.db.error, /db unreachable/);
});

test('createHealthRoutes: /readyz includes batch write queue depth probe', async (t) => {
  const app = express();
  createHealthRoutes({
    getBatchWriteQueueMetrics: () => ({
      totalQueues: 1,
      maxDepth: 51,
      perBatch: [{
        batchId: 'batch_deep',
        depth: 51,
        oldestLabel: 'updateTask',
        oldestAgeMs: 6000,
      }],
    }),
    batchWriteQueueMaxDepth: 50,
    meta: { service: 'test' },
  }).register(app);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const response = await fetch(`${baseUrl}/readyz`);
  assert.equal(response.status, 503);
  const body = await response.json();

  assert.equal(body.status, 'not_ready');
  assert.equal(body.checks.batch_write_queue.ok, false);
  assert.equal(body.checks.batch_write_queue.maxDepth, 51);
  assert.equal(body.checks.batch_write_queue.threshold, 50);
  assert.equal(body.checks.batch_write_queue.perBatch[0].oldestLabel, 'updateTask');
});
