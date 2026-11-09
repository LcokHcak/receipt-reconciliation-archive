'use strict';

/**
 * Group code (团号表) repository. Idempotent inserts keyed on
 * (workspace_key, tour_no, row_hash).
 */
function createGroupCodeRepository({ db }) {
  if (!db) throw new Error('db is required');

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO group_code (
      workspace_key, tour_no, mode, mode_normalized, agent, upstream, passport_no, name,
      apply_date_raw, apply_date, end_date_raw, end_date,
      shilla_airport, shinsegae_airport, remark,
      is_placeholder, row_hash, imported_at, import_job_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const countByWsStmt = db.prepare(`SELECT COUNT(1) AS count FROM group_code WHERE workspace_key = ?`);
  const deleteByWsStmt = db.prepare(`DELETE FROM group_code WHERE workspace_key = ?`);
  const deleteByIdStmt = db.prepare(`DELETE FROM group_code WHERE workspace_key = ? AND id = ?`);
  const listStmt = db.prepare(`
    SELECT * FROM group_code
    WHERE workspace_key = ?
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `);
  const searchStmt = db.prepare(`
    SELECT * FROM group_code
    WHERE workspace_key = ?
      AND (tour_no LIKE ? OR agent LIKE ? OR passport_no LIKE ? OR name LIKE ?)
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `);
  const findByTourStmt = db.prepare(`
    SELECT * FROM group_code
    WHERE workspace_key = ? AND tour_no = ?
    ORDER BY imported_at DESC, id DESC
    LIMIT 1
  `);
  const listAllVersionsByTourStmt = db.prepare(`
    SELECT * FROM group_code
    WHERE workspace_key = ? AND tour_no = ?
    ORDER BY imported_at DESC, id DESC
  `);

  function mapRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      workspaceKey: row.workspace_key,
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
            r.tourNo,
            r.mode || null,
            r.modeNormalized || null,
            r.agent || null,
            r.upstream || null,
            r.passportNo || null,
            r.name || null,
            r.applyDateRaw || null,
            r.applyDate || null,
            r.endDateRaw || null,
            r.endDate || null,
            r.shillaAirport || null,
            r.shinsegaeAirport || null,
            r.remark || null,
            r.isPlaceholder ? 1 : 0,
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
    deleteByWorkspace(workspaceKey) {
      const result = deleteByWsStmt.run(workspaceKey);
      return result.changes;
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
    list({ workspaceKey, limit = 50, offset = 0 }) {
      return listStmt.all(workspaceKey, limit, offset).map(mapRow);
    },
    search({ workspaceKey, query, limit = 50, offset = 0 }) {
      const like = `%${String(query || '').trim()}%`;
      return searchStmt.all(workspaceKey, like, like, like, like, limit, offset).map(mapRow);
    },
    findByTour({ workspaceKey, tourNo }) {
      return findByTourStmt.all(workspaceKey, tourNo).map(mapRow);
    },
    listAllVersionsByTour({ workspaceKey, tourNo }) {
      return listAllVersionsByTourStmt.all(workspaceKey, tourNo).map(mapRow);
    },
  };
}

module.exports = {
  createGroupCodeRepository,
};
