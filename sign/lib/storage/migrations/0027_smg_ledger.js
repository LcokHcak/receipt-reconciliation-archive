'use strict';

/**
 * 0027_smg_ledger — 上家《SMG总账》导入(2026-07-21 拍板:只做未收对账)。
 *
 *   statement_date — 出账日期(总账「卖出明细」列2,MM/DD 补账期年份归一 ISO)。
 *     未收行/未收清单.xlsx 展示用;历史 store_bill 行 NULL = 该来源没有此列。
 *
 *   idx_store_bill_import_job — 替换语义(滚动全量,导入前清本工作区旧总账行)
 *     按 import_job_id 删 28万+ 行,无索引会全表扫。
 */

function getColumnNames(db, table) {
  return db.prepare(`PRAGMA table_info('${table}')`).all().map((row) => row.name);
}

module.exports = function migrate0027(db) {
  const columns = new Set(getColumnNames(db, 'store_bill'));
  if (!columns.has('statement_date')) {
    db.exec('ALTER TABLE store_bill ADD COLUMN statement_date TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_store_bill_import_job ON store_bill (import_job_id)');
};
