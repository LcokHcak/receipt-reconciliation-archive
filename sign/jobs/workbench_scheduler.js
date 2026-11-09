function createWorkbenchScheduler({
  processBatch,
  onError = console.error,
  maxConcurrentBatches = process.env.WORKBENCH_MAX_ACTIVE_BATCHES,
  deferRun = setImmediate,
} = {}) {
  const activeBatches = new Set();
  const pendingBatches = [];
  const maxActive = Math.max(1, Number.parseInt(String(maxConcurrentBatches || 2), 10) || 2);
  let drainScheduled = false;
  // run-token(2026-07-08 悬死事故):看门狗强制释放守卫并重跑后,悬死的老协程
  // 若迟到复活,它的 finally 不得误删新一轮运行的守卫(否则守卫洞开,同批次可三重并发)。
  // 每轮运行发一个 token,finally 只清理"仍属于自己"的守卫。
  const activeRunTokens = new Map();
  let runTokenSeq = 0;

  function requestDrain() {
    if (drainScheduled) {
      return;
    }
    drainScheduled = true;
    deferRun(() => {
      drainScheduled = false;
      runNext();
    });
  }

  function runNext() {
    while (activeBatches.size < maxActive && pendingBatches.length) {
      const batchId = pendingBatches.shift();
      runTokenSeq += 1;
      const token = runTokenSeq;
      activeBatches.add(batchId);
      activeRunTokens.set(batchId, token);
      Promise.resolve()
        .then(() => processBatch(batchId))
        .catch((error) => {
          onError(error);
        })
        .finally(() => {
          // 只清理仍属于本轮的守卫:被看门狗强制释放/重跑后,老协程的 finally 是 no-op
          if (activeRunTokens.get(batchId) === token) {
            activeBatches.delete(batchId);
            activeRunTokens.delete(batchId);
          }
          requestDrain();
        });
    }
  }

  // 看门狗用:强制释放调度器侧守卫(悬死协程占着 activeBatches,scheduleBatch 全被吞)。
  // 返回释放时守卫是否真被占(诊断用)。
  function forceReleaseBatch(batchId) {
    const held = activeBatches.has(batchId);
    activeBatches.delete(batchId);
    activeRunTokens.delete(batchId);
    return held;
  }

  // 停摆扫描:有积压任务(queued/processing>0)、不在排队队列、且落盘识别进度超过
  // stallThresholdMs 没动过的批次 = 停摆 → 释放双守卫(调度器+处理器)+ 重新调度 + 大声记日志。
  // 候选筛选用便宜的摘要(counts),停摆判定必须 loadBatch 读**落盘原值**——
  // 摘要里的 recognitionProgress 快照查看时会重算时间戳,不能当陈旧信号。
  // 从未开跑的批次(无进度对象)用批次落盘时间兜底判陈旧。
  function sweepStalledBatches({
    listBatchSummaries,
    loadBatch,
    processorForceRelease = () => false,
    stallThresholdMs = 5 * 60 * 1000,
    now = Date.now,
    log = () => {},
  }) {
    const revived = [];
    let summaries;
    try {
      summaries = listBatchSummaries() || [];
    } catch (error) {
      onError(error);
      return revived;
    }
    for (const summary of summaries) {
      const batchId = String(summary?.id || '').trim();
      if (!batchId) continue;
      const counts = summary?.counts || {};
      const backlog = (Number(counts.queued) || 0) + (Number(counts.processing) || 0);
      if (backlog <= 0) continue;
      if (pendingBatches.includes(batchId)) continue; // 在队列里等槽位=正常
      let raw;
      try {
        raw = loadBatch(batchId);
      } catch {
        continue; // 批次刚被删,跳过
      }
      const progress = raw?.recognitionProgress || null;
      const lastBeatIso = (progress && (progress.updatedAt || progress.startedAt)) || raw?.updatedAt || '';
      const lastBeat = Date.parse(lastBeatIso);
      // processing>0 = 有 chunk 在飞:可能是合法慢 chunk(连续活调 qwen 一个 stage 可跑很久,
      // 期间只有 stage begin 写过进度)→ 用 3 倍硬上限,防误杀;
      // processing=0 = 间隙停摆指纹(本次事故形态)→ 普通阈值即可。
      // F2(2026-07-20):有积压任务、既不在排队队列(上面已 continue)、也不在处理集 activeBatches、
      // 且没有 chunk 在飞(processing=0)= 没有任何协程/chunk 在管它(进程重启中断处理循环 /
      // 处理协程异常退出未复位)→ 孤儿批次,无视 lastBeat 直接救。否则批次的并发活动
      // (追加建档 / 审核改字段)持续刷新 batch.updatedAt,会掩盖个别 queued 任务的永久停摆
      // (2026-07-20 实测:重启后 5 个已建档任务永卡 queued,看门狗因 lastBeat 常新而 20+ 分钟不救)。
      // processing>0(有 chunk 在飞,可能是合法慢 chunk)仍走 lastBeat*3 判定防误杀,不算孤儿。
      const inFlight = (Number(counts.processing) || 0) > 0;
      const orphaned = !inFlight && !activeBatches.has(batchId);
      const effectiveThresholdMs = inFlight ? stallThresholdMs * 3 : stallThresholdMs;
      if (!orphaned && Number.isFinite(lastBeat) && now() - lastBeat < effectiveThresholdMs) continue;
      const heldScheduler = forceReleaseBatch(batchId);
      const heldProcessor = Boolean(processorForceRelease(batchId));
      log('batch_stall_revived', {
        batchId,
        queued: Number(counts.queued) || 0,
        processing: Number(counts.processing) || 0,
        heldScheduler,
        heldProcessor,
        lastBeat: lastBeatIso || null,
        stallThresholdMs,
      });
      scheduleBatch(batchId);
      revived.push(batchId);
    }
    return revived;
  }

  // 停摆看门狗定时器:与 registerStageRetry 同款接线(shutdown 时清)。
  function registerStallWatchdog({ intervalMs, shutdownCoordinator, ...sweepDeps }) {
    const timer = setInterval(() => {
      try {
        sweepStalledBatches(sweepDeps);
      } catch (error) {
        onError(error);
      }
    }, intervalMs);
    console.log(`[workbench] Batch stall watchdog started (${intervalMs}ms)`);
    shutdownCoordinator.registerDrain('batch_stall_watchdog', async () => {
      clearInterval(timer);
      console.log('[workbench] Batch stall watchdog stopped');
    });
  }


  // priority=true 插队到队首:操作员正在等的批次(建档/追加/点重识别)不能排在
  // 后台补识别的几十个批次后面挨饿(2026-07-03 生产事故:5000+补识别把FIFO占满,
  // 新上传"等待识别"卡一个多小时)。启动恢复/后台修复走默认队尾。
  function scheduleBatch(batchId, { priority = false } = {}) {
    if (activeBatches.has(batchId)) {
      return;
    }
    const queuedIndex = pendingBatches.indexOf(batchId);
    if (queuedIndex >= 0) {
      if (priority && queuedIndex > 0) {
        pendingBatches.splice(queuedIndex, 1);
        pendingBatches.unshift(batchId);
      }
      return;
    }
    if (priority) {
      pendingBatches.unshift(batchId);
    } else {
      pendingBatches.push(batchId);
    }
    requestDrain();
  }

  async function resumeIncompleteBatches({ listBatchIds, loadBatch }) {
    // 新批次先跑:批次 id 含创建时间戳,倒序=今天操作员正干活的批次先恢复,
    // 历史补跑批次殿后(同样是防饿,重启后别让旧账压住当天活)。
    const ids = [...listBatchIds()].sort((a, b) => String(b).localeCompare(String(a)));
    for (const batchId of ids) {
      try {
        const batch = loadBatch(batchId);
        if (
          batch.machineState === 'queued'
          || batch.machineState === 'processing'
          || batch.tasks.some((task) => task.machineState === 'queued' || task.machineState === 'processing')
        ) {
          scheduleBatch(batchId);
        }
      } catch (error) {
        onError(error);
      }
    }
  }

  function registerStageRetry({ stageRetryService, intervalMs, shutdownCoordinator }) {
    const retryInterval = setInterval(() => {
      stageRetryService.checkAndRetry().catch((error) => {
        console.error('[workbench] Stage retry check failed:', error);
      });
    }, intervalMs);

    console.log(`[workbench] Stage retry timer started (${intervalMs}ms)`);

    shutdownCoordinator.registerDrain('stage_retry_timer', async () => {
      clearInterval(retryInterval);
      console.log('[workbench] Stage retry timer stopped');
    });
  }

  return {
    activeBatches,
    pendingBatches,
    forceReleaseBatch,
    registerStageRetry,
    registerStallWatchdog,
    resumeIncompleteBatches,
    scheduleBatch,
    sweepStalledBatches,
  };
}

module.exports = {
  createWorkbenchScheduler,
};
