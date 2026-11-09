'use strict';

function getColumnNames(db, table) {
  return db.prepare(`PRAGMA table_info('${table}')`).all().map((row) => row.name);
}

module.exports = function addStageJobIdempotency(db) {
  const columns = new Set(getColumnNames(db, 'stage_job'));
  if (!columns.has('idempotency_key')) {
    db.exec('ALTER TABLE stage_job ADD COLUMN idempotency_key TEXT');
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_stage_jobs_active_idempotency
      ON stage_job(workspace_key, stage, idempotency_key)
      WHERE idempotency_key IS NOT NULL AND status IN ('running','succeeded')
  `);
};
