'use strict';

/**
 * 0010_audit_log_seq — Add seq column to audit_log so same-second writes
 * from different requests never collide on the UNIQUE constraint.
 *
 * SQLite cannot ALTER a UNIQUE constraint, so we rebuild the table.
 * Existing rows are copied with seq=0 (no conflicts expected in practice).
 */

module.exports = function migrate0010(db) {
  const tableExists = Boolean(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_log'").get()
  );

  // Create new table with seq column and updated UNIQUE constraint
  db.exec(`
    CREATE TABLE audit_log_v0010 (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      seq        INTEGER NOT NULL DEFAULT 0,
      workspace_key TEXT,
      user_id    TEXT NOT NULL,
      action     TEXT NOT NULL,
      resource_type TEXT,
      resource_id TEXT,
      details    TEXT,
      ip_address TEXT,
      user_agent TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(workspace_key, user_id, action, resource_id, created_at, seq)
    )
  `);

  if (tableExists) {
    // Migrate existing rows (all get seq=0)
    db.exec(`
      INSERT OR IGNORE INTO audit_log_v0010
        (id, seq, workspace_key, user_id, action, resource_type, resource_id,
         details, ip_address, user_agent, created_at)
      SELECT id, 0, workspace_key, user_id, action, resource_type, resource_id,
             details, ip_address, user_agent, created_at
      FROM audit_log
    `);
    db.exec('DROP TABLE audit_log');
  }

  db.exec('ALTER TABLE audit_log_v0010 RENAME TO audit_log');

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_audit_log_workspace_time ON audit_log(workspace_key, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_log_user_time ON audit_log(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_log_action_time ON audit_log(action, created_at DESC);
  `);
};
