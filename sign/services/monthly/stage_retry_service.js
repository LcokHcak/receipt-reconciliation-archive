'use strict';

/**
 * stage_retry_service — 阶段失败自动重试机制（Sprint 2 W4）。
 *
 * 功能：
 *   - 监控 stage_job 表中 status = 'failed' 的记录
 *   - 根据重试策略自动重新执行失败的阶段
 *   - 支持指数退避（exponential backoff）
 *   - 记录重试历史到 stage_job_retry 表
 *
 * 重试策略：
 *   - 最大重试次数：3 次
 *   - 退避间隔：1min, 5min, 15min
 *   - 可配置的重试条件（某些错误类型不重试）
 *
 * Schema (stage_job_retry):
 *   id INTEGER PRIMARY KEY
 *   stage_job_id INTEGER (关联 stage_job.id)
 *   workspace_key TEXT
 *   stage TEXT
 *   retry_count INTEGER (第几次重试，1-based)
 *   triggered_at TEXT (ISO 8601)
 *   result TEXT ('succeeded' | 'failed')
 *   error_message TEXT
 *   finished_at TEXT
 *
 * 使用方式：
 *   const retryService = createStageRetryService({ stageJobRepo, ... });
 *   setInterval(() => retryService.checkAndRetry(), 60_000); // 每分钟检查一次
 */

const RETRY_CONFIG = {
  maxRetries: 3,
  backoffMinutes: [1, 5, 15], // 第 1/2/3 次重试的延迟（分钟）
  nonRetryableErrors: [
    'STAGE_ALREADY_RUNNING',
    'WORKSPACE_NOT_FOUND',
    'INVALID_INPUT',
  ],
};

function createStageRetryService({
  stageJobRepo,
  tourMatchService,
  billMatchService,
  mergeService,
  secondPassMissingService,
  pipelineLockService = null,
  db,
}) {
  if (!stageJobRepo || !db) {
    throw new Error('stage_retry_service: stageJobRepo and db required');
  }

  // 创建重试历史表
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS stage_job_retry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stage_job_id INTEGER NOT NULL,
      workspace_key TEXT NOT NULL,
      stage TEXT NOT NULL,
      retry_count INTEGER NOT NULL,
      triggered_at TEXT NOT NULL,
      result TEXT,
      error_message TEXT,
      finished_at TEXT,
      FOREIGN KEY (stage_job_id) REFERENCES stage_job(id)
    );
    CREATE INDEX IF NOT EXISTS idx_stage_job_retry_job ON stage_job_retry(stage_job_id);
    CREATE INDEX IF NOT EXISTS idx_stage_job_retry_workspace_stage ON stage_job_retry(workspace_key, stage);
  `;
  db.exec(createTableSQL);

  const insertRetryStmt = db.prepare(`
    INSERT INTO stage_job_retry (
      stage_job_id, workspace_key, stage, retry_count, triggered_at, result, error_message, finished_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const countRetriesStmt = db.prepare(`
    SELECT COUNT(*) as count FROM stage_job_retry WHERE stage_job_id = ?
  `);

  function getRetryCount(stageJobId) {
    const row = countRetriesStmt.get(stageJobId);
    return row ? row.count : 0;
  }

  function recordRetry({ stageJobId, workspaceKey, stage, retryCount, result, errorMessage = null }) {
    const now = new Date().toISOString();
    insertRetryStmt.run(
      stageJobId,
      workspaceKey,
      stage,
      retryCount,
      now,
      result,
      errorMessage,
      now
    );
  }

  function isRetryable(errorMessage) {
    if (!errorMessage) return true;
    return !RETRY_CONFIG.nonRetryableErrors.some((pattern) => errorMessage.includes(pattern));
  }

  function shouldRetry(job) {
    if (job.status !== 'failed') return false;
    if (!isRetryable(job.errorMessage)) return false;

    const retryCount = getRetryCount(job.id);
    if (retryCount >= RETRY_CONFIG.maxRetries) return false;

    // 检查是否已过退避时间
    const backoffMinutes = RETRY_CONFIG.backoffMinutes[retryCount] || RETRY_CONFIG.backoffMinutes[RETRY_CONFIG.backoffMinutes.length - 1];
    const failedAt = new Date(job.finishedAt);
    const now = new Date();
    const elapsedMinutes = (now - failedAt) / 60000;

    return elapsedMinutes >= backoffMinutes;
  }

  async function retryJob(job) {
    const retryCount = getRetryCount(job.id) + 1;
    console.log(`[stage_retry] Retrying job ${job.id} (${job.stage}) attempt ${retryCount}/${RETRY_CONFIG.maxRetries}`);

    const serviceMap = {
      tour_match: tourMatchService,
      bill_match: billMatchService,
      merge: mergeService,
      second_pass: secondPassMissingService,
    };

    const service = serviceMap[job.stage];
    if (!service) {
      console.error(`[stage_retry] No service found for stage ${job.stage}`);
      return;
    }

    let pipelineLockAcquired = false;
    try {
      if (pipelineLockService) {
        pipelineLockService.acquirePipelineLock({
          workspaceKey: job.workspaceKey,
          stage: job.stage,
          jobId: job.id,
          operator: 'stage_retry',
        });
        pipelineLockAcquired = true;
      }

      const result = await service.run({ workspaceKey: job.workspaceKey });

      // 更新原 stage_job 为成功
      stageJobRepo.finish({
        id: job.id,
        status: 'succeeded',
        stats: result,
      });

      recordRetry({
        stageJobId: job.id,
        workspaceKey: job.workspaceKey,
        stage: job.stage,
        retryCount,
        result: 'succeeded',
      });

      console.log(`[stage_retry] Job ${job.id} retry succeeded`);
    } catch (error) {
      const errorMessage = error?.code === 'PIPELINE_LOCKED'
        ? `pipeline_locked: ${error?.message || String(error)}`
        : (error?.message || String(error));

      // 更新原 stage_job 错误信息
      stageJobRepo.finish({
        id: job.id,
        status: 'failed',
        errorMessage: `Retry ${retryCount} failed: ${errorMessage}`,
      });

      recordRetry({
        stageJobId: job.id,
        workspaceKey: job.workspaceKey,
        stage: job.stage,
        retryCount,
        result: 'failed',
        errorMessage,
      });

      console.error(`[stage_retry] Job ${job.id} retry ${retryCount} failed:`, errorMessage);
    } finally {
      if (pipelineLockAcquired) {
        try {
          pipelineLockService.releasePipelineLock({ workspaceKey: job.workspaceKey });
        } catch {
          // intentional: retry completion must not be masked by release cleanup
        }
      }
    }
  }

  async function checkAndRetry() {
    try {
      // 查询所有失败的 stage_job（最近 24 小时内）
      const oneDayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const failedJobs = db.prepare(`
        SELECT
          id,
          workspace_key AS workspaceKey,
          stage,
          status,
          started_at AS startedAt,
          finished_at AS finishedAt,
          operator,
          error_message AS errorMessage,
          stats
        FROM stage_job
        WHERE status = 'failed'
          AND finished_at >= ?
        ORDER BY finished_at ASC
      `).all(oneDayAgo);

      for (const job of failedJobs) {
        if (shouldRetry(job)) {
          await retryJob(job);
        }
      }
    } catch (error) {
      console.error('[stage_retry] checkAndRetry failed:', error);
    }
  }

  function getRetryHistory({ workspaceKey = null, stage = null, limit = 100, offset = 0 }) {
    const conditions = [];
    const params = [];

    if (workspaceKey) {
      conditions.push('workspace_key = ?');
      params.push(workspaceKey);
    }
    if (stage) {
      conditions.push('stage = ?');
      params.push(stage);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `
      SELECT * FROM stage_job_retry
      ${where}
      ORDER BY triggered_at DESC
      LIMIT ? OFFSET ?
    `;
    params.push(limit, offset);

    return db.prepare(sql).all(...params);
  }

  return { checkAndRetry, getRetryHistory, shouldRetry, getRetryCount };
}

module.exports = { createStageRetryService, RETRY_CONFIG };
