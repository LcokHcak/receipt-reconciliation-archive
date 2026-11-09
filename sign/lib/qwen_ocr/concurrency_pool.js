'use strict';

// 受限并发执行 + 429/网络错误指数退避重试。
// 替代 PaddleX 的 Python 进程池:从源头压住瞬时爆发(防限流),失败自动退避。

// 带退避的重试包装:对 429(限流)/5xx/网络错误重试,尊重 Retry-After。
async function withRetry(fn, { maxAttempts = 3, baseDelayMs = 1000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err?.status;
      const retriable = status === 429 || (status >= 500 && status < 600) || status == null;
      if (!retriable || attempt === maxAttempts) break;
      const retryAfter = Number(err?.retryAfterMs);
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter
        : baseDelayMs * Math.pow(2, attempt - 1); // 指数退避 1s, 2s, 4s
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// 并发池:对 items 以最多 concurrency 个并发跑 worker,保持结果顺序。
async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let idx = 0;
  async function next() {
    while (idx < items.length) {
      const cur = idx++;
      results[cur] = await worker(items[cur], cur);
    }
  }
  const n = Math.max(1, Math.min(concurrency || 1, items.length));
  await Promise.all(Array.from({ length: n }, next));
  return results;
}

module.exports = { withRetry, runPool };
