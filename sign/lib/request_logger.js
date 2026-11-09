'use strict';

/**
 * 结构化日志 + request_id 中间件。
 *
 * 每个请求都被打上一个 8 字节 uuid，挂在 `req.id` 上、回写到响应头
 * `X-Request-Id`、并写进所有日志行。错误日志另外打 stderr，便于
 * `grep -E "^{.*\"lvl\":\"error\""` 单独导出。
 *
 * 故意选 JSON 行格式（jsonl）而非 pino/bunyan：
 *  - 零外部依赖
 *  - 一条 = 一行，`grep` / `jq` / Loki / Vector 都能处理
 *  - 内部场景下 10w 行/月 完全用得起
 *
 * 内部辅助函数 `getLogger()` 在中间件外部也可以拿到一个带 reqId 的 logger，
 * 用于 service 层（通过 AsyncLocalStorage 传递）。
 */

const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

const requestContext = new AsyncLocalStorage();

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
const DEFAULT_LEVEL = process.env.LOG_LEVEL || 'info';
const MIN_LEVEL = LEVELS[DEFAULT_LEVEL] ?? LEVELS.info;

function shouldLog(level) {
  return (LEVELS[level] ?? 0) >= MIN_LEVEL;
}

function newRequestId() {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Write one log line.
 *
 * @param {'debug'|'info'|'warn'|'error'} level
 * @param {object} fields  — merged into the line; `msg` if present is the
 *                           short summary, anything else is structured.
 */
function writeLine(level, fields) {
  if (!shouldLog(level)) return;
  const ctx = requestContext.getStore();
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    lvl: level,
    ...(ctx?.reqId ? { reqId: ctx.reqId } : {}),
    ...fields,
  });
  if (level === 'error' || level === 'warn') {
    process.stderr.write(`${line}\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }
}

/** Bare module-level logger (no reqId unless inside a request). */
const logger = {
  debug: (msg, fields = {}) => writeLine('debug', { msg, ...fields }),
  info:  (msg, fields = {}) => writeLine('info',  { msg, ...fields }),
  warn:  (msg, fields = {}) => writeLine('warn',  { msg, ...fields }),
  error: (msg, fields = {}) => {
    const base = { msg, ...fields };
    if (fields.err instanceof Error) {
      base.err = {
        message: fields.err.message,
        stack: fields.err.stack,
        code: fields.err.code,
      };
    }
    writeLine('error', base);
  },
};

/** Convenience: get the current request's logger context (or null). */
function currentContext() {
  return requestContext.getStore() || null;
}

/** Run `fn` with a logger context bound (used in tests / cron). */
function withRequestContext(ctx, fn) {
  return requestContext.run(ctx, fn);
}

/**
 * Express middleware. Generates / reuses an `X-Request-Id`, runs the
 * downstream pipeline inside an AsyncLocalStorage context so service
 * code can call `currentContext()` without prop-drilling, and writes
 * one summary log line per response.
 */
function createRequestLogger() {
  return function requestLogger(req, res, next) {
    const reqId = String(req.headers['x-request-id'] || newRequestId());
    req.id = reqId;
    res.setHeader('X-Request-Id', reqId);

    const start = process.hrtime.bigint();
    const ctx = { reqId, route: req.path, method: req.method };

    res.on('finish', () => {
      const durMs = Number(process.hrtime.bigint() - start) / 1e6;
      const fields = {
        route: req.path,
        method: req.method,
        status: res.statusCode,
        ms: Number(durMs.toFixed(1)),
        ip: req.ip || req.socket?.remoteAddress || null,
        user: req.user?.username || null,
      };
      // promote 5xx into the warn/error stream
      if (res.statusCode >= 500) {
        writeLine('error', { msg: 'request_failed', ...fields });
      } else if (res.statusCode >= 400) {
        writeLine('warn', { msg: 'request_4xx', ...fields });
      } else {
        writeLine('info', { msg: 'request', ...fields });
      }
    });

    requestContext.run(ctx, next);
  };
}

module.exports = {
  createRequestLogger,
  logger,
  currentContext,
  withRequestContext,
  newRequestId,
};
