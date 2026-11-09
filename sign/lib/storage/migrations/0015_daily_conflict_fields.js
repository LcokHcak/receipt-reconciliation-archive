'use strict';

module.exports = function addDailyConflictFields(db) {
  const cols = db.prepare("PRAGMA table_info('daily_receipt_export')").all().map((row) => row.name);
  if (!cols.includes('conflict_fields')) {
    db.exec('ALTER TABLE daily_receipt_export ADD COLUMN conflict_fields TEXT');
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_daily_receipt_conflict_fields
      ON daily_receipt_export(workspace_key, bill_match_status)
      WHERE conflict_fields IS NOT NULL
  `);
};
