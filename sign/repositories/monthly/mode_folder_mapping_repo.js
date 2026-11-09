'use strict';

function createModeFolderMappingRepository({ db }) {
  if (!db) throw new Error('db is required');

  const listStmt = db.prepare(`
    SELECT *
    FROM mode_folder_mapping
    WHERE workspace_key = ?
    ORDER BY mode_raw
  `);
  const upsertStmt = db.prepare(`
    INSERT INTO mode_folder_mapping (
      workspace_key, mode_raw, mode_folder, created_by, updated_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(workspace_key, mode_raw) DO UPDATE SET
      mode_folder = excluded.mode_folder,
      updated_at = excluded.updated_at
  `);
  const dailyModeRawStmt = db.prepare(`
    SELECT DISTINCT mode_raw
    FROM daily_receipt_export
    WHERE workspace_key = ?
      AND mode_raw IS NOT NULL
      AND TRIM(mode_raw) <> ''
    ORDER BY mode_raw
  `);
  // 缺口B: "未归类"= 台账里出现、但映射表里【没有任何决定行】的模式。
  // 判定改用 m.mode_raw IS NULL(无映射行)而非 m.mode_folder IS NULL,
  // 这样操作员显式选"不参与"(存一行 mode_folder=null)算【已决定】,不再算未归类、不卡 merge。
  const unmappedStmt = db.prepare(`
    SELECT DISTINCT d.mode_raw
    FROM daily_receipt_export d
    LEFT JOIN mode_folder_mapping m
      ON m.workspace_key = d.workspace_key
     AND m.mode_raw = d.mode_raw
    WHERE d.workspace_key = ?
      AND d.mode_raw IS NOT NULL
      AND TRIM(d.mode_raw) <> ''
      AND m.mode_raw IS NULL
    ORDER BY d.mode_raw
  `);

  function mapRow(row) {
    if (!row) return null;
    return {
      workspaceKey: row.workspace_key,
      modeRaw: row.mode_raw,
      modeFolder: row.mode_folder || null,
      createdBy: row.created_by || null,
      updatedAt: row.updated_at,
    };
  }

  return {
    listByWorkspace(workspaceKey) {
      return listStmt.all(workspaceKey).map(mapRow);
    },
    listDailyModeRaw(workspaceKey) {
      return dailyModeRawStmt.all(workspaceKey).map((row) => row.mode_raw);
    },
    listUnmapped(workspaceKey) {
      return unmappedStmt.all(workspaceKey).map((row) => row.mode_raw);
    },
    upsertRows({ workspaceKey, rows, updatedBy = null, updatedAt }) {
      if (!Array.isArray(rows) || rows.length === 0) return 0;
      let changes = 0;
      db.exec('BEGIN');
      try {
        for (const row of rows) {
          changes += upsertStmt.run(
            workspaceKey,
            row.modeRaw,
            row.modeFolder || null,
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

module.exports = { createModeFolderMappingRepository };
