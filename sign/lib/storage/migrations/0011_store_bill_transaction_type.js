'use strict';

/**
 * 0011_store_bill_transaction_type — G11c (#33)
 *
 * 加 transaction_type 区分销售/退税/退货,避免 bill_match 把退税单错关联到原售单。
 *
 *   sale   — 默认值,日常销售
 *   refund — 退税单 (购物后客户退税)
 *   return — 退货单 (商品退回)
 *
 * import_service 解析 xlsx 时按"退税"/"退货"/"refund"/"return" 关键字识别;
 * bill_match SQL 添加 WHERE transaction_type='sale' 优先级,退税不参与小票匹配。
 *
 * NULL = 历史数据,bill_match 兼容当作 sale。
 */

function getColumnNames(db, table) {
  return db.prepare(`PRAGMA table_info('${table}')`).all().map((row) => row.name);
}

module.exports = function migrate0011(db) {
  const columns = new Set(getColumnNames(db, 'store_bill'));
  if (!columns.has('transaction_type')) {
    db.exec("ALTER TABLE store_bill ADD COLUMN transaction_type TEXT");
  }
  // 索引:bill_match 大量按 (workspace_key, receipt_no, transaction_type) 查
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_store_bill_txn_type
      ON store_bill (workspace_key, transaction_type)
  `);
};
