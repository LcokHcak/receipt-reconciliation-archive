'use strict';

const { runSqliteTransaction } = require('../lib/storage/sqlite_transaction');

/**
 * brand_activity — 品牌活动(活动数据)桶。
 * 不参与小票匹配;merge 时按行折进对应交付桶(返点已在 rebate_amount 算好)。
 */
function createBrandActivityRepository({ db }) {
  if (!db) throw new Error('db is required');

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO brand_activity (
      workspace_key, passport_no, name, full_name, brand,
      purchase_date, original_date, store_family, store_branch,
      mode, mode_normalized, mode_folder,
      net_usd, net_krw, points, rebate_amount,
      source_file, source_sheet, source_row, raw_payload,
      row_hash, imported_at, import_job_id,
      imported_by, owner_user_id, owner_username
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const countByWsStmt = db.prepare(`SELECT COUNT(1) AS n FROM brand_activity WHERE workspace_key = ?`);
  const deleteByWsStmt = db.prepare(`DELETE FROM brand_activity WHERE workspace_key = ?`);
  const summaryStmt = db.prepare(`
    SELECT COUNT(1) AS rows,
           COALESCE(SUM(rebate_amount), 0) AS rebateTotal,
           SUM(CASE WHEN rebate_amount < 0 THEN 1 ELSE 0 END) AS negativeRows
    FROM brand_activity WHERE workspace_key = ?
  `);
  const listStmt = db.prepare(`
    SELECT * FROM brand_activity WHERE workspace_key = ?
    ORDER BY mode_folder, passport_no, id
    LIMIT ? OFFSET ?
  `);
  const listAllStmt = db.prepare(`
    SELECT * FROM brand_activity WHERE workspace_key = ? ORDER BY id
  `);

  function mapRow(r) {
    if (!r) return null;
    return {
      id: r.id,
      workspaceKey: r.workspace_key,
      passportNo: r.passport_no,
      name: r.name,
      fullName: r.full_name,
      brand: r.brand,
      purchaseDate: r.purchase_date,
      originalDate: r.original_date,
      storeFamily: r.store_family,
      storeBranch: r.store_branch,
      mode: r.mode,
      modeNormalized: r.mode_normalized,
      modeFolder: r.mode_folder,
      netUsd: r.net_usd,
      netKrw: r.net_krw,
      points: r.points,
      rebateAmount: r.rebate_amount,
      sourceFile: r.source_file,
      sourceRow: r.source_row,
      importedAt: r.imported_at,
    };
  }

  function num(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  return {
    insertMany(rows) {
      if (!Array.isArray(rows) || rows.length === 0) return { inserted: 0, skipped: 0 };
      let inserted = 0;
      runSqliteTransaction(db, () => {
        for (const r of rows) {
          const res = insertStmt.run(
            r.workspaceKey, r.passportNo || null, r.name || null, r.fullName || null, r.brand || null,
            r.purchaseDate || null, r.originalDate || null, r.storeFamily || null, r.storeBranch || null,
            r.mode || null, r.modeNormalized || null, r.modeFolder || null,
            num(r.netUsd), num(r.netKrw), num(r.points), num(r.rebateAmount),
            r.sourceFile || null, r.sourceSheet || null, r.sourceRow ?? null,
            r.rawPayload ? JSON.stringify(r.rawPayload) : null,
            r.rowHash, r.importedAt || null, r.importJobId ?? null,
            r.importedBy || null, r.ownerUserId ?? null, r.ownerUsername || null,
          );
          inserted += res.changes;
        }
      });
      return { inserted, skipped: rows.length - inserted };
    },

    countByWorkspace(workspaceKey) {
      return Number(countByWsStmt.get(workspaceKey)?.n || 0);
    },

    deleteByWorkspace(workspaceKey) {
      return deleteByWsStmt.run(workspaceKey).changes;
    },

    summary(workspaceKey) {
      const r = summaryStmt.get(workspaceKey) || {};
      return {
        rows: Number(r.rows || 0),
        rebateTotal: Number(r.rebateTotal || 0),
        negativeRows: Number(r.negativeRows || 0),
      };
    },

    list({ workspaceKey, limit = 100, offset = 0 }) {
      return listStmt.all(workspaceKey, Number(limit), Number(offset)).map(mapRow);
    },

    listByWorkspace(workspaceKey) {
      return listAllStmt.all(workspaceKey).map(mapRow);
    },
  };
}

module.exports = { createBrandActivityRepository };
