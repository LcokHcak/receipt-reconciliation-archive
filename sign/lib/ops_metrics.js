'use strict';

/**
 * ops_metrics — 系统喊疼(#4 报警,2026-07-14)。
 *
 * 为什么:七月连环报障复盘的元问题=**关键失败只躺在日志里,没人主动看**——
 * 操作员先撞上,老板转述,我们再去 grep。这里给关键失败装计数器:
 *   - 每小时一条 ops_digest 结构化日志(有异常才打,零异常不刷屏);
 *   - GET /api/admin/ops-digest 随时看当前窗口计数(admin);
 *   - 计数器纯内存,重启清零——它是"最近有没有在疼",不是审计存证(存证在各自结构化日志)。
 *
 * 记什么(v1,少而准):
 *   api_500        统一错误出口兜到的 /api/ 500(server/create_app)
 *   client_error   前端上报的未捕获异常(routes/client_error_routes)
 * 后续接点(留名):settle_failed / config_fallback / batch_append_copy_skip。
 */

function createOpsMetrics({ logger = null } = {}) {
  const counts = new Map();
  const samples = new Map(); // key -> 最近一条样本(message/route),digest 里带上好定位
  let windowStartedAt = Date.now();
  let timer = null;

  function inc(key, sample = null) {
    const k = String(key || 'unknown');
    counts.set(k, (counts.get(k) || 0) + 1);
    if (sample) samples.set(k, sample);
  }

  function snapshot() {
    return {
      windowStartedAt: new Date(windowStartedAt).toISOString(),
      counts: Object.fromEntries(counts),
      samples: Object.fromEntries(samples),
    };
  }

  function flush() {
    const snap = snapshot();
    const total = Object.values(snap.counts).reduce((n, v) => n + v, 0);
    if (total > 0) {
      logger?.warn?.('ops_digest', snap); // 有疼才喊;grep ops_digest 看全天
    }
    counts.clear();
    samples.clear();
    windowStartedAt = Date.now();
    return snap;
  }

  /** 每小时冲一次(unref:不拖住进程退出)。测试不调它=零计时器。 */
  function startHourlyDigest(intervalMs = 60 * 60 * 1000) {
    if (timer) return;
    timer = setInterval(flush, intervalMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { inc, snapshot, flush, startHourlyDigest, stop };
}

// 共享默认实例:create_app 的统一错误出口直接用它(避免穿针引线改一串工厂签名);
// server 启动时对它 startHourlyDigest。测试里它只是安静的计数器。
const opsMetrics = createOpsMetrics();

module.exports = { createOpsMetrics, opsMetrics };
