'use strict';

/**
 * Admin 路由 — 给管理员（admin role）访问的运维入口。
 *
 * 端点：
 *   GET  /api/admin/logs                 - 查询日志（按级别/关键词/时间过滤）
 *   GET  /api/admin/logs/stream          - SSE 流式日志（实时刷新）
 *   GET  /api/admin/dashboard            - 仪表盘汇总（错误数、慢请求、阶段任务、磁盘等）
 *   GET  /api/admin/feedback             - 用户反馈列表
 *   POST /api/admin/feedback/:id/resolve - 关闭一条反馈
 *
 * 安全：所有路由都要求 role='admin'，从 req.user.role 取。
 */

const { queryLogs, queryLogsSince, getLogStats } = require('../services/log_query_service');
const { logger } = require('../lib/logger');
const {
  authenticateToken: createAuthenticateToken,
  requireRole: defaultRequireRole,
} = require('../lib/auth/jwt_middleware');

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

function createAdminRoutes({
  monthlyDb,
  workbenchDb,
  pythonPool,
  feedbackRepo,
  modelArtifactRegistry,
  auth,
}) {
  const tokenMiddleware = resolveTokenMiddleware(auth || {});
  const roleGuard = auth?.requireRole || defaultRequireRole;
  const protect = (tokenMiddleware && roleGuard)
    ? [tokenMiddleware, roleGuard('admin')]
    : [];

  function register(app) {
    app.get('/api/admin/logs', ...protect, async (req, res) => {
      try {
        const {
          source = 'app',
          level,
          levelAtLeast,
          q,
          event,
          startTime,
          endTime,
          maxLines = '1000',
        } = req.query;
        const max = Math.min(Math.max(Number(maxLines) || 1000, 100), 5000);

        const logs = await queryLogs({
          source: source === 'error' ? 'error' : 'app',
          maxLines: max,
          filter: { level, levelAtLeast, q, event, startTime, endTime },
        });

        res.json({ logs, count: logs.length, source, maxLines: max });
      } catch (error) {
        logger.error({ err: error }, 'admin_logs_query_failed');
        res.status(500).json({ error: error?.message || 'query failed' });
      }
    });

    app.get('/api/admin/logs/stream', ...protect, async (req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();

      let lastTime = Date.now();
      const tick = async () => {
        try {
          const logs = await queryLogsSince({
            since: lastTime,
            source: req.query.source === 'error' ? 'error' : 'app',
            maxLines: 200,
          });
          if (logs.length) {
            res.write(`data: ${JSON.stringify(logs)}\n\n`);
            const newest = Math.max(...logs.map((l) => new Date(l.time).getTime()));
            if (newest > lastTime) lastTime = newest;
          }
        } catch (error) {
          res.write(`event: error\ndata: ${JSON.stringify({ message: error?.message })}\n\n`);
        }
      };

      const interval = setInterval(tick, 3000);
      req.on('close', () => {
        clearInterval(interval);
        res.end();
      });
    });

    app.get('/api/admin/dashboard', ...protect, async (req, res) => {
      try {
        const stats = await getLogStats({ windowHours: 24, maxLines: 10000 });

        const stageJobs = monthlyDb
          ? monthlyDb.prepare(`
              SELECT stage, workspace_key, started_at, status
              FROM stage_job
              WHERE status = 'running' OR finished_at > datetime('now', '-1 day')
              ORDER BY started_at DESC
              LIMIT 50
            `).all()
          : [];

        const dbStats = monthlyDb ? getDbStats(monthlyDb) : null;
        const workbenchDbStats = workbenchDb ? getDbStats(workbenchDb) : null;

        const dashboard = {
          timestamp: new Date().toISOString(),
          uptime: process.uptime(),
          memory: process.memoryUsage(),
          logs: stats,
          stageJobs: {
            running: stageJobs.filter((j) => j.status === 'running'),
            recent: stageJobs.filter((j) => j.status !== 'running').slice(0, 20),
          },
          databases: {
            monthly: dbStats,
            workbench: workbenchDbStats,
          },
          pythonPool: pythonPool ? {
            stats: pythonPool.getStats?.() || null,
          } : null,
          models: modelArtifactRegistry ? {
            enabled: modelArtifactRegistry.enabled,
            detection: modelArtifactRegistry.detection.ready,
            classification: modelArtifactRegistry.classification.ready,
            passportField: modelArtifactRegistry.passportFieldDetection.ready,
            receiptField: modelArtifactRegistry.receiptFieldDetection.ready,
          } : null,
        };

        res.json(dashboard);
      } catch (error) {
        logger.error({ err: error }, 'admin_dashboard_failed');
        res.status(500).json({ error: error?.message || 'dashboard failed' });
      }
    });

    if (feedbackRepo) {
      app.get('/api/admin/feedback', ...protect, (req, res) => {
        try {
          const { status, limit = '100', offset = '0' } = req.query;
          const rows = feedbackRepo.list({
            status: status || null,
            limit: Number(limit) || 100,
            offset: Number(offset) || 0,
          });
          res.json({ rows, total: feedbackRepo.count({ status: status || null }) });
        } catch (error) {
          logger.error({ err: error }, 'admin_feedback_list_failed');
          res.status(500).json({ error: error?.message || 'list failed' });
        }
      });

      app.post('/api/admin/feedback/:id/resolve', ...protect, (req, res) => {
        try {
          const changes = feedbackRepo.resolve({
            id: Number(req.params.id),
            resolvedBy: req.user?.username || 'admin',
            resolution: req.body?.resolution || null,
          });
          res.json({ ok: changes > 0 });
        } catch (error) {
          logger.error({ err: error }, 'admin_feedback_resolve_failed');
          res.status(500).json({ error: error?.message || 'resolve failed' });
        }
      });
    }
  }

  return { register };
}

function getDbStats(db) {
  try {
    const pageCount = db.prepare('PRAGMA page_count').get();
    const pageSize = db.prepare('PRAGMA page_size').get();
    return {
      pageCount: pageCount?.page_count || 0,
      pageSize: pageSize?.page_size || 0,
      sizeBytes: (pageCount?.page_count || 0) * (pageSize?.page_size || 0),
    };
  } catch {
    return null;
  }
}

module.exports = { createAdminRoutes };
