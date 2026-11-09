'use strict';

function getColumnNames(db, table) {
  return db.prepare(`PRAGMA table_info('${table}')`).all().map((row) => row.name);
}

function addColumnIfMissing(db, table, columnName, definition) {
  const columns = new Set(getColumnNames(db, table));
  if (!columns.has(columnName)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnName} ${definition}`);
  }
}

module.exports = function addMergePhase2(db) {
  addColumnIfMissing(db, 'monthly_data', 'customer_rebate_krw', 'REAL');
  addColumnIfMissing(db, 'monthly_data', 'customer_rebate_usd', 'REAL');
  addColumnIfMissing(db, 'monthly_data', 'merge_config_version', 'TEXT');
};
