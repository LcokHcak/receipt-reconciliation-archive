ALTER TABLE pending_review ADD COLUMN conflict_fingerprint TEXT;

CREATE INDEX IF NOT EXISTS idx_pending_review_fp
  ON pending_review(workspace_key, conflict_fingerprint);
