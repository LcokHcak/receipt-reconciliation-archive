'use strict';

function createMissingReceiptRepository({ db }) {
  if (!db) throw new Error('db is required');

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO missing_receipt (
      workspace_key, mode, mode_normalized, tour_no, purchase_date,
      name, full_name, passport_no, receipt_no, brand, net_usd,
      agent, owner, status, source_file, source_sheet,
      raw_payload, row_hash, imported_at, import_job_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const countByWsStmt = db.prepare(`SELECT COUNT(1) AS count FROM missing_receipt WHERE workspace_key = ?`);
  const countByStatusStmt = db.prepare(`
    SELECT status, COUNT(1) AS count
    FROM missing_receipt
    WHERE workspace_key = ?
    GROUP BY status
  `);
  const listStmt = db.prepare(`
    SELECT * FROM missing_receipt
    WHERE workspace_key = ?
      AND (? IS NULL OR status = ?)
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `);
  const updateStatusStmt = db.prepare(`
    UPDATE missing_receipt SET status = ? WHERE id = ?
  `);
  const deleteByIdStmt = db.prepare(`DELETE FROM missing_receipt WHERE workspace_key = ? AND id = ?`);

  function mapRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      workspaceKey: row.workspace_key,
      mode: row.mode,
      modeNormalized: row.mode_normalized,
      tourNo: row.tour_no,
      purchaseDate: row.purchase_date,
      name: row.name,
      fullName: row.full_name,
      passportNo: row.passport_no,
      receiptNo: row.receipt_no,
      brand: row.brand,
      netUsd: row.net_usd,
      agent: row.agent,
      owner: row.owner,
      status: row.status,
      sourceFile: row.source_file,
      sourceSheet: row.source_sheet,
      rowHash: row.row_hash,
      importedAt: row.imported_at,
      importJobId: row.import_job_id,
    };
  }

  return {
    insertMany(rows) {
      let inserted = 0;
      let skipped = 0;
      db.exec('BEGIN');
      try {
        for (const r of rows) {
          const result = insertStmt.run(
            r.workspaceKey,
            r.mode || null,
            r.modeNormalized || null,
            r.tourNo || null,
            r.purchaseDate || null,
            r.name || null,
            r.fullName || null,
            r.passportNo || null,
            r.receiptNo || null,
            r.brand || null,
            r.netUsd == null ? null : Number(r.netUsd),
            r.agent || null,
            r.owner || null,
            r.status || 'pending',
            r.sourceFile || null,
            r.sourceSheet || null,
            r.rawPayload ? JSON.stringify(r.rawPayload) : null,
            r.rowHash,
            r.importedAt,
            r.importJobId || null
          );
          if (result.changes > 0) inserted += 1; else skipped += 1;
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return { inserted, skipped };
    },
    countByWorkspace(workspaceKey) {
      return Number(countByWsStmt.get(workspaceKey)?.count || 0);
    },
    deleteMany({ workspaceKey, ids }) {
      if (!Array.isArray(ids) || ids.length === 0) return 0;
      let deleted = 0;
      db.exec('BEGIN');
      try {
        for (const id of ids) {
          deleted += deleteByIdStmt.run(workspaceKey, Number(id)).changes;
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return deleted;
    },
    countByStatus(workspaceKey) {
      return countByStatusStmt.all(workspaceKey);
    },
    list({ workspaceKey, status = null, limit = 50, offset = 0 }) {
      return listStmt.all(workspaceKey, status, status, limit, offset).map(mapRow);
    },
    updateStatus({ id, status }) {
      updateStatusStmt.run(status, id);
    },
  };
}

module.exports = {
  createMissingReceiptRepository,
};
