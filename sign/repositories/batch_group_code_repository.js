'use strict';

/**
 * Batch-scoped group code repository.
 *
 * These rows come from the 团号表 uploaded while creating an OCR/review batch.
 * They are intentionally separate from monthly group_code: matching should use
 * the current batch first, while monthly group_code remains a legacy/manual
 * fallback and reporting source.
 */
function createBatchGroupCodeRepository({ db }) {
  if (!db) throw new Error('db is required');

  // ⚠️ INSERT OR REPLACE 在唯一索引 (batch_id,tour_no,COALESCE(mode,'')) 冲突时删旧插新,
  // **id 会变**(重导同一张表 id 重排)——id 只能当本次查询的行标识,绝不能被别处持久引用。
  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO batch_group_code (
      batch_id, source_workspace_key, tour_no, mode, mode_normalized, agent,
      upstream, passport_no, name, apply_date_raw, apply_date, end_date_raw,
      end_date, shilla_airport, shinsegae_airport, remark, is_placeholder,
      row_hash, source_file, source_sheet, source_row, raw_payload,
      imported_at, imported_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const findByTourStmt = db.prepare(`
    SELECT *
    FROM batch_group_code
    WHERE batch_id = ? AND tour_no = ?
    ORDER BY imported_at DESC, id DESC
  `);
  const listByBatchStmt = db.prepare(`
    SELECT *
    FROM batch_group_code
    WHERE batch_id = ?
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `);
  const countByBatchStmt = db.prepare(`
    SELECT COUNT(1) AS n
    FROM batch_group_code
    WHERE batch_id = ?
  `);
  // 团号近似纠错用:该批次全部去重团号(轻量,只取号码列)
  const distinctTourNosByBatchStmt = db.prepare(`
    SELECT DISTINCT tour_no
    FROM batch_group_code
    WHERE batch_id = ?
      AND tour_no IS NOT NULL
      AND TRIM(tour_no) <> ''
  `);
  const distinctModesByBatchStmt = db.prepare(`
    SELECT DISTINCT mode
    FROM batch_group_code
    WHERE batch_id = ?
      AND mode IS NOT NULL
      AND TRIM(mode) <> ''
    ORDER BY mode
  `);
  const deleteByBatchStmt = db.prepare('DELETE FROM batch_group_code WHERE batch_id = ?');

  function mapRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      batchId: row.batch_id,
      sourceWorkspaceKey: row.source_workspace_key,
      tourNo: row.tour_no,
      mode: row.mode,
      modeNormalized: row.mode_normalized,
      agent: row.agent,
      upstream: row.upstream,
      passportNo: row.passport_no,
      name: row.name,
      applyDateRaw: row.apply_date_raw,
      applyDate: row.apply_date,
      endDateRaw: row.end_date_raw,
      endDate: row.end_date,
      shillaAirport: row.shilla_airport,
      shinsegaeAirport: row.shinsegae_airport,
      remark: row.remark,
      isPlaceholder: Boolean(row.is_placeholder),
      rowHash: row.row_hash,
      sourceFile: row.source_file,
      sourceSheet: row.source_sheet,
      sourceRow: row.source_row,
      rawPayload: safeJson(row.raw_payload),
      importedAt: row.imported_at,
      importedBy: row.imported_by,
    };
  }

  return {
    insertMany(rows) {
      if (!Array.isArray(rows) || rows.length === 0) return { inserted: 0, skipped: 0 };
      let inserted = 0;
      let skipped = 0;
      db.exec('BEGIN');
      try {
        for (const row of rows) {
          const result = insertStmt.run(
            row.batchId,
            row.sourceWorkspaceKey || null,
            row.tourNo,
            row.mode || null,
            row.modeNormalized || null,
            row.agent || null,
            row.upstream || null,
            row.passportNo || null,
            row.name || null,
            row.applyDateRaw || null,
            row.applyDate || null,
            row.endDateRaw || null,
            row.endDate || null,
            row.shillaAirport || null,
            row.shinsegaeAirport || null,
            row.remark || null,
            row.isPlaceholder ? 1 : 0,
            row.rowHash,
            row.sourceFile || null,
            row.sourceSheet || null,
            row.sourceRow == null ? null : Number(row.sourceRow),
            row.rawPayload ? JSON.stringify(row.rawPayload) : null,
            row.importedAt,
            row.importedBy || null
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
    replaceBatch({ batchId, rows }) {
      if (!batchId) throw new Error('batchId is required');
      const inputRows = Array.isArray(rows) ? rows : [];
      let inserted = 0;
      db.exec('BEGIN');
      try {
        deleteByBatchStmt.run(batchId);
        for (const row of inputRows) {
          const result = insertStmt.run(
            row.batchId || batchId,
            row.sourceWorkspaceKey || null,
            row.tourNo,
            row.mode || null,
            row.modeNormalized || null,
            row.agent || null,
            row.upstream || null,
            row.passportNo || null,
            row.name || null,
            row.applyDateRaw || null,
            row.applyDate || null,
            row.endDateRaw || null,
            row.endDate || null,
            row.shillaAirport || null,
            row.shinsegaeAirport || null,
            row.remark || null,
            row.isPlaceholder ? 1 : 0,
            row.rowHash,
            row.sourceFile || null,
            row.sourceSheet || null,
            row.sourceRow == null ? null : Number(row.sourceRow),
            row.rawPayload ? JSON.stringify(row.rawPayload) : null,
            row.importedAt,
            row.importedBy || null
          );
          if (result.changes > 0) inserted += 1;
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return { inserted, skipped: 0 };
    },
    findByTour({ batchId, tourNo }) {
      return findByTourStmt.all(batchId, tourNo).map(mapRow);
    },
    listByBatch({ batchId, limit = 100, offset = 0 }) {
      return listByBatchStmt.all(batchId, limit, offset).map(mapRow);
    },
    countByBatch(batchId) {
      return Number(countByBatchStmt.get(batchId)?.n || 0);
    },
    listModesByBatch(batchId) {
      return distinctModesByBatchStmt.all(batchId).map((row) => row.mode);
    },
    listTourNosByBatch(batchId) {
      return distinctTourNosByBatchStmt.all(batchId).map((row) => String(row.tour_no));
    },
  };
}

function safeJson(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

module.exports = { createBatchGroupCodeRepository };
