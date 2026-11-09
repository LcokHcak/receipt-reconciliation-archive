'use strict';

/**
 * received_receipt — 25 worker sheets from 收票汇总.xlsx.
 * This table is the "gold truth" operators manually fill in for each
 * receipt; downstream stages cross-check bills and daily exports
 * against it.
 */

function createReceivedReceiptRepository({ db }) {
  if (!db) throw new Error('db is required');

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO received_receipt (
      workspace_key, worker_name, worker_no,
      receipt_date, agent, purchase_date, receipt_no, tour_no,
      name, passport_no, departure_date,
      mode_raw, mode_normalized, owner,
      shinsegae_airport, shilla_airport,
      source_file, source_sheet, source_row, raw_payload,
      row_hash, imported_at, import_job_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const countByWorkspaceStmt = db.prepare(
    `SELECT COUNT(1) AS n FROM received_receipt WHERE workspace_key = ?`
  );
  const deleteByIdStmt = db.prepare(`DELETE FROM received_receipt WHERE workspace_key = ? AND id = ?`);
  const countByWorkerStmt = db.prepare(`
    SELECT worker_name AS worker, worker_no, COUNT(1) AS n
    FROM received_receipt
    WHERE workspace_key = ?
    GROUP BY worker_name, worker_no
    ORDER BY worker_no
  `);
  const findByReceiptStmt = db.prepare(`
    SELECT * FROM received_receipt
    WHERE workspace_key = ? AND receipt_no = ?
  `);
  const findByPassportStmt = db.prepare(`
    SELECT * FROM received_receipt
    WHERE workspace_key = ? AND passport_no = ?
    ORDER BY receipt_date, id
  `);
  const findByTourStmt = db.prepare(`
    SELECT * FROM received_receipt
    WHERE workspace_key = ? AND tour_no = ?
    ORDER BY id
  `);
  const listStmt = db.prepare(`
    SELECT * FROM received_receipt
    WHERE workspace_key = ?
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `);

  function mapRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      workspaceKey: row.workspace_key,
      workerName: row.worker_name,
      workerNo: row.worker_no,
      receiptDate: row.receipt_date,
      agent: row.agent,
      purchaseDate: row.purchase_date,
      receiptNo: row.receipt_no,
      tourNo: row.tour_no,
      name: row.name,
      passportNo: row.passport_no,
      departureDate: row.departure_date,
      modeRaw: row.mode_raw,
      modeNormalized: row.mode_normalized,
      owner: row.owner,
      shinsegaeAirport: row.shinsegae_airport,
      shillaAirport: row.shilla_airport,
      sourceFile: row.source_file,
      sourceSheet: row.source_sheet,
      sourceRow: row.source_row,
      rowHash: row.row_hash,
      importedAt: row.imported_at,
      importJobId: row.import_job_id,
    };
  }

  return {
    insertMany(rows) {
      if (!Array.isArray(rows) || rows.length === 0) return { inserted: 0, skipped: 0 };
      let inserted = 0;
      let skipped = 0;
      db.exec('BEGIN');
      try {
        for (const r of rows) {
          const result = insertStmt.run(
            r.workspaceKey,
            r.workerName || null,
            r.workerNo || null,
            r.receiptDate || null,
            r.agent || null,
            r.purchaseDate || null,
            r.receiptNo || null,
            r.tourNo || null,
            r.name || null,
            r.passportNo || null,
            r.departureDate || null,
            r.modeRaw || null,
            r.modeNormalized || null,
            r.owner || null,
            r.shinsegaeAirport || null,
            r.shillaAirport || null,
            r.sourceFile || null,
            r.sourceSheet || null,
            r.sourceRow == null ? null : Number(r.sourceRow),
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
      return Number(countByWorkspaceStmt.get(workspaceKey)?.n || 0);
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
    countByWorker(workspaceKey) {
      return countByWorkerStmt.all(workspaceKey);
    },
    findByReceipt({ workspaceKey, receiptNo }) {
      return findByReceiptStmt.all(workspaceKey, receiptNo).map(mapRow);
    },
    findByPassport({ workspaceKey, passportNo }) {
      return findByPassportStmt.all(workspaceKey, passportNo).map(mapRow);
    },
    findByTour({ workspaceKey, tourNo }) {
      return findByTourStmt.all(workspaceKey, tourNo).map(mapRow);
    },
    list({ workspaceKey, limit = 100, offset = 0 }) {
      return listStmt.all(workspaceKey, Number(limit), Number(offset)).map(mapRow);
    },
  };
}

module.exports = { createReceivedReceiptRepository };
