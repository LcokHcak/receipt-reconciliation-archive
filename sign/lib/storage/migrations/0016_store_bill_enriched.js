'use strict';

/**
 * 0016_store_bill_enriched — G19 改造 D
 *
 * 账单匹配规则 docx —【补全字段】:用台账信息补全{清洗前}的账单数据,
 * 补全同一客户同一小票号下的全部客户信息。
 *
 * 加两列做审计追踪(只记补全动作,不改业务语义):
 *   enriched_at            — 该行最近一次被字段补全的时间戳 (ISO)
 *   enriched_from_daily_id — 补全来源的台账 daily_receipt_export.id
 *
 * NULL = 从未被补全 / 历史数据。
 */

function getColumnNames(db, table) {
  return db.prepare(`PRAGMA table_info('${table}')`).all().map((row) => row.name);
}

module.exports = function migrate0016(db) {
  const columns = new Set(getColumnNames(db, 'store_bill'));
  if (!columns.has('enriched_at')) {
    db.exec('ALTER TABLE store_bill ADD COLUMN enriched_at TEXT');
  }
  if (!columns.has('enriched_from_daily_id')) {
    db.exec('ALTER TABLE store_bill ADD COLUMN enriched_from_daily_id INTEGER');
  }
};
