'use strict';

class PipelineLockedError extends Error {
  constructor({
    workspaceKey,
    runningStage,
    runningSince,
    runningJobId = null,
  }) {
    super(`pipeline_locked: ${workspaceKey} is running ${runningStage}`);
    this.name = 'PipelineLockedError';
    this.code = 'PIPELINE_LOCKED';
    this.statusCode = 423;
    this.workspaceKey = workspaceKey;
    this.runningStage = runningStage;
    this.runningSince = runningSince;
    this.runningJobId = runningJobId;
  }
}

function createPipelineLockService({ db }) {
  if (!db) throw new Error('pipeline_lock_service: db required');
  return {
    acquirePipelineLock: (opts) => acquirePipelineLock({ ...opts, db }),
    releasePipelineLock: (opts) => releasePipelineLock({ ...opts, db }),
    recoverOrphanLocks: () => recoverOrphanLocks(db),
  };
}

function acquirePipelineLock({
  workspaceKey,
  stage,
  jobId = null,
  operator = null,
  db,
}) {
  if (!db) throw new Error('pipeline_lock_service: db required');
  if (!workspaceKey || !stage) throw new Error('workspaceKey and stage required');

  const acquiredAt = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    const inserted = db.prepare(`
      INSERT OR IGNORE INTO pipeline_lock (
        workspace_key, stage, job_id, acquired_at, acquired_by
      ) VALUES (?, ?, ?, ?, ?)
    `).run(workspaceKey, stage, jobId, acquiredAt, operator);

    if (inserted.changes > 0) {
      db.exec('COMMIT');
      return {
        acquired: true,
        workspaceKey,
        stage,
        jobId,
        acquiredAt,
      };
    }

    const row = db.prepare(`
      SELECT stage, job_id, acquired_at
      FROM pipeline_lock
      WHERE workspace_key = ?
    `).get(workspaceKey);
    db.exec('COMMIT');
    throw new PipelineLockedError({
      workspaceKey,
      runningStage: row?.stage || 'unknown',
      runningSince: row?.acquired_at || null,
      runningJobId: row?.job_id ?? null,
    });
  } catch (error) {
    rollbackIfOpen(db);
    throw error;
  }
}

function releasePipelineLock({ workspaceKey, db }) {
  if (!db) throw new Error('pipeline_lock_service: db required');
  if (!workspaceKey) throw new Error('workspaceKey required');
  const result = db.prepare(`
    DELETE FROM pipeline_lock
    WHERE workspace_key = ?
  `).run(workspaceKey);
  if (result.changes > 0) return { released: true };
  return { released: false, reason: 'no_active_lock' };
}

function recoverOrphanLocks(db) {
  if (!db) throw new Error('pipeline_lock_service: db required');
  if (!pipelineLockTableReady(db)) return 0;
  const result = db.prepare('DELETE FROM pipeline_lock').run();
  if (result.changes > 0) {
    process.stderr.write(
      `[pipeline_lock_service] recovered ${result.changes} orphan pipeline_lock rows on boot\n`
    );
  }
  return result.changes;
}

function pipelineLockTableReady(db) {
  const row = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name = 'pipeline_lock'`
  ).get();
  return Boolean(row);
}

function rollbackIfOpen(db) {
  try { db.exec('ROLLBACK'); } catch {
    // intentional: transaction may already be closed
  }
}

module.exports = {
  PipelineLockedError,
  createPipelineLockService,
  acquirePipelineLock,
  releasePipelineLock,
  recoverOrphanLocks,
};
