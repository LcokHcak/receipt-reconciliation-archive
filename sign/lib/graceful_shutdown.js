'use strict';

/**
 * Graceful shutdown coordinator.
 *
 * Wires SIGTERM / SIGINT / uncaughtException / unhandledRejection into
 * an orderly drain sequence:
 *
 *   1.  Mark `process.shuttingDown = true` so /readyz can flip to 503
 *   2.  Stop the HTTP server from accepting new sockets
 *   3.  Wait for in-flight requests to finish (with a hard timeout)
 *   4.  Run user-registered drain callbacks in **registration order**
 *       (so a DB-close drain runs after the python-pool drain that
 *       depends on it). Each drain has its own timeout.
 *   5.  Exit 0 on success, 1 on timeout / drain error
 *
 * Design notes:
 *  - One signal triggers shutdown; subsequent signals force-exit. This
 *    prevents Ctrl-C-spam from leaving the process stuck in cleanup.
 *  - Drains run sequentially, not in parallel — we want deterministic
 *    ordering between e.g. "close python pool" and "close sqlite".
 *  - The hard timeout is intentionally short (default 30s) because
 *    PM2 / systemd will SIGKILL at 32-35s anyway; we'd rather log a
 *    clean "drain timed out" than be killed mid-write.
 */

const { logger } = require('./request_logger');

const DEFAULT_REQUEST_DRAIN_MS = 15000;
const DEFAULT_DRAIN_TIMEOUT_MS = 10000;
const DEFAULT_TOTAL_TIMEOUT_MS = 30000;

function createShutdownCoordinator({
  server,
  requestDrainMs = DEFAULT_REQUEST_DRAIN_MS,
  drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
  totalTimeoutMs = DEFAULT_TOTAL_TIMEOUT_MS,
  exit = (code) => process.exit(code),
} = {}) {
  const drains = [];
  let shuttingDown = false;
  let inFlight = 0;
  const inFlightWaiters = [];

  // Expose a small middleware that increments / decrements an in-flight
  // counter so we can wait for them in step 3. We pin it to req.path so
  // /healthz keeps responding during drain.
  function trackInFlight(req, res, next) {
    if (req.path === '/healthz' || req.path === '/readyz') return next();
    inFlight += 1;
    res.on('finish', releaseOnce);
    res.on('close', releaseOnce);
    let released = false;
    function releaseOnce() {
      if (released) return;
      released = true;
      inFlight -= 1;
      if (inFlight === 0) {
        while (inFlightWaiters.length) inFlightWaiters.shift()();
      }
    }
    next();
  }

  function isShuttingDown() {
    return shuttingDown;
  }

  function registerDrain(name, fn, opts = {}) {
    if (typeof fn !== 'function') throw new Error('drain fn required');
    drains.push({
      name,
      fn,
      timeoutMs: opts.timeoutMs || drainTimeoutMs,
    });
  }

  async function waitForInFlight(deadline) {
    if (inFlight === 0) return;
    logger.info('shutdown_waiting_for_inflight', { count: inFlight });
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        logger.warn('shutdown_inflight_timeout', { remaining: inFlight });
        resolve();
      }, Math.max(0, deadline - Date.now()));
      inFlightWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async function runOneDrain({ name, fn, timeoutMs }) {
    const start = Date.now();
    // 2026-08-01:超时定时器原来只在**输掉**竞速时才有意义,赢了从不 clear。
    // drain 正常完成后那个 setTimeout 还活着,一直活到 timeoutMs(默认 10 秒)到期。
    // 常驻服务里无所谓(shutdown 末尾直接 process.exit),但任何 require 了这套
    // 并跑过 drain 的测试进程,都要白等 10 秒才退出。
    // 修法就一条:finally 里 clearTimeout —— 赢了竞速立刻收摊,一点不留。
    //
    // ⚠️ 这里**不能** unref。第一版我顺手加了,CI 当场打回:
    //   `Promise resolution is still pending but the event loop has already resolved`
    //   (tests/graceful_shutdown.test.js「drain timeout fires…」等 4 条)
    // 因为这个定时器和 lib/stage_progress_tracker 那个**性质不同**:
    //   那个到期只是丢掉内存快照 —— 进程要退出时本就不需要它跑,unref 是对的;
    //   这个到期要做的是「drain 卡住也得让关机继续走下去」,是**活性保证**。
    //   unref 之后若它是事件循环里唯一活着的东西,进程会先退出、超时永不触发,
    //   race 两边都不 settle —— 等于把兜底本身兜没了。
    //
    // 判据留给后来人:**定时器该不该 unref,看它到期时要做的事是不是"必须发生"**。
    // 只是清理 → unref;是兜底/超时/看门狗 → 不许 unref,靠 clearTimeout 收摊。
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(() => fn()),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`drain '${name}' timed out after ${timeoutMs}ms`)),
            timeoutMs
          );
        }),
      ]);
      logger.info('drain_completed', { name, ms: Date.now() - start });
    } catch (error) {
      logger.error('drain_failed', { name, ms: Date.now() - start, err: error });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function shutdown(reason) {
    if (shuttingDown) {
      // Second signal — force exit so a stuck cleanup can't trap us
      logger.warn('shutdown_forced', { reason });
      exit(1);
      return;
    }
    shuttingDown = true;
    process.shuttingDown = true;
    const startedAt = Date.now();
    const hardDeadline = startedAt + totalTimeoutMs;
    logger.info('shutdown_started', { reason, inFlight });

    // Stop accepting new sockets
    if (server && typeof server.close === 'function') {
      server.close(() => logger.info('shutdown_server_closed'));
    }

    // Wait for in-flight requests
    const reqDeadline = Math.min(startedAt + requestDrainMs, hardDeadline);
    await waitForInFlight(reqDeadline);

    // Run user-registered drains sequentially
    for (const drain of drains) {
      if (Date.now() >= hardDeadline) {
        logger.warn('shutdown_skipping_drain_total_timeout', { name: drain.name });
        continue;
      }
      await runOneDrain(drain);
    }

    const elapsedMs = Date.now() - startedAt;
    logger.info('shutdown_complete', { reason, ms: elapsedMs });
    exit(0);
  }

  function installSignalHandlers() {
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('uncaughtException', (err) => {
      logger.error('uncaught_exception', { err });
      // 走 1 退出码，让 PM2 的 min_uptime / max_restarts 起作用 ——
      // 之前用 exit(0) 会被 PM2 当成正常退出，崩溃循环被掩盖。
      shutdownWithCode('uncaughtException', 1);
    });
    process.on('unhandledRejection', (err) => {
      logger.error('unhandled_rejection', { err });
      // unhandledRejection 单独不强制退出；只记录。
    });
  }

  async function shutdownWithCode(reason, code) {
    if (shuttingDown) {
      logger.warn('shutdown_forced', { reason });
      exit(code || 1);
      return;
    }
    shuttingDown = true;
    process.shuttingDown = true;
    const startedAt = Date.now();
    const hardDeadline = startedAt + totalTimeoutMs;
    logger.info('shutdown_started', { reason, inFlight, exitCode: code });
    if (server && typeof server.close === 'function') {
      server.close(() => logger.info('shutdown_server_closed'));
    }
    const reqDeadline = Math.min(startedAt + requestDrainMs, hardDeadline);
    await waitForInFlight(reqDeadline);
    for (const drain of drains) {
      if (Date.now() >= hardDeadline) {
        logger.warn('shutdown_skipping_drain_total_timeout', { name: drain.name });
        continue;
      }
      await runOneDrain(drain);
    }
    const elapsedMs = Date.now() - startedAt;
    logger.info('shutdown_complete', { reason, ms: elapsedMs, exitCode: code });
    exit(code || 0);
  }

  return {
    trackInFlight,
    registerDrain,
    shutdown,
    installSignalHandlers,
    isShuttingDown,
    // exposed for tests
    _internals: {
      get inFlight() { return inFlight; },
      get drains() { return drains.slice(); },
    },
  };
}

module.exports = {
  createShutdownCoordinator,
  DEFAULT_REQUEST_DRAIN_MS,
  DEFAULT_DRAIN_TIMEOUT_MS,
  DEFAULT_TOTAL_TIMEOUT_MS,
};
