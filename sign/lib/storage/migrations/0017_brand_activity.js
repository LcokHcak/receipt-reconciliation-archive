'use strict';

/**
 * 0017_brand_activity — 品牌活动(活动数据)独立桶。
 *
 * 业务背景:免税店的"品牌活动数据"是客户的一笔额外促销返点
 *   (键 = 护照 + 品牌 + 购买日,无小票号、无团号,返点 = 纯卖出 × 1.5%)。
 * 它不该进 store_bill 走小票匹配(无小票 → 会被 P4/P5 误匹配污染正常返点),
 * 而是单独存这张表,merge 时作为"额外加项"折进对应交付桶(实测全是乐天首尔)。
 *
 * 不改 monthly_data 表:折入时用 mode_raw='品牌活动' 标记,可审计可区分。
 */

function getColumnNames(db, table) {
  return db.prepare(`PRAGMA table_info('${table}')`).all().map((row) => row.name);
}

module.exports = function migrate0017(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS brand_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_key TEXT NOT NULL,
      passport_no TEXT,
      name TEXT,
      full_name TEXT,
      brand TEXT,
      purchase_date TEXT,
      original_date TEXT,
      store_family TEXT,
      store_branch TEXT,
      mode TEXT,
      mode_normalized TEXT,
      mode_folder TEXT,
      net_usd REAL,
      net_krw REAL,
      points REAL,
      rebate_amount REAL,
      source_file TEXT,
      source_sheet TEXT,
      source_row INTEGER,
      raw_payload TEXT,
      row_hash TEXT NOT NULL,
      imported_at TEXT,
      import_job_id INTEGER,
      imported_by TEXT,
      owner_user_id INTEGER,
      owner_username TEXT
    )
  `);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_brand_activity_dedup
           ON brand_activity(workspace_key, row_hash)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_brand_activity_ws
           ON brand_activity(workspace_key)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_brand_activity_passport
           ON brand_activity(workspace_key, passport_no)`);

  // monthly_data 加一个轻量标记列,方便交付/对账区分品牌活动行(与 mode_raw 双保险)。
  const mdCols = new Set(getColumnNames(db, 'monthly_data'));
  if (!mdCols.has('is_brand_activity')) {
    db.exec('ALTER TABLE monthly_data ADD COLUMN is_brand_activity INTEGER DEFAULT 0');
  }
};
