'use strict';

function getColumnNames(db, table) {
  return db.prepare(`PRAGMA table_info('${table}')`).all().map((row) => row.name);
}

function tableExists(db, table) {
  return Boolean(
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table)
  );
}

function addMissingColumns(db, table, additions) {
  if (!tableExists(db, table)) return;
  const existing = new Set(getColumnNames(db, table));
  for (const [column, sqlType] of additions) {
    if (!existing.has(column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${sqlType}`);
      existing.add(column);
    }
  }
}

module.exports = function addReceiptLedgerColumns(db) {
  addMissingColumns(db, 'store_bill', [
    ['statement_date', 'TEXT'],
    ['payment_mode', 'TEXT'],
    ['upstream', 'TEXT'],
    ['entry_company', 'TEXT'],
    ['tour_guide', 'TEXT'],
    ['agent', 'TEXT'],
    ['product_name', 'TEXT'],
    ['dc_usd', 'REAL'],
    ['dc_krw', 'REAL'],
    ['discount_rate', 'REAL'],
    ['voucher_amount', 'REAL'],
    ['voucher_deduction', 'REAL'],
    ['customer_points', 'REAL'],
    ['customer_rebate', 'REAL'],
    ['store_base_points', 'REAL'],
    ['store_base_rebate', 'REAL'],
    ['store_extra_points', 'REAL'],
    ['store_extra_amount', 'REAL'],
    ['store_final_rebate', 'REAL'],
    ['category_secondary', 'TEXT'],
    ['remark', 'TEXT'],
  ]);

  addMissingColumns(db, 'departure_sync_audit', [
    ['reason', "TEXT DEFAULT 'cross_purchase'"],
  ]);

  addMissingColumns(db, 'daily_receipt_export', [
    ['receipt_date', 'TEXT'],
    ['agent_id', 'INTEGER'],
    ['agent_code', 'TEXT'],
    ['source_type', "TEXT DEFAULT 'imported'"],
    ['source_batch_id', 'TEXT'],
    ['source_task_id', 'TEXT'],
    ['modified_by', 'TEXT'],
    ['ledger_status', "TEXT DEFAULT 'in_review'"],
    ['remedy_reason', 'TEXT'],
    ['posted_at', 'TEXT'],
    ['posted_by', 'TEXT'],
  ]);

  if (tableExists(db, 'daily_receipt_export')) {
    db.exec(`UPDATE daily_receipt_export
             SET receipt_date = substr(imported_at, 1, 10)
             WHERE receipt_date IS NULL`);
    db.exec(`UPDATE daily_receipt_export
             SET ledger_status = 'posted', posted_at = imported_at
             WHERE ledger_status IS NULL OR ledger_status = ''`);
  }

  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_daily_receipt_date ON daily_receipt_export (workspace_key, receipt_date)'
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_daily_receipt_agent ON daily_receipt_export (workspace_key, agent_id)'
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_daily_receipt_source ON daily_receipt_export (workspace_key, source_type)'
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_daily_receipt_ledger_status ON daily_receipt_export (workspace_key, ledger_status)'
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_daily_receipt_remedy ON daily_receipt_export (workspace_key, ledger_status, remedy_reason)'
  );
};
