'use strict';

module.exports = function addImportJobBucket(db) {
  const cols = db.prepare("PRAGMA table_info('import_job')").all().map((row) => row.name);
  if (!cols.includes('bucket_folder')) {
    db.exec('ALTER TABLE import_job ADD COLUMN bucket_folder TEXT');
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_import_job_bucket
      ON import_job (workspace_key, bucket_folder)
  `);
};
