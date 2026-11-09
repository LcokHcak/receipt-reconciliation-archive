'use strict';

/**
 * api_error_middleware — 尾部 API 错误处理器(2026-07-16 审计H2)。
 *
 * 背景:server/create_app.js 的全局错误处理器在 workbench/customer/monthly 路由后即注册,
 * 但 admin/training/config/library-delivery/overview 等路由在 workbench_server 里**后置**挂载,
 * 排在那个处理器之后 → 它们抛的错(next(error) 或 Express5 async 拒绝)会漏过前置处理器,
 * 落到 Express 默认 finalhandler:返回非 JSON 500、api_500 不计数、logger 不打点、预发泄漏堆栈。
 *
 * 本中间件在**全部后置路由之后**再挂一道,纯追加(不改前置处理器对更早路由的行为):
 * 前置处理器仍接住排在它之前的路由的错;本尾部处理器接住排在它之前(即后置注册)的路由的错。
 * 契约与 create_app 的核心分支一致:AppError→其状态码;/api/ 其它错→500 内部错误+api_500 计数。
 */

const { AppError } = require('./errors');

function createApiErrorMiddleware({ logger = null, opsMetrics = null } = {}) {
  return function apiTailErrorHandler(error, req, res, next) {
    if (!error || res.headersSent) return next(error);
    if (error instanceof AppError) {
      return res.status(error.status).json({ error: error.message, code: error.code, details: error.details });
    }
    if (String(req.path || '').startsWith('/api/')) {
      try { if (logger) logger.error('api_handler_error', { err: error, route: req.path, method: req.method }); } catch { /* 打点失败不致命 */ }
      try { if (opsMetrics) opsMetrics.inc('api_500', { route: req.path, message: error && error.message }); } catch { /* 计数失败不致命 */ }
      return res.status(500).json({ error: 'Internal error', code: 'internal_error' });
    }
    return next(error);
  };
}

module.exports = { createApiErrorMiddleware };
