CREATE TABLE IF NOT EXISTS batch_group_code (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL,
  source_workspace_key TEXT,
  tour_no TEXT NOT NULL,
  mode TEXT,
  mode_normalized TEXT,
  agent TEXT,
  upstream TEXT,
  passport_no TEXT,
  name TEXT,
  apply_date_raw TEXT,
  apply_date TEXT,
  end_date_raw TEXT,
  end_date TEXT,
  shilla_airport TEXT,
  shinsegae_airport TEXT,
  remark TEXT,
  is_placeholder INTEGER NOT NULL DEFAULT 0,
  row_hash TEXT NOT NULL,
  source_file TEXT,
  source_sheet TEXT,
  source_row INTEGER,
  raw_payload TEXT,
  imported_at TEXT NOT NULL,
  imported_by TEXT,
  UNIQUE(batch_id, tour_no, row_hash)
);

CREATE INDEX IF NOT EXISTS idx_batch_group_code_batch_tour
  ON batch_group_code (batch_id, tour_no);

CREATE INDEX IF NOT EXISTS idx_batch_group_code_mode
  ON batch_group_code (batch_id, mode);

CREATE INDEX IF NOT EXISTS idx_batch_group_code_source_ws
  ON batch_group_code (source_workspace_key, batch_id);
