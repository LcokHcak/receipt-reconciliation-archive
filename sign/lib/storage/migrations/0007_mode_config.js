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

module.exports = function addModeConfig(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mode_deduct_config (
      workspace_key TEXT NOT NULL,
      mode_folder TEXT NOT NULL,
      deduct_value REAL,
      confirmed_at TEXT,
      updated_by TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_key, mode_folder)
    );

    CREATE TABLE IF NOT EXISTS mode_folder_mapping (
      workspace_key TEXT NOT NULL,
      mode_raw TEXT NOT NULL,
      mode_folder TEXT,
      created_by TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_key, mode_raw)
    );
  `);

  addColumnIfMissing(db, 'monthly_workspace', 'deduct_config_confirmed_at', 'TEXT');
  addColumnIfMissing(db, 'monthly_workspace', 'mode_mapping_confirmed_at', 'TEXT');
};
