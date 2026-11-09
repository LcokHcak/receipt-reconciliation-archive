'use strict';

/**
 * client_error_routes — 前端未捕获异常上报(#4 系统喊疼,2026-07-14)。
 *
 * POST /api/client-errors  (登录用户;每用户 10 分钟窗最多 30 条,超限 204 静默吞)
 *   body: { message, stack?, url?, appBoot? }
 *   落 structuredLogger.warn('client_error', ...)(grep client_error)+ ops_metrics 计数。
 *
 * 设计口径:上报失败/超限绝不打扰操作员(前端 fire-and-forget,这里也永不 4xx/5xx);
 * 它是"喊疼",不是审计——去重靠前端节流+这里的窗口限额。
 */

const { authenticateToken: createAuthenticateToken } = require('../lib/auth/jwt_middleware');
const { opsMetrics } = require('../lib/ops_metrics');

function resolveTokenMiddleware(auth = {}) {
  if (typeof auth.authenticateToken === 'function') {
    return auth.authenticateToken.length >= 3
      ? auth.authenticateToken
      : auth.authenticateToken({ secret: auth.jwtSecret, userService: auth.userService });
  }
  if (auth.jwtSecret) {
    return createAuthenticateToken({ secret: auth.jwtSecret, userService: auth.userService });
  }
  return null;
}

const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 30;

function createClientErrorRoutes({ auth, logger }) {
  const tokenMiddleware = resolveTokenMiddleware(auth || {});
  const protect = tokenMiddleware ? [tokenMiddleware] : [];
  const buckets = new Map(); // username -> { count, windowStart }

  function allow(user) {
    const key = String(user || 'anon');
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || now - bucket.windowStart > WINDOW_MS) {
      buckets.set(key, { count: 1, windowStart: now });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= MAX_PER_WINDOW;
  }

  function register(app) {
    app.post('/api/client-errors', ...protect, (req, res) => {
      const username = req.user?.username || req.user?.id || '';
      if (allow(username)) {
        const body = req.body || {};
        const entry = {
          user: username,
          message: String(body.message || '').slice(0, 500),
          stack: String(body.stack || '').slice(0, 2000),
          url: String(body.url || '').slice(0, 300),
          appBoot: String(body.appBoot || '').slice(0, 64),
        };
        logger?.warn?.('client_error', entry);
        opsMetrics.inc('client_error', { user: entry.user, message: entry.message });
      }
      return res.status(204).end(); // 永远 204:上报通道自己绝不能成为新的报错源
    });

    // 运维随手看:当前窗口疼点计数(admin)
    app.get('/api/admin/ops-digest', ...protect, (req, res) => {
      if (req.user?.role !== 'admin') return res.status(403).json({ error: '仅管理员' });
      return res.json(opsMetrics.snapshot());
    });
  }

  return { register };
}

module.exports = { createClientErrorRoutes };
