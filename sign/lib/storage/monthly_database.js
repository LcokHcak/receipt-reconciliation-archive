'use strict';

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { ensureDir } = require('../workbench_utils');
const { runMigrations } = require('./migration_runner');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/**
 * Open (or create) the monthly-pipeline SQLite DB and apply all versioned
 * schema migrations before running crash recovery.
 *
 * @param {{ dbPath: string }} opts
 * @returns {DatabaseSync}
 */
function openMonthlyDatabase({ dbPath }) {
  if (!dbPath) throw new Error('dbPath is required');
  ensureDir(path.dirname(dbPath));
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  runMigrations(db, MIGRATIONS_DIR);
  recoverOrphanStageJobs(db);
  recoverOrphanLocks(db);
  return db;
}

/**
 * Crash recovery: any stage_job left in status='running' from a prior
 * process must be cancelled at boot, otherwise the advisory-lock acquire
 * will return STAGE_ALREADY_RUNNING forever and the operator can never
 * kick off a new pipeline run.
 *
 * Fired once per process startup. Idempotent: if everything was already
 * finished cleanly the UPDATE matches zero rows.
 */
function recoverOrphanStageJobs(db) {
  if (!stageJobTableReady(db)) return;
  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE stage_job
    SET status = 'cancelled',
        finished_at = ?,
        error_message = COALESCE(error_message, 'recovered_from_crash_on_boot')
    WHERE status = 'running'
  `).run(now);
  if (result.changes > 0) {
    process.stderr.write(
      `[monthly_database] recovered ${result.changes} orphan stage_job rows on boot\n`
    );
  }
}

function stageJobTableReady(db) {
  const row = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name = 'stage_job'`
  ).get();
  return Boolean(row);
}

/**
 * Crash recovery for advisory pipeline locks: any pipeline_lock row left over
 * from a prior process holds the workspace hostage (acquire returns
 * PIPELINE_LOCKED forever), so clear them all at boot.
 *
 * Sibling of recoverOrphanStageJobs — pure DB crash-recovery owned by the
 * monthly DB opener. Idempotent: matches zero rows when nothing is stale.
 * (The same SQL is also exposed via services/monthly/pipeline_lock_service
 * for the request-time PipelineLockService; both are intentionally tiny.)
 */
function recoverOrphanLocks(db) {
  if (!pipelineLockTableReady(db)) return 0;
  const result = db.prepare('DELETE FROM pipeline_lock').run();
  if (result.changes > 0) {
    process.stderr.write(
      `[monthly_database] recovered ${result.changes} orphan pipeline_lock rows on boot\n`
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

module.exports = {
  openMonthlyDatabase,
  MIGRATIONS_DIR,
};
