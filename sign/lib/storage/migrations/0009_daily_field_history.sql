CREATE TABLE IF NOT EXISTS daily_field_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_key TEXT NOT NULL,
  daily_row_id INTEGER NOT NULL,
  field TEXT NOT NULL,
  before_value TEXT,
  after_value TEXT,
  change_source TEXT NOT NULL CHECK (change_source IN ('ocr','manual_edit','bridge_migration','pending_resolution','manual_no_image')),
  actor TEXT NOT NULL,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  conflict_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_daily_field_history_row ON daily_field_history (workspace_key, daily_row_id, ts DESC);

CREATE INDEX IF NOT EXISTS idx_daily_field_history_source ON daily_field_history (workspace_key, change_source, ts DESC);
