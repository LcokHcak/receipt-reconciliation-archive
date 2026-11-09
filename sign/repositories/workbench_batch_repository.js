const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');

const { defaultPerformanceMonitor } = require('../lib/performance_monitor');
const { logger: defaultLogger } = require('../lib/request_logger');
const { ensureDir } = require('../lib/workbench_utils');

const BATCH_LIST_CACHE_TTL_MS = 5000;
const DEFAULT_BATCH_WRITE_TIMEOUT_MS = 30_000;
const DEFAULT_BATCH_WRITE_ACQUIRE_WARN_MS = 5_000;

class BatchWriteTimeoutError extends Error {
  constructor({ batchId, label, waitedMs, timeoutMs, queueDepth }) {
    super(
      `Batch write timed out: batchId=${batchId}, label=${label}, waitedMs=${waitedMs}, timeoutMs=${timeoutMs}, queueDepth=${queueDepth}`
    );
    this.name = 'BatchWriteTimeoutError';
    this.code = 'BATCH_WRITE_TIMEOUT';
    this.batchId = batchId;
    this.label = label;
    this.waitedMs = waitedMs;
    this.timeoutMs = timeoutMs;
    this.queueDepth = queueDepth;
  }
}

function normalizePositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeNonNegativeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeBatchWriteLabel(value) {
  return String(value || '').trim() || 'unknown';
}

function createWorkbenchBatchRepository({
  batchesRoot,
  normalizeBatch,
  summarizeBatch,
  sqliteSyncService = null,
  performanceMonitor = defaultPerformanceMonitor,
  logger = defaultLogger,
}) {
  const batchWriteQueues = new Map();
  const batchWriteQueueEntries = new Map();
  let batchListCache = null;
  // 按批次的摘要缓存(2026-07-08 主线程瓶颈根治):batchId -> { mtimeMs, size, summary }。
  // 用文件 mtime+size 当版本键——列表重建时对每个批次先 stat(几微秒),没变就复用摘要,
  // 只有真正改过的批次才重读+解析(单个 batch.json 可达 8MB)。保存只失效自己那一个,
  // 别人 105 个不受牵连。这层自失效,不随每次保存清空(那正是旧 5s TTL 缓存失效的病因)。
  const batchSummaryCache = new Map();

  // 摘要缓存落盘(2026-07-28,生产实测:重启后首次列表 2.9s@163 批——冷启动要把
  // 几百 MB 的 batch.json 全解析一遍)。启动时回灌上次的摘要,命中仍逐批按 mtime+size
  // 校验(与内存路径同一套钥匙):文件动过就重解析,**绝无陈旧风险**,冷启动从
  // "解析全量"降为"stat 全量"(百毫秒级)。写盘 debounce+原子落位,失败只记日志不影响服务。
  const SUMMARY_CACHE_FILE = path.join(batchesRoot, '.summary_cache.json');
  // ⚠️ 上面那句「绝无陈旧风险」只对**文件**成立,对**代码**不成立:
  // mtime+size 认得出 batch.json 改没改,认不出 summarizeBatch 的输出结构变没变。
  // 0731 核账 #2 排查出的实际后果:一旦给列表摘要加了新字段,此后没被改写过的批次
  // 会一直命中盘上旧缓存、喂出缺字段的摘要(首页「已完成批次」表空白格),
  // 而且不会自愈——那些批次可能几个月都不会再被写一次。
  //
  // **改动 summarizeBatch 的列表级输出(includeTasks:false 那份)时,把这个数 +1。**
  // 任务级字段不用管:缓存只服务列表路径,详情每次重算。
  const SUMMARY_SCHEMA_VERSION = 1;
  let summaryCachePersistTimer = null;
  function loadPersistedSummaryCache() {
    try {
      const raw = JSON.parse(fs.readFileSync(SUMMARY_CACHE_FILE, 'utf8'));
      if (!raw || raw.v !== 1 || typeof raw.entries !== 'object') return;
      // 结构版本对不上 → 整份丢掉重算。宁可冷启动慢一次,也不能喂缺字段的摘要
      if (raw.schemaVersion !== SUMMARY_SCHEMA_VERSION) return;
      for (const [batchId, entry] of Object.entries(raw.entries)) {
        if (entry && Number.isFinite(entry.mtimeMs) && Number.isFinite(entry.size) && entry.summary) {
          batchSummaryCache.set(batchId, entry);
        }
      }
    } catch { /* 无缓存/坏缓存 → 冷启动老老实实解析,行为同从前 */ }
  }
  function schedulePersistSummaryCache() {
    if (summaryCachePersistTimer) return;
    summaryCachePersistTimer = setTimeout(() => {
      summaryCachePersistTimer = null;
      const payload = JSON.stringify({
        v: 1,
        schemaVersion: SUMMARY_SCHEMA_VERSION,
        entries: Object.fromEntries(batchSummaryCache),
      });
      const tmp = `${SUMMARY_CACHE_FILE}.tmp-${process.pid}`;
      fsPromises.writeFile(tmp, payload)
        .then(() => fsPromises.rename(tmp, SUMMARY_CACHE_FILE))
        .catch((error) => {
          logBatchWriteError('summary_cache_persist_failed', { error: String(error?.message || error) });
          fsPromises.unlink(tmp).catch(() => {});
        });
    }, 2000);
    // 定时器不该拖住进程退出(测试/CLI 场景)
    if (typeof summaryCachePersistTimer.unref === 'function') summaryCachePersistTimer.unref();
  }
  loadPersistedSummaryCache();

  function batchDir(batchId) {
    return path.join(batchesRoot, batchId);
  }

  function batchJsonPath(batchId) {
    return path.join(batchDir(batchId), 'batch.json');
  }

  function hasBatch(batchId) {
    return fs.existsSync(batchJsonPath(batchId));
  }

  async function pathExists(filePath) {
    try {
      await fsPromises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async function hasBatchAsync(batchId) {
    return pathExists(batchJsonPath(batchId));
  }

  function listBatchIds() {
    return fs
      .readdirSync(batchesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && hasBatch(entry.name))
      .map((entry) => entry.name);
  }

  async function listBatchIdsAsync() {
    const entries = await fsPromises.readdir(batchesRoot, { withFileTypes: true });
    const batchIds = [];
    for (const entry of entries) {
      if (entry.isDirectory() && await hasBatchAsync(entry.name)) {
        batchIds.push(entry.name);
      }
    }
    return batchIds;
  }

  function resolveBatchRelativePath(batchId, relativePath) {
    if (!relativePath) {
      return '';
    }

    const root = path.resolve(batchDir(batchId));
    const fullPath = path.resolve(root, relativePath);
    if (fullPath !== root && !fullPath.startsWith(`${root}${path.sep}`)) {
      throw new Error(`Invalid batch path: ${relativePath}`);
    }
    return fullPath;
  }

  function removeFileIfExists(filePath) {
    if (filePath && fs.existsSync(filePath)) {
      fs.rmSync(filePath, { force: true });
    }
  }

  function removeTaskArtifacts(batchId, task) {
    const relativePaths = new Set(
      [
        task?.sourceImagePath,
        task?.rawJsonPath,
        task?.initialRawJsonPath,
        task?.signatureRegionPath,
        task?.finalSignaturePath,
      ].filter(Boolean)
    );

    relativePaths.forEach((relativePath) => {
      removeFileIfExists(resolveBatchRelativePath(batchId, relativePath));
    });
  }

  function removeBatchDirectory(batchId) {
    const dir = batchDir(batchId);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    clearCache();
  }

  // batch.json 是 source of truth。直接覆写是 truncate-then-write,进程在写到一半
  // 被 SIGKILL/OOM/断电会留下半截文件,导致整批无法加载。改为"写临时文件 + 原子
  // rename"(同目录 rename 在 POSIX 上原子,且覆盖已存在文件)。Windows 偶发 EPERM
  // (杀软/占用)时回退到直写,保证保存不会间歇失败——回退路径不劣于改动前的旧行为。
  function tmpWritePath(filePath) {
    return `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  }

  function saveJson(filePath, value) {
    const data = JSON.stringify(value, null, 2);
    const tmpPath = tmpWritePath(filePath);
    try {
      fs.writeFileSync(tmpPath, data, 'utf8');
      fs.renameSync(tmpPath, filePath);
    } catch {
      try {
        fs.rmSync(tmpPath, { force: true });
      } catch {
        /* best-effort cleanup */
      }
      fs.writeFileSync(filePath, data, 'utf8');
    }
  }

  async function saveJsonAsync(filePath, value) {
    const data = JSON.stringify(value, null, 2);
    const tmpPath = tmpWritePath(filePath);
    try {
      await fsPromises.writeFile(tmpPath, data, 'utf8');
      await fsPromises.rename(tmpPath, filePath);
    } catch {
      try {
        await fsPromises.rm(tmpPath, { force: true });
      } catch {
        /* best-effort cleanup */
      }
      await fsPromises.writeFile(filePath, data, 'utf8');
    }
  }

  function getBatchWriteEntries(batchId) {
    return batchWriteQueueEntries.get(batchId) || [];
  }

  function getBatchWriteDepth(batchId) {
    return getBatchWriteEntries(batchId).length;
  }

  function enqueueBatchWrite(batchId, entry) {
    const entries = getBatchWriteEntries(batchId);
    entries.push(entry);
    batchWriteQueueEntries.set(batchId, entries);
    return entries.length;
  }

  function removeBatchWriteEntry(batchId, entry) {
    const entries = getBatchWriteEntries(batchId);
    const nextEntries = entries.filter((item) => item !== entry);
    if (nextEntries.length) {
      batchWriteQueueEntries.set(batchId, nextEntries);
      return;
    }
    batchWriteQueueEntries.delete(batchId);
  }

  function getQueueMetrics(now = Date.now()) {
    const perBatch = Array.from(batchWriteQueueEntries.entries())
      .filter(([, entries]) => entries.length > 0)
      .map(([batchId, entries]) => {
        const oldest = entries[0];
        return {
          batchId,
          depth: entries.length,
          oldestLabel: oldest?.label || 'unknown',
          oldestAgeMs: Math.max(0, now - (oldest?.enqueuedAt || now)),
        };
      })
      .sort((a, b) => b.depth - a.depth || a.batchId.localeCompare(b.batchId));

    return {
      totalQueues: perBatch.length,
      maxDepth: perBatch.reduce((max, item) => Math.max(max, item.depth), 0),
      perBatch,
    };
  }

  function logBatchWriteWarn(message, fields) {
    if (logger && typeof logger.warn === 'function') {
      logger.warn(message, fields);
    }
  }

  function logBatchWriteError(message, fields) {
    if (logger && typeof logger.error === 'function') {
      logger.error(message, fields);
    }
  }

  async function runBatchWriteActionWithTimeout({
    batchId,
    label,
    action,
    timeoutMs,
    enqueuedAt,
  }) {
    let timeoutId = null;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        const waitedMs = Date.now() - enqueuedAt;
        const queueDepth = getBatchWriteDepth(batchId);
        const error = new BatchWriteTimeoutError({
          batchId,
          label,
          waitedMs,
          timeoutMs,
          queueDepth,
        });
        logBatchWriteError('batch_write_timeout', {
          batchId,
          label,
          waitedMs,
          timeoutMs,
          queueDepth,
          err: error,
        });
        reject(error);
      }, timeoutMs);
    });

    try {
      return await Promise.race([
        Promise.resolve().then(action),
        timeoutPromise,
      ]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  function withBatchWrite(batchId, action, options = {}) {
    const label = normalizeBatchWriteLabel(options.label);
    const timeoutMs = normalizePositiveNumber(
      options.timeoutMs,
      DEFAULT_BATCH_WRITE_TIMEOUT_MS
    );
    const acquireWarnMs = normalizeNonNegativeNumber(
      options.acquireWarnMs,
      DEFAULT_BATCH_WRITE_ACQUIRE_WARN_MS
    );
    const enqueuedAt = Date.now();
    const entry = { label, enqueuedAt };
    const previous = batchWriteQueues.get(batchId) || Promise.resolve();
    enqueueBatchWrite(batchId, entry);
    const next = previous
      .catch(() => {})
      .then(() => {
        const waitedMs = Date.now() - enqueuedAt;
        const queueDepth = getBatchWriteDepth(batchId);
        if (waitedMs > acquireWarnMs) {
          logBatchWriteWarn('batch_write_slow_acquire', {
            batchId,
            label,
            waitedMs,
            acquireWarnMs,
            queueDepth,
          });
        }
        return runBatchWriteActionWithTimeout({
          batchId,
          label,
          action,
          timeoutMs,
          enqueuedAt,
        });
      });

    batchWriteQueues.set(batchId, next);
    next.finally(() => {
      removeBatchWriteEntry(batchId, entry);
      if (batchWriteQueues.get(batchId) === next) {
        batchWriteQueues.delete(batchId);
      }
    }).catch(() => {});

    return next;
  }

  function loadBatch(batchId) {
    return normalizeBatch(JSON.parse(fs.readFileSync(batchJsonPath(batchId), 'utf8')));
  }

  async function loadBatchAsync(batchId) {
    return normalizeBatch(JSON.parse(await fsPromises.readFile(batchJsonPath(batchId), 'utf8')));
  }

  /**
   * @deprecated Request-path code should use saveBatchAsync(batch). This sync
   * entrypoint is retained for legacy ops scripts and Sprint C cleanup.
   */
  function saveBatch(batch) {
    return performanceMonitor.measureSync(
      'workbench.batchRepository.saveBatch',
      () => {
        batch.updatedAt = new Date().toISOString();
        saveJson(batchJsonPath(batch.id), batch);
        invalidateBatchSummary(batch.id);

        if (sqliteSyncService && typeof sqliteSyncService.syncBatch === 'function') {
          try {
            sqliteSyncService.syncBatch(batch);
          } catch (error) {
            console.error(`[repository] Failed to sync batch ${batch.id} to SQLite:`, error);
          }
        }
      },
      () => ({ batchId: batch.id })
    );
  }

  async function saveBatchAsync(batch) {
    return performanceMonitor.measure(
      'workbench.batchRepository.saveBatchAsync',
      async () => {
        batch.updatedAt = new Date().toISOString();
        await saveJsonAsync(batchJsonPath(batch.id), batch);
        invalidateBatchSummary(batch.id);

        if (sqliteSyncService && typeof sqliteSyncService.syncBatch === 'function') {
          try {
            await sqliteSyncService.syncBatch(batch);
          } catch (error) {
            console.error(`[repository] Failed to sync batch ${batch.id} to SQLite:`, error);
          }
        }
      },
      () => ({ batchId: batch.id })
    );
  }

  function batchSubdirs(batchId) {
    const root = batchDir(batchId);
    const dirs = {
      root,
      source: path.join(root, 'source'),
      attachments: path.join(root, 'attachments'),
      rawJson: path.join(root, 'raw_json'),
      signatureRegions: path.join(root, 'signature_regions'),
      finalSignatures: path.join(root, 'final_signatures'),
      exports: path.join(root, 'exports'),
    };

    Object.values(dirs).forEach(ensureDir);
    return dirs;
  }

  function toStorageUrl(batchId, relativePath) {
    if (!relativePath) {
      return '';
    }

    const normalized = relativePath
      .split(/[\\/]+/)
      .filter(Boolean)
      .map((part) => encodeURIComponent(part))
      .join('/');

    return `/storage/${encodeURIComponent(batchId)}/${normalized}`;
  }

  function cloneBatchListSummary(summary) {
    return summary && typeof summary === 'object' ? { ...summary } : summary;
  }

  function cloneBatchList(batchList) {
    return batchList.map(cloneBatchListSummary);
  }

  // 保存/删除一个批次后:只丢弃它自己的摘要缓存 + 让列表缓存失效(其他批次的摘要照旧复用)。
  // 这是提速的关键——旧版 saveBatch 调 clearCache() 会把全部 106 个摘要一起清掉,
  // 下次列表被迫全量重解析 700MB JSON。窄失效后,一个人保存只影响他自己那一个批次。
  function invalidateBatchSummary(batchId) {
    if (batchId) {
      batchSummaryCache.delete(batchId);
      schedulePersistSummaryCache();
    }
    batchListCache = null;
  }

  function clearCache() {
    batchListCache = null;
    // "强制全部重读"契约:removeBatchDirectory 依赖它;也留给将来直接改 batch.json 的
    // ops 脚本(当前代码里没有,所有写盘都走 saveBatch/saveBatchAsync 的 mtime 会被自动侦测)。
    batchSummaryCache.clear();
    schedulePersistSummaryCache();
  }

  function summaryCacheHit(entry, stat) {
    return Boolean(entry) && entry.mtimeMs === stat.mtimeMs && entry.size === stat.size;
  }

  // 摘要缓存里删掉已不在磁盘上的批次条目(删批次后的残留),防内存随删建循环慢慢涨。
  // 每次列表都对齐存活集合——n≤几百,全量对齐成本可忽略,比"只在净增长时清"更稳
  // (净零churn:删一个建一个,总数不变但残留条目不会被清 → 这里直接对齐避免)。
  function pruneSummaryCache(currentBatchIds) {
    const alive = new Set(currentBatchIds);
    for (const key of batchSummaryCache.keys()) {
      if (!alive.has(key)) {
        batchSummaryCache.delete(key);
      }
    }
  }

  // 单批次取摘要:优先缓存(mtime+size 命中),否则读盘+解析+汇总并回填。
  // 坏文件(截断/损坏 JSON)只跳过这一个批次并记日志,绝不让整张列表加载失败——
  // 否则一个坏 batch.json 会锁死所有操作员的批次列表。返回 null = 该批次本次不出现在列表。
  function summaryForListSync(batchId) {
    let stat;
    try {
      stat = fs.statSync(batchJsonPath(batchId));
    } catch {
      return null; // 扫描中途 batch.json 消失(并发删除)→ 跳过
    }
    const cached = batchSummaryCache.get(batchId);
    if (summaryCacheHit(cached, stat)) {
      return cached.summary;
    }
    try {
      const summary = summarizeBatch(loadBatch(batchId), { includeTasks: false });
      batchSummaryCache.set(batchId, { mtimeMs: stat.mtimeMs, size: stat.size, summary });
      schedulePersistSummaryCache();
      return summary;
    } catch (error) {
      logBatchWriteError('batch_summary_load_failed', { batchId, error: String(error?.message || error) });
      return null;
    }
  }

  async function summaryForListAsync(batchId) {
    let stat;
    try {
      stat = await fsPromises.stat(batchJsonPath(batchId));
    } catch {
      return null;
    }
    const cached = batchSummaryCache.get(batchId);
    if (summaryCacheHit(cached, stat)) {
      return cached.summary;
    }
    try {
      const summary = summarizeBatch(await loadBatchAsync(batchId), { includeTasks: false });
      batchSummaryCache.set(batchId, { mtimeMs: stat.mtimeMs, size: stat.size, summary });
      schedulePersistSummaryCache();
      return summary;
    } catch (error) {
      logBatchWriteError('batch_summary_load_failed', { batchId, error: String(error?.message || error) });
      return null;
    }
  }

  function listBatches() {
    return performanceMonitor.measureSync(
      'workbench.batchRepository.listBatches',
      () => {
        const now = Date.now();
        if (batchListCache && now - batchListCache.timestamp < BATCH_LIST_CACHE_TTL_MS) {
          return cloneBatchList(batchListCache.data);
        }

        const batchIds = listBatchIds();
        const batches = batchIds
          .map((batchId) => summaryForListSync(batchId))
          .filter(Boolean)
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        pruneSummaryCache(batchIds);

        batchListCache = {
          data: batches,
          timestamp: now,
        };

        return cloneBatchList(batches);
      },
      (batches) => ({ batchCount: batches.length })
    );
  }

  async function listBatchesAsync() {
    return performanceMonitor.measure(
      'workbench.batchRepository.listBatchesAsync',
      async () => {
        const now = Date.now();
        if (batchListCache && now - batchListCache.timestamp < BATCH_LIST_CACHE_TTL_MS) {
          return cloneBatchList(batchListCache.data);
        }

        const batchIds = await listBatchIdsAsync();
        const summaries = await Promise.all(batchIds.map((batchId) => summaryForListAsync(batchId)));
        const batches = summaries
          .filter(Boolean)
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        pruneSummaryCache(batchIds);

        batchListCache = {
          data: batches,
          timestamp: now,
        };

        return cloneBatchList(batches);
      },
      (batches) => ({ batchCount: batches.length })
    );
  }

  function getPendingBatchWrites() {
    return Array.from(batchWriteQueues.values());
  }

  return {
    batchDir,
    batchJsonPath,
    batchSubdirs,
    clearCache,
    getQueueMetrics,
    getPendingBatchWrites,
    hasBatch,
    hasBatchAsync,
    listBatchIds,
    listBatchIdsAsync,
    listBatches,
    listBatchesAsync,
    loadBatch,
    loadBatchAsync,
    removeBatchDirectory,
    removeFileIfExists,
    removeTaskArtifacts,
    resolveBatchRelativePath,
    saveBatch,
    saveBatchAsync,
    saveJson,
    saveJsonAsync,
    toStorageUrl,
    withBatchWrite,
    BatchWriteTimeoutError,
  };
}

module.exports = {
  BatchWriteTimeoutError,
  createWorkbenchBatchRepository,
};
