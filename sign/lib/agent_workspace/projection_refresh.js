'use strict';

// 代理视图投影准实时刷新(2026-07-24 止血)。
// 背景:agent_workspace 投影(代理视图所有数字的来源)只在①服务器启动②删批次③手动跑
// rebuild 脚本 时更新——审核/通过/结算动作本身不刷新它。所以只要没重启/没人跑 cron,
// 页面数字就冻在上次刷新时刻(实测"数据同步滞后 385 分钟"=6.4 小时没刷,期间审核全不算)。
// 止血:应用内定期**增量**刷新——每 intervalMs 扫一遍批次 batch.json 的 mtime,只重新
// 同步"上次刷新后改动过"的批次(syncBatch 是按批次 scoped 的,同步子集不影响别的批次)。
// 不做全量重扫(1.8 万客户全量同步会周期性卡事件循环),故用 mtime 增量。

// 纯函数:挑出 mtime >= sinceMs 的批次 id。mtimeOf 注入(测试可不碰 fs);stat 失败=0(跳过,
// 删批次由 removeBatch 另管)。sinceMs<=0 视为"全都算改过"(首次/兜底)。
function pickChangedBatchIds({ batchIds = [], mtimeOf, sinceMs = 0 } = {}) {
  const ids = Array.isArray(batchIds) ? batchIds : [];
  if (typeof mtimeOf !== 'function') return [];
  const since = Number(sinceMs) || 0;
  const out = [];
  for (const id of ids) {
    let mt;
    try { mt = Number(mtimeOf(id)) || 0; } catch { mt = 0; }
    if (since <= 0 || mt >= since) out.push(id);
  }
  return out;
}

// 单次增量刷新:load 改动过的批次 → syncBatches。load/sync 失败吞掉记日志,绝不抛(不炸定时器)。
function refreshChangedBatches({ changedBatchIds = [], loadBatch, syncBatches, logger = null } = {}) {
  const ids = Array.isArray(changedBatchIds) ? changedBatchIds : [];
  if (!ids.length) return { synced: 0, failedLoad: 0, syncError: false };
  const batches = [];
  let failedLoad = 0;
  for (const id of ids) {
    try {
      batches.push(loadBatch(id));
    } catch (error) {
      failedLoad += 1;
      logger?.warn?.('projection_refresh_load_failed', { batchId: id, error: String(error?.message || error) });
    }
  }
  if (!batches.length) return { synced: 0, failedLoad, syncError: false };
  try {
    syncBatches(batches);
    return { synced: batches.length, failedLoad, syncError: false };
  } catch (error) {
    logger?.error?.('projection_refresh_sync_failed', { count: batches.length, error: String(error?.message || error) });
    return { synced: 0, failedLoad, syncError: true };
  }
}

// 调度器:每 intervalMs 调一次 runOnce。重入守卫(上轮没跑完就跳过,防慢刷叠加)+ 错误吞掉。
// setIntervalFn/clearIntervalFn 可注入(测试用假定时器)。
function createProjectionRefreshScheduler({
  runOnce,
  intervalMs = 120000,
  logger = null,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  if (typeof runOnce !== 'function') throw new Error('runOnce is required');
  let timer = null;
  let running = false;

  async function tick() {
    if (running) {
      logger?.info?.('projection_refresh_skip_overlap');
      return;
    }
    running = true;
    try {
      await runOnce();
    } catch (error) {
      logger?.error?.('projection_refresh_tick_failed', { error: String(error?.message || error) });
    } finally {
      running = false;
    }
  }

  return {
    start() {
      const ms = Number(intervalMs) || 0;
      if (timer || ms <= 0) return this; // ms<=0 = 关闭(env 显式禁用)
      timer = setIntervalFn(tick, ms);
      if (timer && typeof timer.unref === 'function') timer.unref(); // 不阻止进程退出
      return this;
    },
    stop() {
      if (timer) {
        clearIntervalFn(timer);
        timer = null;
      }
    },
    isRunning() {
      return running;
    },
    tickNow: tick, // 测试/手动触发
  };
}

module.exports = { pickChangedBatchIds, refreshChangedBatches, createProjectionRefreshScheduler };
