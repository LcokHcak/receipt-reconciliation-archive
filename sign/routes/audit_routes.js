'use strict';

const { authenticateToken: createAuthenticateToken } = require('../lib/auth/jwt_middleware');

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

/**
 * audit_routes — 审计日志查询 API（Sprint 2 W4）。
 *
 * GET /api/audit/logs
 *   查询审计日志，支持过滤：
 *     - workspaceKey
 *     - userId
 *     - action
 *     - resourceType
 *     - startDate / endDate
 *     - limit / offset
 *
 * 仅 admin 角色可访问。
 */

function createAuditRoutes({ auditLogRepo, auth }) {
  if (!auditLogRepo) {
    throw new Error('audit_routes: auditLogRepo required');
  }

  const tokenMiddleware = resolveTokenMiddleware(auth || {});
  const protect = tokenMiddleware
    ? [tokenMiddleware]
    : [];

  // ── E0c: distinct value endpoints for filter UI ────────────────────────────
  function registerDistinct(app, path, getFn) {
    app.get(path, ...protect, (req, res) => {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Forbidden: admin role required' });
      }
      const workspaceKey = req.query.workspaceKey || null;
      try {
        res.json({ values: getFn({ workspaceKey }) });
      } catch (error) {
        console.error(`[audit_routes] distinct query failed (${path}):`, error);
        res.status(500).json({ error: 'distinct query failed' });
      }
    });
  }

  function register(app) {
    registerDistinct(app, '/api/audit/distinct/users',          (q) => auditLogRepo.distinctUsers(q));
    registerDistinct(app, '/api/audit/distinct/actions',        (q) => auditLogRepo.distinctActions(q));
    registerDistinct(app, '/api/audit/distinct/workspaces',     (q) => auditLogRepo.distinctWorkspaces(q));
    registerDistinct(app, '/api/audit/distinct/resource-types', (q) => auditLogRepo.distinctResourceTypes(q));

    app.get(
      '/api/audit/logs',
      ...protect,
      (req, res) => {
        // 仅 admin 可访问
        if (req.user?.role !== 'admin') {
          return res.status(403).json({ error: 'Forbidden: admin role required' });
        }

        const {
          workspaceKey,
          userId,
          action,
          resourceType,
          startDate,
          endDate,
          limit = 100,
          offset = 0,
        } = req.query;

        try {
          const logs = auditLogRepo.list({
            workspaceKey: workspaceKey || null,
            userId: userId || null,
            action: action || null,
            resourceType: resourceType || null,
            startDate: startDate || null,
            endDate: endDate || null,
            limit: Math.min(Number(limit) || 100, 1000),
            offset: Number(offset) || 0,
          });

          const total = auditLogRepo.count({
            workspaceKey: workspaceKey || null,
            userId: userId || null,
            action: action || null,
            resourceType: resourceType || null,
            startDate: startDate || null,
            endDate: endDate || null,
          });

          res.json({
            logs,
            total,
            limit: Math.min(Number(limit) || 100, 1000),
            offset: Number(offset) || 0,
          });
        } catch (error) {
          console.error('[audit_routes] Failed to query logs:', error);
          res.status(500).json({ error: 'Failed to query audit logs' });
        }
      }
    );
  }

  return { register };
}

module.exports = { createAuditRoutes };
