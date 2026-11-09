'use strict';

/**
 * 阶段进度 SSE 端点 — 让前端实时看到 tour_match / bill_match / merge /
 * second_pass 的进度，避免长任务跑 45 秒看不到任何反馈。
 *
 * GET /api/monthly/workspaces/:workspaceKey/stages/:stage/progress
 *   Server-Sent Events 流，每次进度更新推送一帧 JSON。
 *
 * 客户端用 EventSource：
 *   const es = new EventSource(`/api/monthly/.../progress`);
 *   es.onmessage = (event) => updateProgressBar(JSON.parse(event.data));
 *   es.onerror = () => es.close();
 */

const { tracker } = require('../lib/stage_progress_tracker');
const { logger } = require('../lib/logger');
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

function createStageProgressRoutes({ auth }) {
  const tokenMiddleware = resolveTokenMiddleware(auth || {});
  const protect = tokenMiddleware
    ? [tokenMiddleware]
    : [];

  function register(app) {
    app.get(
      '/api/monthly/workspaces/:workspaceKey/stages/:stage/progress',
      ...protect,
      (req, res) => {
        const { workspaceKey, stage } = req.params;

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders?.();

        function send(data) {
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        }

        // 立即返回当前状态（如果有）
        const current = tracker.get({ workspaceKey, stage });
        if (current) {
          send(current);
        } else {
          send({ status: 'idle', workspaceKey, stage });
        }

        const unsub = tracker.subscribe({ workspaceKey, stage }, send);

        // 心跳：每 15 秒发个注释行避免代理超时
        const heartbeat = setInterval(() => {
          try { res.write(': heartbeat\n\n'); } catch { /* ignore */ }
        }, 15_000);

        req.on('close', () => {
          clearInterval(heartbeat);
          unsub();
          logger.debug({ workspaceKey, stage }, 'sse_progress_disconnected');
        });
      }
    );
  }

  return { register };
}

module.exports = { createStageProgressRoutes };
