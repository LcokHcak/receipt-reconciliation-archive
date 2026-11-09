'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function defaultIsPidAlive(pid) {
  const normalized = Number(pid);
  if (!Number.isInteger(normalized) || normalized <= 0) return false;
  try {
    process.kill(normalized, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function readLock(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

function writeLockExclusive(lockPath, payload) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const fd = fs.openSync(lockPath, 'wx');
  try {
    fs.writeFileSync(fd, JSON.stringify(payload, null, 2));
  } finally {
    fs.closeSync(fd);
  }
}

function removeLockIfOwned(lockPath, token) {
  const existing = readLock(lockPath);
  if (!existing || existing.token !== token) return false;
  fs.rmSync(lockPath, { force: true });
  return true;
}

function acquireSingleInstanceLock({
  lockPath,
  identity = {},
  isPidAlive = defaultIsPidAlive,
  now = () => new Date(),
  releaseOnExit = false,
} = {}) {
  if (!lockPath) {
    throw new Error('lockPath is required');
  }

  const token = crypto.randomBytes(16).toString('hex');
  const payload = {
    pid: process.pid,
    token,
    acquiredAt: now().toISOString(),
    cwd: process.cwd(),
    execPath: process.execPath,
    ...identity,
  };

  for (;;) {
    try {
      writeLockExclusive(lockPath, payload);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;

      const existing = readLock(lockPath);
      if (existing?.pid && isPidAlive(existing.pid)) {
        throw new Error(
          `sign-workbench already running with pid ${existing.pid}; lock=${lockPath}`
        );
      }

      fs.rmSync(lockPath, { force: true });
    }
  }

  let released = false;
  const guard = {
    lockPath,
    token,
    release() {
      if (released) return false;
      released = true;
      return removeLockIfOwned(lockPath, token);
    },
  };

  if (releaseOnExit) {
    process.once('exit', () => {
      guard.release();
    });
  }

  return guard;
}

module.exports = {
  acquireSingleInstanceLock,
  defaultIsPidAlive,
  readLock,
};
