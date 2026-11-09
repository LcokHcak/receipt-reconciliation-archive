CREATE TABLE IF NOT EXISTS pipeline_lock (
  workspace_key TEXT PRIMARY KEY,
  stage         TEXT NOT NULL,
  job_id        INTEGER,
  acquired_at   TEXT NOT NULL,
  acquired_by   TEXT
);

CREATE INDEX IF NOT EXISTS idx_pipeline_lock_acquired
  ON pipeline_lock(acquired_at);
