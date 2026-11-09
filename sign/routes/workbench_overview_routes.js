'use strict';

/**
 * 工作台首页聚合接口。
 *   GET /api/workbench/overview[?workspaceKey=YYYY-MM]
 * 返回首页三段(今日待办 / 今日进度 / 本月进度),口径见
 * services/workbench_overview_service.js 顶部注释。
 */

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

function createWorkbenchOverviewRoutes({ overviewService, auth }) {
  if (!overviewService) throw new Error('overviewService is required');
  const tokenMiddleware = resolveTokenMiddleware(auth || {});
  const protect = tokenMiddleware ? [tokenMiddleware] : [];

  function register(app) {
    app.get('/api/workbench/overview', ...protect, async (req, res) => {
      try {
        const workspaceKey = String(req.query?.workspaceKey || '').trim();
        const payload = await overviewService.getOverview({ workspaceKey, operatorUser: req.user || null });
        res.json(payload);
      } catch (error) {
        res.status(500).json({ error: error?.message || 'overview failed' });
      }
    });
  }

  return { register };
}

module.exports = { createWorkbenchOverviewRoutes };
