'use strict';

function createModeDeductConfigRepository({ db }) {
  if (!db) throw new Error('db is required');

  const listStmt = db.prepare(`
    SELECT *
    FROM mode_deduct_config
    WHERE workspace_key = ?
    ORDER BY mode_folder
  `);
  const upsertStmt = db.prepare(`
    INSERT INTO mode_deduct_config (
      workspace_key, mode_folder, deduct_value, confirmed_at, updated_by, updated_at
    ) VALUES (?, ?, ?, NULL, ?, ?)
    ON CONFLICT(workspace_key, mode_folder) DO UPDATE SET
      deduct_value = excluded.deduct_value,
      confirmed_at = NULL,
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at
  `);

  function mapRow(row) {
    if (!row) return null;
    return {
      workspaceKey: row.workspace_key,
      modeFolder: row.mode_folder,
      deductValue: row.deduct_value == null ? null : Number(row.deduct_value),
      confirmedAt: row.confirmed_at || null,
      updatedBy: row.updated_by || null,
      updatedAt: row.updated_at,
    };
  }

  return {
    listByWorkspace(workspaceKey) {
      return listStmt.all(workspaceKey).map(mapRow);
    },
    upsertRows({ workspaceKey, rows, updatedBy = null, updatedAt }) {
      if (!Array.isArray(rows) || rows.length === 0) return 0;
      let changes = 0;
      db.exec('BEGIN');
      try {
        for (const row of rows) {
          changes += upsertStmt.run(
            workspaceKey,
            row.modeFolder,
            row.deductValue == null ? null : Number(row.deductValue),
            updatedBy || null,
            updatedAt
          ).changes;
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return changes;
    },
  };
}

module.exports = { createModeDeductConfigRepository };
