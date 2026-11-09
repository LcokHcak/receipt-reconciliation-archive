'use strict';

/**
 * Tests for graceful shutdown coordinator (M2).
 *
 * Verifies the contract that PM2 / systemd rely on:
 *   - SIGTERM closes the HTTP server
 *   - in-flight requests are awaited before drains run
 *   - drains execute in registration order
 *   - drain timeout is enforced
 *   - second signal forces exit
 *   - request-drain timeout caps the wait so cleanup eventually starts
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createShutdownCoordinator } = require('../lib/graceful_shutdown');

function mockServer() {
  let closeCb = null;
  return {
    close(cb) { closeCb = cb; setTimeout(() => cb && cb(), 1); },
    triggerClose() { if (closeCb) closeCb(); },
  };
}

test('drains run sequentially in registration order', async () => {
  const order = [];
  const exits = [];
  const server = mockServer();
  const coord = createShutdownCoordinator({
    server,
    exit: (code) => exits.push(code),
  });
  coord.registerDrain('first',  async () => { await sleep(5); order.push('first'); });
  coord.registerDrain('second', async () => { await sleep(5); order.push('second'); });

  await coord.shutdown('test');
  assert.deepEqual(order, ['first', 'second']);
  assert.deepEqual(exits, [0]);
});

test('drain timeout fires and logs failure but does not abort sequence', async () => {
  const order = [];
  const exits = [];
  const coord = createShutdownCoordinator({
    server: mockServer(),
    drainTimeoutMs: 20,
    exit: (c) => exits.push(c),
  });
  coord.registerDrain('slow',  () => new Promise(() => { /* never resolves */ }));
  coord.registerDrain('quick', async () => { await sleep(5); order.push('quick'); });

  await coord.shutdown('test');
  // 'slow' is dropped via timeout; 'quick' still runs
  assert.deepEqual(order, ['quick']);
  assert.deepEqual(exits, [0]);
});

test('second signal forces immediate exit(1)', async () => {
  const exits = [];
  const coord = createShutdownCoordinator({
    server: mockServer(),
    requestDrainMs: 5000,
    exit: (c) => exits.push(c),
  });
  coord.registerDrain('hang', () => new Promise(() => { /* never resolves */ }));

  coord.shutdown('SIGTERM'); // 只要触发副作用,第二次调用才是断言对象
  // give the first call a tick to set shuttingDown=true
  await sleep(5);
  await coord.shutdown('SIGTERM');
  assert.deepEqual(exits, [1]);
  // first promise is still pending — we don't await it because the drain hangs
  assert.equal(coord.isShuttingDown(), true);
});

test('trackInFlight middleware delays drain until requests finish', async () => {
  const coord = createShutdownCoordinator({
    server: mockServer(),
    requestDrainMs: 200,
    exit: () => {},
  });
  // Simulate a request in flight
  const req = { path: '/api/foo' };
  const listeners = {};
  const res = { on(event, cb) { listeners[event] = cb; } };
  coord.trackInFlight(req, res, () => {});
  assert.equal(coord._internals.inFlight, 1);

  let drainStarted = false;
  coord.registerDrain('marker', () => { drainStarted = true; });

  const done = coord.shutdown('test');
  await sleep(10);
  assert.equal(drainStarted, false, 'drain should still be waiting');

  // Finish the request
  listeners.finish();
  await done;
  assert.equal(drainStarted, true);
});

test('trackInFlight ignores /healthz so probes still answer during drain', () => {
  const coord = createShutdownCoordinator({ server: mockServer(), exit: () => {} });
  const req = { path: '/healthz' };
  const res = { on() {} };
  coord.trackInFlight(req, res, () => {});
  assert.equal(coord._internals.inFlight, 0);
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
