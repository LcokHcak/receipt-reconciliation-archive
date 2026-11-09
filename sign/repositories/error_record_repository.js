'use strict';

const { chunkArray } = require('../lib/workbench_utils');

const SQLITE_IN_CHUNK_SIZE = 500;

function createErrorRecordRepository({ db }) {
  if (!db) throw new Error('db is required');

  const insertStmt = db.prepare(`
    INSERT INTO error_record (
      workspace_key, error_type, severity, store_family, mode,
      tour_no, receipt_no, passport_no, name,
      expected_value, actual_value, owner, status, detected_at,
      resolved_at, resolved_by, resolution_note, raw_payload,
      source_id, source_table
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // L610:抑制守卫改按行(source_id)——新行只被「本行 matched」抑制,兄弟行的真阻塞照计;
  // legacy(source_id 为 null)回退 receipt_no,行为与现状一致(零回归)。
  const countByTypeStmt = db.prepare(`
    SELECT e.error_type, e.status, COUNT(1) AS count
    FROM error_record e
    WHERE e.workspace_key = ?
      AND NOT (
        e.status = 'open'
        AND e.error_type LIKE 'TM_%'
        AND EXISTS (
          SELECT 1
          FROM daily_receipt_export d
          WHERE d.workspace_key = e.workspace_key
            AND (
              (e.source_id IS NOT NULL AND d.id = e.source_id)
              OR (e.source_id IS NULL AND d.receipt_no = e.receipt_no)
            )
            AND d.tour_match_status IN ('matched', 'skipped_mode_not_required')
        )
      )
    GROUP BY e.error_type, e.status
  `);
  const listStmt = db.prepare(`
    SELECT * FROM error_record
    WHERE workspace_key = ?
      AND (? IS NULL OR error_type = ?)
      AND (? IS NULL OR status = ?)
    ORDER BY detected_at DESC, id DESC
    LIMIT ? OFFSET ?
  `);
  const resolveStmt = db.prepare(`
    UPDATE error_record
    SET status = 'resolved', resolved_at = ?, resolved_by = ?, resolution_note = ?
    WHERE id = ?
  `);
  const deleteByTypeStmt = db.prepare(`
    DELETE FROM error_record
    WHERE workspace_key = ? AND error_type = ? AND status = 'open'
  `);

  function mapRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      workspaceKey: row.workspace_key,
      errorType: row.error_type,
      severity: row.severity,
      storeFamily: row.store_family,
      mode: row.mode,
      tourNo: row.tour_no,
      receiptNo: row.receipt_no,
      passportNo: row.passport_no,
      name: row.name,
      expectedValue: row.expected_value,
      actualValue: row.actual_value,
      owner: row.owner,
      status: row.status,
      detectedAt: row.detected_at,
      resolvedAt: row.resolved_at,
      resolvedBy: row.resolved_by,
      resolutionNote: row.resolution_note,
      rawPayload: row.raw_payload ? safeJson(row.raw_payload) : null,
      sourceId: row.source_id ?? null,
      sourceTable: row.source_table ?? null,
    };
  }

  return {
    insertMany(rows) {
      const inserted = [];
      db.exec('BEGIN');
      try {
        for (const r of rows) {
          const result = insertStmt.run(
            r.workspaceKey,
            r.errorType,
            r.severity || 'high',
            r.storeFamily || null,
            r.mode || null,
            r.tourNo || null,
            r.receiptNo || null,
            r.passportNo || null,
            r.name || null,
            r.expectedValue || null,
            r.actualValue || null,
            r.owner || null,
            r.status || 'open',
            r.detectedAt,
            r.resolvedAt || null,
            r.resolvedBy || null,
            r.resolutionNote || null,
            r.rawPayload ? JSON.stringify(r.rawPayload) : null,
            r.sourceId == null ? null : Number(r.sourceId), // L610:行级来源(=daily_receipt_export.id)
            r.sourceTable || (r.sourceId == null ? null : 'daily_receipt_export')
          );
          inserted.push({ id: Number(result.lastInsertRowid), input: r });
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return { inserted: inserted.length, records: inserted };
    },
    countByType(workspaceKey) {
      return countByTypeStmt.all(workspaceKey);
    },
    list({ workspaceKey, errorType = null, status = null, limit = 100, offset = 0 }) {
      return listStmt
        .all(workspaceKey, errorType, errorType, status, status, limit, offset)
        .map(mapRow);
    },
    resolve({ id, resolvedAt, resolvedBy, note }) {
      resolveStmt.run(resolvedAt, resolvedBy || null, note || null, id);
    },
    clearOpenByType({ workspaceKey, errorType }) {
      const result = deleteByTypeStmt.run(workspaceKey, errorType);
      return result.changes;
    },
    // 清掉指定小票号上、某前缀类型(默认团号匹配 TM_*)的 open 错误。
    // 用于 tour_match 重跑/行重新排队前,避免旧阻塞项残留累积。
    deleteOpenByReceiptNos({ workspaceKey, receiptNos, typePrefix = 'TM' }) {
      const list = Array.from(new Set((receiptNos || []).filter((r) => r != null && r !== '')));
      if (!list.length) return 0;
      let deleted = 0;
      for (const chunk of chunkArray(list, SQLITE_IN_CHUNK_SIZE)) {
        const placeholders = chunk.map(() => '?').join(',');
        const sql = `DELETE FROM error_record
                     WHERE workspace_key = ? AND status = 'open'
                       AND error_type LIKE ? AND receipt_no IN (${placeholders})`;
        deleted += db.prepare(sql).run(workspaceKey, `${typePrefix}%`, ...chunk).changes;
      }
      return deleted;
    },
    // L610:按行(source_id)精确清某前缀类型(默认 TM_*)的 open 错误——新行只清本行,不连坐同票号
    // 兄弟行。combined predicate:source_id 命中(新行) OR source_id 为 null 且 receipt_no 命中(legacy
    // 兜底,过渡期不漏清、与旧 deleteOpenByReceiptNos 同行为)。sourceIds/receiptNos 由调用方(tour_match
    // 自愈)分别备好。镜像 pending_review_repository.deleteOpenBySourceIds。
    deleteOpenBySourceIds({ workspaceKey, sourceTable = 'daily_receipt_export', sourceIds = [], receiptNos = [], typePrefix = 'TM' }) {
      const ids = Array.from(new Set((sourceIds || []).map(Number).filter(Number.isFinite)));
      const rns = Array.from(new Set((receiptNos || []).filter((r) => r != null && r !== '')));
      if (!ids.length && !rns.length) return 0;
      let deleted = 0;
      // 两路各自分块删(IN 上限);combined 语义靠两条 DELETE 达成(id 路精确、rn 路仅清 legacy null)。
      for (const chunk of chunkArray(ids, SQLITE_IN_CHUNK_SIZE)) {
        const ph = chunk.map(() => '?').join(',');
        const sql = `DELETE FROM error_record
                     WHERE workspace_key = ? AND status = 'open' AND error_type LIKE ?
                       AND source_table = ? AND source_id IN (${ph})`;
        deleted += db.prepare(sql).run(workspaceKey, `${typePrefix}%`, sourceTable, ...chunk).changes;
      }
      for (const chunk of chunkArray(rns, SQLITE_IN_CHUNK_SIZE)) {
        const ph = chunk.map(() => '?').join(',');
        const sql = `DELETE FROM error_record
                     WHERE workspace_key = ? AND status = 'open' AND error_type LIKE ?
                       AND source_id IS NULL AND receipt_no IN (${ph})`;
        deleted += db.prepare(sql).run(workspaceKey, `${typePrefix}%`, ...chunk).changes;
      }
      return deleted;
    },
  };
}

function safeJson(value) {
  try { return JSON.parse(value); } catch { return null; }
}

module.exports = {
  createErrorRecordRepository,
};
