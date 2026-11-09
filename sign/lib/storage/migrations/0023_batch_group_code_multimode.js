'use strict';

// 0023(2026-07-07 团号多店消歧):同一团号多行是**合法业务数据**——同一个团在新世界、
// 现代各有消费,团号表里就有两行两个模式(实锤病例 70299:新世界SG-振华 不用记 / 现代-JEOCU)。
// 0013 为防重复导入把唯一约束收紧成 UNIQUE(batch_id, tour_no),导入时后行覆盖前行,
// 新世界行被吃掉 → 新世界小票结算命中"现代-JEOCU"错桶。
// 本迁移放宽为「同团号同模式才去重」:唯一性走表达式索引 (batch_id, tour_no, COALESCE(mode,''))
// (mode 可为 NULL,直接进 UNIQUE 约束会因 NULL 互异而失去去重效果)。
module.exports = function migrateBatchGroupCodeMultimode(db) {
  const exists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'batch_group_code'"
  ).get();
  if (!exists) return;

  db.exec(`
    CREATE TABLE IF NOT EXISTS batch_group_code_new (
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
      imported_by TEXT
    );

    INSERT INTO batch_group_code_new (
      id, batch_id, source_workspace_key, tour_no, mode, mode_normalized, agent,
      upstream, passport_no, name, apply_date_raw, apply_date, end_date_raw,
      end_date, shilla_airport, shinsegae_airport, remark, is_placeholder,
      row_hash, source_file, source_sheet, source_row, raw_payload,
      imported_at, imported_by
    )
    SELECT id, batch_id, source_workspace_key, tour_no, mode, mode_normalized, agent,
      upstream, passport_no, name, apply_date_raw, apply_date, end_date_raw,
      end_date, shilla_airport, shinsegae_airport, remark, is_placeholder,
      row_hash, source_file, source_sheet, source_row, raw_payload,
      imported_at, imported_by
    FROM batch_group_code;

    DROP TABLE batch_group_code;
    ALTER TABLE batch_group_code_new RENAME TO batch_group_code;

    CREATE UNIQUE INDEX IF NOT EXISTS uq_batch_group_code_tour_mode
      ON batch_group_code (batch_id, tour_no, COALESCE(mode, ''));
    CREATE INDEX IF NOT EXISTS idx_batch_group_code_batch_tour
      ON batch_group_code (batch_id, tour_no);
    CREATE INDEX IF NOT EXISTS idx_batch_group_code_mode
      ON batch_group_code (batch_id, mode);
    CREATE INDEX IF NOT EXISTS idx_batch_group_code_source_ws
      ON batch_group_code (source_workspace_key, batch_id);
  `);
};
