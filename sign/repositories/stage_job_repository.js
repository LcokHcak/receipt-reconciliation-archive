'use strict';

/**
 * stage_job repository — audit + coarse-grained advisory lock for stage
 * runs on a workspace. Any caller wanting to kick off tour-match /
 * bill-match / merge / second-pass / export first acquires a row here
 * with status = 'running'; finishing marks it 'succeeded' / 'failed'.
 *
 * Acquisition uses a single INSERT guarded by a SELECT-for-existence
 * inside one transaction. SQLite runs each transaction serialized, so
 * two concurrent acquires on the same (workspaceKey, stage) pair can
 * never both see an empty running row — exactly one will succeed.
 */

function createStageJobRepository({ db }) {
  if (!db) throw new Error('db is required');

  const insertStmt = db.prepare(`
    INSERT INTO stage_job (workspace_key, stage, status, started_at, operator, idempotency_key)
    VALUES (?, ?, 'running', ?, ?, ?)
  `);
  const findRunningStmt = db.prepare(`
    SELECT * FROM stage_job
    WHERE workspace_key = ? AND stage = ? AND status = 'running'
    ORDER BY id DESC
    LIMIT 1
  `);
  const findByIdStmt = db.prepare(`SELECT * FROM stage_job WHERE id = ?`);
  const findActiveByIdempotencyKeyStmt = db.prepare(`
    SELECT * FROM stage_job
    WHERE workspace_key = ?
      AND stage = ?
      AND idempotency_key = ?
      AND status IN ('running', 'succeeded')
    ORDER BY id DESC
    LIMIT 1
  `);
  const finishStmt = db.prepare(`
    UPDATE stage_job
    SET status = ?, finished_at = ?, error_message = ?, stats = ?
    WHERE id = ?
  `);
  const listRecentStmt = db.prepare(`
    SELECT * FROM stage_job
    WHERE workspace_key = ?
      AND (? IS NULL OR stage = ?)
      AND (? IS NULL OR status = ?)
    ORDER BY id DESC
    LIMIT ?
  `);
  const cancelStaleStmt = db.prepare(`
    UPDATE stage_job
    SET status = 'cancelled', finished_at = ?, error_message = ?
    WHERE workspace_key = ? AND stage = ? AND status = 'running' AND id <> ?
  `);

  function mapRow(r) {
    if (!r) return null;
    let stats = null;
    if (r.stats) {
      try { stats = JSON.parse(r.stats); } catch { stats = null; }
    }
    return {
      id: r.id,
      workspaceKey: r.workspace_key,
      stage: r.stage,
      status: r.status,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      operator: r.operator,
      errorMessage: r.error_message,
      idempotencyKey: r.idempotency_key || null,
      stats,
    };
  }

  return {
    /**
     * Try to acquire a lock for (workspaceKey, stage). Returns the new
     * job row on success; throws `StageAlreadyRunningError` if another
     * row is already running.
     */
    acquire({ workspaceKey, stage, operator = null, startedAt = null, idempotencyKey = null }) {
      return this.createStageJob({
        workspaceKey,
        stage,
        operator,
        startedAt,
        idempotencyKey,
      }).job;
    },

    /**
     * Create a stage job, or reuse an existing active/succeeded job with
     * the same client-provided idempotencyKey. Clients can pass this key
     * to make repeated button clicks return the same job instead of
     * starting duplicate work.
     */
    createStageJob({ workspaceKey, stage, operator = null, startedAt = null, idempotencyKey = null }) {
      if (!workspaceKey || !stage) throw new Error('workspaceKey and stage required');
      const started = startedAt || new Date().toISOString();
      const key = normalizeIdempotencyKey(idempotencyKey);
      db.exec('BEGIN IMMEDIATE');
      try {
        if (key) {
          const existing = findActiveByIdempotencyKeyStmt.get(workspaceKey, stage, key);
          if (existing) {
            db.exec('COMMIT');
            return { reused: true, job: mapRow(existing) };
          }
        }
        const running = findRunningStmt.get(workspaceKey, stage);
        if (running) {
          db.exec('ROLLBACK');
          const err = new Error(
            `stage_already_running: ${stage} on ${workspaceKey} (job=${running.id})`
          );
          err.code = 'STAGE_ALREADY_RUNNING';
          err.running = mapRow(running);
          throw err;
        }
        const result = insertStmt.run(workspaceKey, stage, started, operator, key);
        db.exec('COMMIT');
        return { reused: false, job: mapRow(findByIdStmt.get(result.lastInsertRowid)) };
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* ignore */ }
        throw error;
      }
    },

    finish({ id, status, stats = null, errorMessage = null, finishedAt = null }) {
      if (!id) throw new Error('id required');
      return finishStmt.run(
        status,
        finishedAt || new Date().toISOString(),
        errorMessage,
        stats ? JSON.stringify(stats) : null,
        Number(id)
      ).changes;
    },

    findRunning({ workspaceKey, stage }) {
      return mapRow(findRunningStmt.get(workspaceKey, stage));
    },

    findById({ id }) {
      return mapRow(findByIdStmt.get(Number(id)));
    },

    findActiveByIdempotencyKey({ workspaceKey, stage, idempotencyKey }) {
      const key = normalizeIdempotencyKey(idempotencyKey);
      if (!workspaceKey || !stage || !key) return null;
      return mapRow(findActiveByIdempotencyKeyStmt.get(workspaceKey, stage, key));
    },

    listRecent({ workspaceKey, stage = null, status = null, limit = 50 }) {
      return listRecentStmt.all(
        workspaceKey,
        stage, stage,
        status, status,
        Number(limit)
      ).map(mapRow);
    },

    /**
     * Force-clear stuck running rows for a stage (in case a server
     * crash left them orphaned). Preserves the caller's own row.
     */
    cancelStaleRunners({ workspaceKey, stage, keepId, reason = 'cancelled_by_new_run' }) {
      return cancelStaleStmt.run(
        new Date().toISOString(),
        reason,
        workspaceKey, stage, Number(keepId)
      ).changes;
    },
  };
}

function normalizeIdempotencyKey(value) {
  const text = String(value || '').trim();
  return text || null;
}

module.exports = { createStageJobRepository };
