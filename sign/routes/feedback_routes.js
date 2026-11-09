'use strict';

/**
 * 用户反馈接口 — 任何登录用户都能提交。
 * 管理员通过 /api/admin/feedback 查看。
 */

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

function createFeedbackRoutes({ feedbackRepo, auth }) {
  const tokenMiddleware = resolveTokenMiddleware(auth || {});
  const protect = tokenMiddleware
    ? [tokenMiddleware]
    : [];

  function register(app) {
    app.post('/api/feedback', ...protect, (req, res) => {
      try {
        const { pageUrl, requestId, description, screenshotPath } = req.body || {};
        if (!description || String(description).trim().length < 5) {
          return res.status(400).json({ error: '请描述具体问题（至少 5 个字）' });
        }
        const result = feedbackRepo.submit({
          userId: req.user?.id,
          username: req.user?.username,
          pageUrl: pageUrl || req.get('referer') || null,
          requestId: requestId || null,
          userAgent: req.get('user-agent') || null,
          description,
          screenshotPath: screenshotPath || null,
        });
        logger.info({
          feedbackId: result.id,
          username: req.user?.username,
          pageUrl,
        }, 'feedback_submitted');
        res.json({ ok: true, id: result.id });
      } catch (error) {
        logger.error({ err: error }, 'feedback_submit_failed');
        res.status(500).json({ error: error?.message || 'submit failed' });
      }
    });
  }

  return { register };
}

module.exports = { createFeedbackRoutes };
