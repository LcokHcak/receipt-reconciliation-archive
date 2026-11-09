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

-- Sign Workbench — Sprint 2 schema extensions (Sprint 2, W1)
-- Version: 2.0
-- Date: 2026-05-11
--
-- Applied AFTER monthly_schema.sql. All statements are idempotent:
-- new tables use CREATE TABLE IF NOT EXISTS, and ALTER TABLE ADD COLUMN
-- is guarded by the runtime loader (see lib/storage/monthly_database.js).

-- ============================================================
-- A. 收票汇总 — worker sheets (阶段 0 金标)
-- ============================================================
CREATE TABLE IF NOT EXISTS received_receipt (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_key TEXT NOT NULL,
  worker_name   TEXT,                -- from the Sheet name, e.g. "9号 侯丹妮"
  worker_no     TEXT,                -- parsed from sheet name when possible
  receipt_date  TEXT,                -- 收票日期
  agent         TEXT,
  purchase_date TEXT,
  receipt_no    TEXT,
  tour_no       TEXT,
  name          TEXT,
  passport_no   TEXT,
  departure_date TEXT,
  mode_raw      TEXT,
  mode_normalized TEXT,
  owner         TEXT,                -- 负责人
  shinsegae_airport TEXT,            -- 新世界机场 (14 开头)
  shilla_airport TEXT,               -- 新罗机场 (05 开头)
  source_file   TEXT,
  source_sheet  TEXT,
  source_row    INTEGER,
  raw_payload   TEXT,
  row_hash      TEXT NOT NULL,
  imported_at   TEXT NOT NULL,
  import_job_id INTEGER,
  UNIQUE(workspace_key, row_hash)
);

CREATE INDEX IF NOT EXISTS idx_received_receipt_ws
  ON received_receipt (workspace_key);
CREATE INDEX IF NOT EXISTS idx_received_receipt_receipt
  ON received_receipt (workspace_key, receipt_no);
CREATE INDEX IF NOT EXISTS idx_received_receipt_passport
  ON received_receipt (workspace_key, passport_no);
CREATE INDEX IF NOT EXISTS idx_received_receipt_tour
  ON received_receipt (workspace_key, tour_no);

-- ============================================================
-- B. 每日收票表 — 阶段 1 OCR 审核后的标准 42 列导出
-- ============================================================
CREATE TABLE IF NOT EXISTS daily_receipt_export (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_key TEXT NOT NULL,
  source_customer_id TEXT,            -- bridge back to existing customers.id

  -- 42 规范列 (每日收票表-员工序号.xlsx)
  stmt_date TEXT,            -- 1 日期
  statement_date TEXT,       -- 2 出账日期
  payment_mode TEXT,         -- 3 付款模式
  mode_raw TEXT,             -- 4 返点模式 (原文)
  mode_normalized TEXT,      -- (computed)
  shop TEXT,                 -- 5 免税店
  branch TEXT,               -- 6 免税分店
  upstream TEXT,             -- 7 上家
  entry_company TEXT,        -- 8 入店公司
  tour_guide TEXT,           -- 9 导游
  agent TEXT,                -- 10 代理
  original_date TEXT,        -- 11 原日期
  purchase_date TEXT,        -- 12 购买日期
  tour_no TEXT,              -- 13 团号
  name TEXT,                 -- 14 姓名
  passport_no TEXT,          -- 15 护照号
  departure_date TEXT,       -- 16 出境日期
  receipt_no TEXT,           -- 17 小票号
  original_receipt_no TEXT,  -- 18 原小票号
  category TEXT,             -- 19 分类
  brand TEXT,                -- 20 品牌
  sku TEXT,                  -- 21 SKU
  product_name TEXT,         -- 22 产品名称
  ref_no TEXT,               -- 23 REF NO
  qty INTEGER,               -- 24 数量
  gross_usd REAL,            -- 25 总卖出($)
  gross_krw REAL,            -- 26 总卖出(￦)
  net_usd REAL,              -- 27 纯卖出($)
  net_krw REAL,              -- 28 纯卖出(￦)
  dc_usd REAL,               -- 29 DC($)
  dc_krw REAL,               -- 30 DC(￦)
  discount_rate REAL,        -- 31 折扣率
  voucher_amount REAL,       -- 32 商品券金额
  voucher_deduction REAL,    -- 33 扣点商品券
  customer_points REAL,      -- 34 客人点数
  customer_rebate REAL,      -- 35 客人返点金额
  store_base_points REAL,    -- 36 免税店点数
  store_base_rebate REAL,    -- 37 免税店返点
  store_extra_points REAL,   -- 38 免税店追加点
  store_extra_amount REAL,   -- 39 追加金额
  store_final_rebate REAL,   -- 40 免税店最终返点
  category_secondary TEXT,   -- 41 分类 (TBD-1: merge with 19?)
  remark TEXT,               -- 42 备注

  -- System fields
  bill_match_status TEXT NOT NULL DEFAULT 'unmatched',  -- unmatched/matched/pending_review/manual
  bill_match_priority INTEGER,                          -- 1..6
  mode_folder TEXT,                                     -- 乐天首尔/乐天釜山/爱宝客/济州新罗V团
  tour_match_status TEXT NOT NULL DEFAULT 'pending',    -- pending/matched/agent_mismatch/date_out_of_window
  source_file TEXT,
  source_sheet TEXT,
  source_row INTEGER,
  raw_payload TEXT,
  row_hash TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  import_job_id INTEGER,

  -- === Receipt Ledger 扩展字段 (阶段 1) ===
  -- 用于统一"审核台桥接 + 手动导入 + 手工录入"三条数据源
  receipt_date TEXT,            -- 收票日期 (YYYY-MM-DD)；审核台桥接时 = 审核通过当天
  agent_id INTEGER,             -- 来源员工 users.id；用于分组和审计
  agent_code TEXT,              -- 冗余：员工编号 (如 "9号")，方便收票汇总 sheet 命名
  source_type TEXT DEFAULT 'imported',  -- 'workbench' | 'imported' | 'manual'
  source_batch_id TEXT,         -- 审核批次 ID (source_type=workbench 时)
  source_task_id TEXT,          -- 审核任务 ID (source_type=workbench 时)
  modified_by TEXT,             -- 最后修改人 username

  UNIQUE(workspace_key, row_hash)
);

CREATE INDEX IF NOT EXISTS idx_daily_receipt_ws
  ON daily_receipt_export (workspace_key);
CREATE INDEX IF NOT EXISTS idx_daily_receipt_receipt
  ON daily_receipt_export (workspace_key, receipt_no);
CREATE INDEX IF NOT EXISTS idx_daily_receipt_tour
  ON daily_receipt_export (workspace_key, tour_no);
CREATE INDEX IF NOT EXISTS idx_daily_receipt_passport
  ON daily_receipt_export (workspace_key, passport_no);
CREATE INDEX IF NOT EXISTS idx_daily_receipt_status
  ON daily_receipt_export (workspace_key, bill_match_status);
CREATE INDEX IF NOT EXISTS idx_daily_receipt_mode
  ON daily_receipt_export (workspace_key, mode_folder);
-- Receipt Ledger 索引在 monthly_database.js POST_ALTER_INDEXES 里创建，
-- 因为 receipt_date / agent_id 等列要先用 ALTER TABLE ADD COLUMN 加到旧库

-- ============================================================
-- C. 匹配日志 (阶段 2 核心产出)
-- ============================================================
CREATE TABLE IF NOT EXISTS bill_match_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_key TEXT NOT NULL,
  daily_receipt_id INTEGER,
  store_bill_id    INTEGER,
  match_priority   INTEGER NOT NULL,   -- 1..6
  match_key        TEXT,               -- e.g. 'receipt_no=XXX' or 'passport+date+shop=...'
  match_status     TEXT NOT NULL,      -- matched / pending_review / unmatched / conflict
  conflict_fields  TEXT,               -- JSON: [{field, dailyValue, billValue}, ...]
  matched_at       TEXT NOT NULL,
  confirmed_by     TEXT,
  confirmed_at     TEXT,
  note             TEXT
);

CREATE INDEX IF NOT EXISTS idx_bill_match_log_ws
  ON bill_match_log (workspace_key, match_status);
CREATE INDEX IF NOT EXISTS idx_bill_match_log_daily
  ON bill_match_log (workspace_key, daily_receipt_id);
CREATE INDEX IF NOT EXISTS idx_bill_match_log_bill
  ON bill_match_log (workspace_key, store_bill_id);

-- ============================================================
-- D. 人工确认表 (阶段 2/3 冲突 → 人工)
-- ============================================================
CREATE TABLE IF NOT EXISTS pending_review (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_key TEXT NOT NULL,
  source_table  TEXT NOT NULL,         -- daily_receipt_export / store_bill
  source_id     INTEGER NOT NULL,
  reason_type   TEXT NOT NULL,         -- field_conflict / fuzzy_match / agent_mismatch / manual_decision
  detail        TEXT,                  -- JSON payload
  status        TEXT NOT NULL DEFAULT 'open',   -- open / approved / rejected
  created_at    TEXT NOT NULL,
  resolved_at   TEXT,
  resolved_by   TEXT,
  resolution    TEXT                   -- use_daily / use_bill / custom
);

CREATE INDEX IF NOT EXISTS idx_pending_review_ws
  ON pending_review (workspace_key, status);
CREATE INDEX IF NOT EXISTS idx_pending_review_source
  ON pending_review (workspace_key, source_table, source_id);

-- ============================================================
-- E. 合并后的月度数据 (4 个模式共享单表 + 分区列)
-- ============================================================
CREATE TABLE IF NOT EXISTS monthly_data (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_key TEXT NOT NULL,
  mode_folder   TEXT NOT NULL,        -- 乐天首尔 / 乐天釜山 / 爱宝客 / 济州新罗V团
  is_unmatched  INTEGER NOT NULL DEFAULT 0,  -- 0=正式, 1=未收补齐
  daily_receipt_id INTEGER,
  store_bill_id    INTEGER,

  -- 合并后的 42 列 (字段与 daily_receipt_export 对齐)
  stmt_date TEXT, statement_date TEXT, payment_mode TEXT,
  mode_raw TEXT, mode_normalized TEXT,
  shop TEXT, branch TEXT, upstream TEXT, entry_company TEXT,
  tour_guide TEXT, agent TEXT,
  original_date TEXT, purchase_date TEXT, tour_no TEXT,
  name TEXT, passport_no TEXT, departure_date TEXT,
  receipt_no TEXT, original_receipt_no TEXT,
  category TEXT, brand TEXT, sku TEXT, product_name TEXT,
  ref_no TEXT, qty INTEGER,
  gross_usd REAL, gross_krw REAL, net_usd REAL, net_krw REAL,
  dc_usd REAL, dc_krw REAL, discount_rate REAL,
  voucher_amount REAL, voucher_deduction REAL,
  customer_points REAL, customer_rebate REAL,
  store_base_points REAL, store_base_rebate REAL,
  store_extra_points REAL, store_extra_amount REAL, store_final_rebate REAL,
  category_secondary TEXT, remark TEXT,

  row_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_key, row_hash)
);

CREATE INDEX IF NOT EXISTS idx_monthly_data_ws
  ON monthly_data (workspace_key, mode_folder);
CREATE INDEX IF NOT EXISTS idx_monthly_data_receipt
  ON monthly_data (workspace_key, receipt_no);
CREATE INDEX IF NOT EXISTS idx_monthly_data_passport
  ON monthly_data (workspace_key, passport_no);
CREATE INDEX IF NOT EXISTS idx_monthly_data_unmatched
  ON monthly_data (workspace_key, is_unmatched);

-- ============================================================
-- F. 阶段执行记录 + 并发锁 (Sprint 2 W4)
-- ============================================================
-- stage_job: one row per stage invocation. Acts as an audit trail AND
-- a coarse-grained advisory lock: the service layer refuses to start a
-- new job for the same (workspace_key, stage) pair when an existing row
-- is in status = 'running'.
--
-- Stages: tour_match / bill_match / merge / second_pass / export
CREATE TABLE IF NOT EXISTS stage_job (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_key TEXT NOT NULL,
  stage         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'running',   -- running/succeeded/failed/cancelled
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  operator      TEXT,
  error_message TEXT,
  stats         TEXT                                -- JSON returned by the stage
);

CREATE INDEX IF NOT EXISTS idx_stage_job_ws
  ON stage_job (workspace_key, stage, status);
CREATE INDEX IF NOT EXISTS idx_stage_job_started
  ON stage_job (workspace_key, started_at DESC);

-- ============================================================
-- G. Badcase 现场快照 (内部反馈闭环, A1)
-- ============================================================
-- match_badcase: 每次 tour_match / bill_match 决策后落一条现场快照，
-- 用于事后排查"为什么这条没匹配上 / 为什么匹配错了"。
-- 不替代 bill_match_log（那张是日志），这张是 **故障现场**：保留输入、
-- 候选、走的规则、规则版本号，让运营/开发不用翻日志就能复盘。
--
-- 写入触发：
--   - tour_match: 任何非 'matched' 的 daily 行
--   - bill_match: 任何非 'matched' 的 store_bill 行（unmatched/ambiguous/fuzzy/conflict）
--   - 也可以由运营在 UI 上手动标记一条 daily/bill 为 badcase（kind='manual'）
CREATE TABLE IF NOT EXISTS match_badcase (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_key   TEXT NOT NULL,
  stage           TEXT NOT NULL,                  -- tour_match / bill_match / second_pass / manual
  kind            TEXT NOT NULL,                  -- tour_not_found / agent_mismatch / mode_unresolved
                                                  -- ambiguous_match / fuzzy_match / field_conflict
                                                  -- unmatched / manual
  rule_version    TEXT,                           -- 代码常量 RULE_VERSION (A3)
  source_table    TEXT,                           -- daily_receipt_export / store_bill
  source_id       INTEGER,
  daily_receipt_id INTEGER,
  store_bill_id    INTEGER,
  -- 关键查询字段，便于在 UI 上 grep
  receipt_no      TEXT,
  tour_no         TEXT,
  passport_no     TEXT,
  name            TEXT,
  purchase_date   TEXT,
  -- 现场快照
  snapshot        TEXT NOT NULL,                  -- JSON: { input, normalized, candidates, decision, reason }
  -- 运营反馈（A2）
  user_note       TEXT,
  user_verdict    TEXT,                           -- pending / wrong_match / should_match / acceptable
  reviewed_by     TEXT,
  reviewed_at     TEXT,
  created_at      TEXT NOT NULL,
  stage_job_id    INTEGER                         -- 关联当时 stage_jobs 行，串起规则版本
);

CREATE INDEX IF NOT EXISTS idx_match_badcase_ws
  ON match_badcase (workspace_key, stage, kind);
CREATE INDEX IF NOT EXISTS idx_match_badcase_receipt
  ON match_badcase (workspace_key, receipt_no);
CREATE INDEX IF NOT EXISTS idx_match_badcase_tour
  ON match_badcase (workspace_key, tour_no);
CREATE INDEX IF NOT EXISTS idx_match_badcase_verdict
  ON match_badcase (workspace_key, user_verdict, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_match_badcase_rule_version
  ON match_badcase (workspace_key, rule_version, stage);


