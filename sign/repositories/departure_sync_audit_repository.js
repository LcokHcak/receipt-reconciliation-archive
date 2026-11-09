'use strict';

/**
 * Audit trail for CC_DEPARTURE_SYNC auto-rewrites. Each rewrite records
 * before_value / after_value / triggered_by so we never silently mutate
 * a customer's departure date.
 */
function createDepartureSyncAuditRepository({ db }) {
  if (!db) throw new Error('db is required');

  const insertStmt = db.prepare(`
    INSERT INTO departure_sync_audit (
      workspace_key, store_bill_id, passport_no, name, receipt_no,
      before_value, after_value, triggered_by, triggered_at, error_record_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const listStmt = db.prepare(`
    SELECT * FROM departure_sync_audit
    WHERE workspace_key = ?
    ORDER BY triggered_at DESC, id DESC
    LIMIT ? OFFSET ?
  `);

  const countStmt = db.prepare(`
    SELECT COUNT(1) AS count FROM departure_sync_audit WHERE workspace_key = ?
  `);

  function mapRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      workspaceKey: row.workspace_key,
      storeBillId: row.store_bill_id,
      passportNo: row.passport_no,
      name: row.name,
      receiptNo: row.receipt_no,
      beforeValue: row.before_value,
      afterValue: row.after_value,
      triggeredBy: row.triggered_by,
      triggeredAt: row.triggered_at,
      errorRecordId: row.error_record_id,
    };
  }

  return {
    insertMany(rows) {
      let inserted = 0;
      db.exec('BEGIN');
      try {
        for (const r of rows) {
          insertStmt.run(
            r.workspaceKey,
            Number(r.storeBillId),
            r.passportNo || null,
            r.name || null,
            r.receiptNo || null,
            r.beforeValue || null,
            r.afterValue || null,
            r.triggeredBy || null,
            r.triggeredAt,
            r.errorRecordId == null ? null : Number(r.errorRecordId)
          );
          inserted += 1;
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return { inserted };
    },
    list({ workspaceKey, limit = 100, offset = 0 }) {
      return listStmt.all(workspaceKey, limit, offset).map(mapRow);
    },
    count(workspaceKey) {
      return Number(countStmt.get(workspaceKey)?.count || 0);
    },
  };
}

module.exports = {
  createDepartureSyncAuditRepository,
};
