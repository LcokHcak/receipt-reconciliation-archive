'use strict';

/**
 * Wrap a stage run with stage_job acquire/finish + progress tracking.
 *   1. Acquires a stage_job row (throws STAGE_ALREADY_RUNNING on conflict)
 *   2. Initializes progress tracker (stage starts)
 *   3. Executes `run()` — the stage service can call tracker.update()
 *   4. Marks stage_job succeeded/failed AND tracker.complete/fail
 *   5. Returns { job, result } on success; rethrows with .job attached
 */

const { tracker: progressTracker } = require('../stage_progress_tracker');

async function runStageWithLock({
  stageJobRepo,
  workspaceKey,
  stage,
  operator = null,
  idempotencyKey = null,
  pipelineLockService = null,
  run,
  afterSuccess = null,
}) {
  if (!stageJobRepo) throw new Error('stageJobRepo required');
  if (!workspaceKey || !stage || typeof run !== 'function') {
    throw new Error('workspaceKey, stage, run required');
  }

  const acquisition = typeof stageJobRepo.createStageJob === 'function'
    ? stageJobRepo.createStageJob({ workspaceKey, stage, operator, idempotencyKey })
    : { reused: false, job: stageJobRepo.acquire({ workspaceKey, stage, operator }) };
  const job = acquisition.job;
  if (acquisition.reused) {
    const result = job.status === 'succeeded' && job.stats
      ? { ...job.stats, reused: true }
      : { reused: true, status: job.status };
    return { job, result, reused: true };
  }
  let pipelineLockAcquired = false;
  try {
    if (pipelineLockService) {
      pipelineLockService.acquirePipelineLock({
        workspaceKey,
        stage,
        jobId: job.id,
        operator,
      });
      pipelineLockAcquired = true;
    }
  } catch (error) {
    stageJobRepo.finish({
      id: job.id,
      status: 'failed',
      errorMessage: error?.message || String(error),
    });
    if (error && typeof error === 'object') error.job = job;
    throw error;
  }
  progressTracker.start({ workspaceKey, stage });
  try {
    const result = await run({ job });
    const finalResult = typeof afterSuccess === 'function'
      ? ((await afterSuccess({ job, result })) || result)
      : result;
    stageJobRepo.finish({
      id: job.id,
      status: 'succeeded',
      stats: finalResult,
    });
    progressTracker.complete({ workspaceKey, stage, stats: finalResult });
    return { job, result: finalResult };
  } catch (error) {
    stageJobRepo.finish({
      id: job.id,
      status: 'failed',
      errorMessage: error?.message || String(error),
    });
    progressTracker.fail({ workspaceKey, stage, error });
    if (error && typeof error === 'object') error.job = job;
    throw error;
  } finally {
    if (pipelineLockAcquired) {
      try {
        pipelineLockService.releasePipelineLock({ workspaceKey });
      } catch {
        // intentional: release is best-effort after stage completion
      }
    }
  }
}

module.exports = { runStageWithLock };
