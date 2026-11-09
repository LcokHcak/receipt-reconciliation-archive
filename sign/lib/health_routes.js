'use strict';

/**
 * /healthz + /readyz endpoints.
 *
 * 区分两个目的：
 *   - /healthz  liveness：进程是不是还活着、能不能响应。永远 200 除非
 *                          整个 Node event loop 已经卡死（那时返回不
 *                          来）。给 systemd / PM2 / 浏览器 ping 用。
 *   - /readyz   readiness：服务是不是已经能接流量。会真正打开 DB、
 *                          检查关键资源；DB 锁住或 schema 还在 migrate
 *                          时返回 503。给负载均衡 / 上线发布用。
 *
 * 这里没有 dependency injection 框架，但所有探测都是可选的：
 * 任何 probe 函数 throw 都被转成对应字段 `{ ok: false, err: ... }`，
 * 不会让整个 endpoint 挂掉。
 */

function createHealthRoutes({
  // sync probes — 应该都很快
  probes = {},
  getBatchWriteQueueMetrics = null,
  batchWriteQueueMaxDepth = Number(process.env.BATCH_WRITE_QUEUE_READY_MAX_DEPTH || 50),
  // 服务版本 / git sha / 启动时间，纯展示
  meta = {},
} = {}) {
  const startedAt = new Date().toISOString();
  const readyProbes = { ...probes };

  if (typeof getBatchWriteQueueMetrics === 'function') {
    readyProbes.batch_write_queue = () => {
      const metrics = getBatchWriteQueueMetrics();
      const maxDepth = Number(metrics?.maxDepth || 0);
      return {
        ok: maxDepth <= batchWriteQueueMaxDepth,
        threshold: batchWriteQueueMaxDepth,
        ...(metrics && typeof metrics === 'object' ? metrics : {}),
      };
    };
  }

  async function runProbe(name) {
    const fn = readyProbes[name];
    if (typeof fn !== 'function') {
      return { ok: true, skipped: true };
    }
    try {
      const result = await fn();
      // Convention: probe returns truthy / object { ok, ... } on success
      if (result && typeof result === 'object') return { ok: true, ...result };
      return { ok: Boolean(result) };
    } catch (error) {
      return {
        ok: false,
        error: String(error?.message || error),
      };
    }
  }

  function register(app) {
    app.get('/healthz', (_req, res) => {
      res.json({
        status: 'ok',
        startedAt,
        uptimeSec: Math.round(process.uptime()),
        ...meta,
      });
    });

    app.get('/readyz', async (_req, res) => {
      const checks = {};
      for (const name of Object.keys(readyProbes)) {
        // sequential; the probe set is small (db / pool / disk)
        checks[name] = await runProbe(name);
      }
      const allOk = Object.values(checks).every((c) => c.ok);
      res.status(allOk ? 200 : 503).json({
        status: allOk ? 'ready' : 'not_ready',
        startedAt,
        uptimeSec: Math.round(process.uptime()),
        checks,
        ...meta,
      });
    });
  }

  return { register };
}

module.exports = { createHealthRoutes };
