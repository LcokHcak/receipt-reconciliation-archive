'use strict';

/**
 * 0029_error_record_source_id — error_record 加行级来源列(L610 收口一族)。
 *
 * 病史:error_record 无行级外键(0001 表只按 receipt_no 存),tour_match 自愈/count 抑制守卫
 * 全按 receipt_no 粗匹配,同票号多行互相误清/误抑制(L610);pending_review 早已有 source_id
 * 精确清,error_record 只是尚未跟上。
 *
 * 加 source_id(=daily_receipt_export.id)+ source_table + 索引。**不回填**:存量 legacy 行
 * source_id 为 NULL,由 repo 的 combined predicate(source_id 精确 OR receipt_no 兜底)兼容,
 * 零回归;彻底追溯回填与跨月迁移幽灵清理留 L614 一族一次性做。
 */

function getColumnNames(db, table) {
  return db.prepare(`PRAGMA table_info('${table}')`).all().map((row) => row.name);
}

module.exports = function migrate0029(db) {
  const columns = new Set(getColumnNames(db, 'error_record'));
  if (!columns.has('source_id')) {
    db.exec('ALTER TABLE error_record ADD COLUMN source_id INTEGER');
  }
  if (!columns.has('source_table')) {
    db.exec("ALTER TABLE error_record ADD COLUMN source_table TEXT DEFAULT 'daily_receipt_export'");
  }
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_error_record_source ON error_record (workspace_key, source_table, source_id)'
  );
};
