'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const { acquireSingleInstanceLock } = require('../lib/single_instance_guard');

test('acquireSingleInstanceLock rejects a live existing lock', async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'single-lock-live-'));
  const lockPath = path.join(tmp, 'sign-workbench.lock');
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: 4242,
    token: 'existing-token',
    acquiredAt: '2026-05-12T00:00:00.000Z',
  }));

  assert.throws(
    () => acquireSingleInstanceLock({
      lockPath,
      isPidAlive: (pid) => pid === 4242,
    }),
    /already running.*4242/
  );
});

test('acquireSingleInstanceLock replaces stale locks and releases its own lock', async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'single-lock-stale-'));
  const lockPath = path.join(tmp, 'sign-workbench.lock');
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: 999999,
    token: 'stale-token',
    acquiredAt: '2026-05-11T00:00:00.000Z',
  }));

  const guard = acquireSingleInstanceLock({
    lockPath,
    isPidAlive: () => false,
    now: () => new Date(2026, 4, 12, 4, 5, 6),
  });

  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  assert.equal(lock.pid, process.pid);
  assert.equal(lock.acquiredAt, new Date(2026, 4, 12, 4, 5, 6).toISOString());
  assert.equal(typeof lock.token, 'string');

  guard.release();
  assert.equal(fs.existsSync(lockPath), false);
});

test('single instance release does not remove a lock acquired by another process', async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'single-lock-token-'));
  const lockPath = path.join(tmp, 'sign-workbench.lock');
  const guard = acquireSingleInstanceLock({
    lockPath,
    isPidAlive: () => false,
  });

  fs.writeFileSync(lockPath, JSON.stringify({
    pid: 111,
    token: 'someone-else',
    acquiredAt: '2026-05-12T00:00:00.000Z',
  }));

  guard.release();

  assert.equal(fs.existsSync(lockPath), true);
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  assert.equal(lock.token, 'someone-else');
});
