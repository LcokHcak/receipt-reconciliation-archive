-- Sign Workbench — Monthly Pipeline schema (Sprint 1, W1)
-- Version: 1.0
-- Date: 2026-05-10
-- Coexists with lib/storage/schema.sql (legacy) and
-- passport_review_workbench/storage inline schema. Creates 6 new tables
-- under the workspace_key isolation pattern. Safe to re-run.

CREATE TABLE IF NOT EXISTS monthly_workspace (
  workspace_key TEXT PRIMARY KEY,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  locked_at TEXT,
  locked_by TEXT,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_monthly_workspace_status
  ON monthly_workspace (status);

CREATE TABLE IF NOT EXISTS group_code (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_key TEXT NOT NULL,
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
  imported_at TEXT NOT NULL,
  import_job_id INTEGER,
  UNIQUE(workspace_key, tour_no, row_hash)
);

CREATE INDEX IF NOT EXISTS idx_group_code_workspace
  ON group_code (workspace_key, tour_no);
CREATE INDEX IF NOT EXISTS idx_group_code_agent
  ON group_code (workspace_key, agent);
CREATE INDEX IF NOT EXISTS idx_group_code_passport
  ON group_code (workspace_key, passport_no);
CREATE INDEX IF NOT EXISTS idx_group_code_mode
  ON group_code (mode);

CREATE TABLE IF NOT EXISTS store_bill (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_key TEXT NOT NULL,
  store_family TEXT,
  store_branch TEXT,
  mode TEXT,
  mode_normalized TEXT,
  tour_no TEXT,
  purchase_date TEXT,
  original_date TEXT,
  departure_date TEXT,
  name TEXT,
  full_name TEXT,
  passport_no TEXT,
  receipt_no TEXT,
  original_receipt_no TEXT,
  brand TEXT,
  sku TEXT,
  ref_no TEXT,
  category TEXT,
  qty INTEGER,
  gross_usd REAL,
  gross_krw REAL,
  net_usd REAL,
  net_krw REAL,
  points REAL,
  rebate_amount REAL,
  source_file TEXT,
  source_sheet TEXT,
  source_row INTEGER,
  is_detail_sheet INTEGER NOT NULL DEFAULT 1,
  raw_payload TEXT,
  row_hash TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  import_job_id INTEGER,
  UNIQUE(workspace_key, row_hash)
);

CREATE INDEX IF NOT EXISTS idx_store_bill_workspace
  ON store_bill (workspace_key, store_family);
CREATE INDEX IF NOT EXISTS idx_store_bill_receipt
  ON store_bill (workspace_key, receipt_no);
CREATE INDEX IF NOT EXISTS idx_store_bill_passport
  ON store_bill (workspace_key, passport_no);
CREATE INDEX IF NOT EXISTS idx_store_bill_tour
  ON store_bill (workspace_key, tour_no);

CREATE TABLE IF NOT EXISTS missing_receipt (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_key TEXT NOT NULL,
  mode TEXT,
  mode_normalized TEXT,
  tour_no TEXT,
  purchase_date TEXT,
  name TEXT,
  full_name TEXT,
  passport_no TEXT,
  receipt_no TEXT,
  brand TEXT,
  net_usd REAL,
  agent TEXT,
  owner TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  source_file TEXT,
  source_sheet TEXT,
  raw_payload TEXT,
  row_hash TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  import_job_id INTEGER,
  UNIQUE(workspace_key, row_hash)
);

CREATE INDEX IF NOT EXISTS idx_missing_receipt_ws
  ON missing_receipt (workspace_key, status);
CREATE INDEX IF NOT EXISTS idx_missing_receipt_receipt
  ON missing_receipt (workspace_key, receipt_no);

CREATE TABLE IF NOT EXISTS error_record (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_key TEXT NOT NULL,
  error_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'high',
  store_family TEXT,
  mode TEXT,
  tour_no TEXT,
  receipt_no TEXT,
  passport_no TEXT,
  name TEXT,
  expected_value TEXT,
  actual_value TEXT,
  owner TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  detected_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,
  resolution_note TEXT,
  raw_payload TEXT
);

CREATE INDEX IF NOT EXISTS idx_error_record_ws
  ON error_record (workspace_key, error_type, status);

CREATE TABLE IF NOT EXISTS import_job (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_key TEXT NOT NULL,
  job_type TEXT NOT NULL,
  source_file TEXT NOT NULL,
  file_size INTEGER,
  sha256 TEXT,
  status TEXT NOT NULL,
  rows_total INTEGER NOT NULL DEFAULT 0,
  rows_inserted INTEGER NOT NULL DEFAULT 0,
  rows_skipped INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error_message TEXT,
  operator TEXT,
  details TEXT
);

CREATE INDEX IF NOT EXISTS idx_import_job_ws
  ON import_job (workspace_key, job_type, started_at);

-- Departure-date sync audit (per 1.3.2: cross-purchase departure sync must
-- keep a change trail). One row per rewrite; preserves before/after/trigger.
CREATE TABLE IF NOT EXISTS departure_sync_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_key TEXT NOT NULL,
  store_bill_id INTEGER NOT NULL,
  passport_no TEXT,
  name TEXT,
  receipt_no TEXT,
  before_value TEXT,
  after_value TEXT,
  triggered_by TEXT,                    -- 'cross_check_service' / operator
  triggered_at TEXT NOT NULL,
  error_record_id INTEGER               -- back-link to the CC_DEPARTURE_SYNC row if any
);

CREATE INDEX IF NOT EXISTS idx_departure_sync_audit_ws
  ON departure_sync_audit (workspace_key, triggered_at);
CREATE INDEX IF NOT EXISTS idx_departure_sync_audit_passport
  ON departure_sync_audit (workspace_key, passport_no);
