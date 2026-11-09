'use strict';

module.exports = function migrateBatchGroupCodeUnique(db) {
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
      imported_by TEXT,
      UNIQUE(batch_id, tour_no)
    );

    INSERT OR REPLACE INTO batch_group_code_new (
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
    FROM (
      SELECT *,
        ROW_NUMBER() OVER (
          PARTITION BY batch_id, tour_no
          ORDER BY imported_at DESC, id DESC
        ) AS rn
      FROM batch_group_code
    )
    WHERE rn = 1;

    DROP TABLE batch_group_code;
    ALTER TABLE batch_group_code_new RENAME TO batch_group_code;

    CREATE INDEX IF NOT EXISTS idx_batch_group_code_batch_tour
      ON batch_group_code (batch_id, tour_no);
    CREATE INDEX IF NOT EXISTS idx_batch_group_code_mode
      ON batch_group_code (batch_id, mode);
    CREATE INDEX IF NOT EXISTS idx_batch_group_code_source_ws
      ON batch_group_code (source_workspace_key, batch_id);
  `);
};
