/**
 * Simple in-memory fixed-window rate limiter.
 *
 * Designed for the local workbench (single-process Node, low QPS). For a
 * distributed deployment swap this for Redis/Upstash or a reverse-proxy rule.
 *
 * Usage:
 *   const limiter = createRateLimiter({ windowMs: 60_000, max: 5 });
 *   app.post('/api/auth/login', limiter, handler);
 */

function createRateLimiter({
  windowMs = 60_000,
  max = 5,
  message = 'Too many requests, please retry later',
  keyGenerator = (req) => req.ip || req.socket?.remoteAddress || 'unknown',
  statusCode = 429,
  skipSuccessfulRequests = true,
} = {}) {
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new Error('windowMs must be a positive number');
  }
  if (!Number.isFinite(max) || max <= 0) {
    throw new Error('max must be a positive number');
  }

  const buckets = new Map();

  function prune(now) {
    for (const [key, bucket] of buckets.entries()) {
      if (bucket.resetAt <= now) {
        buckets.delete(key);
      }
    }
  }

  return function rateLimiter(req, res, next) {
    const now = Date.now();
    if (buckets.size > 10_000) {
      prune(now);
    }
    const key = keyGenerator(req);
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    if (bucket.count >= max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(statusCode).json({ error: message, retryAfter });
    }
    bucket.count += 1;

    if (skipSuccessfulRequests) {
      res.on('finish', () => {
        // Refund the slot on non-auth-failure responses so that the limiter
        // only penalises actual failed attempts (401/403/4xx login errors).
        if (res.statusCode < 400) {
          bucket.count = Math.max(0, bucket.count - 1);
        }
      });
    }

    return next();
  };
}

module.exports = {
  createRateLimiter,
};
