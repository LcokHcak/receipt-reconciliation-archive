'use strict';

const { runSqliteTransaction } = require('../lib/storage/sqlite_transaction');
const { computeFingerprint } = require('../lib/monthly/conflict_fingerprint');
const { chunkArray } = require('../lib/workbench_utils');
// 「活跃待审」谓词单一来源(原本本文件与 final_delivery_export_service 各一份,已合并)
const { ACTIONABLE_PENDING_PREDICATE } = require('../lib/monthly_pipeline/actionable_pending_sql');

const SQLITE_IN_CHUNK_SIZE = 500;

/**
 * pending_review — any case where stage 1.5/2 cannot auto-decide goes
 * into this queue with a JSON payload describing the conflict.
 */

function createPendingReviewRepository({ db }) {
  if (!db) throw new Error('db is required');

  const insertStmt = db.prepare(`
    INSERT INTO pending_review (
      workspace_key, source_table, source_id,
      reason_type, detail, status, created_at, conflict_fingerprint
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const resolveStmt = db.prepare(`
    UPDATE pending_review
    SET status = ?, resolved_at = ?, resolved_by = ?, resolution = ?
    WHERE id = ? AND workspace_key = ?
  `);
  const updateFingerprintStmt = db.prepare(`
    UPDATE pending_review
    SET conflict_fingerprint = ?
    WHERE id = ? AND workspace_key = ?
  `);
  const closeByDailyStmt = db.prepare(`
    UPDATE pending_review
    SET status = 'resolved',
        resolved_at = ?,
        resolved_by = ?,
        resolution = 'workspace_migrated'
    WHERE workspace_key = ?
      AND source_table = 'daily_receipt_export'
      AND source_id = ?
      AND status = 'open'
  `);
  const countStmt = db.prepare(`
    SELECT COUNT(1) AS n
    FROM pending_review pr
    WHERE pr.workspace_key = ? AND pr.status = 'open'
      AND ${ACTIONABLE_PENDING_PREDICATE}
  `);
  const countFilteredStmt = db.prepare(`
    SELECT COUNT(1) AS n
    FROM pending_review pr
    WHERE pr.workspace_key = ?
      AND (? IS NULL OR pr.status = ?)
      AND (? IS NULL OR pr.reason_type = ?)
      AND ${ACTIONABLE_PENDING_PREDICATE}
  `);
  const countByReasonStmt = db.prepare(`
    SELECT pr.reason_type AS reason, COUNT(1) AS n
    FROM pending_review pr
    WHERE pr.workspace_key = ? AND pr.status = 'open'
      AND ${ACTIONABLE_PENDING_PREDICATE}
    GROUP BY pr.reason_type
    ORDER BY n DESC
  `);
  const listStmt = db.prepare(`
    SELECT pr.* FROM pending_review pr
    WHERE pr.workspace_key = ?
      AND (? IS NULL OR pr.status = ?)
      AND (? IS NULL OR pr.reason_type = ?)
      AND ${ACTIONABLE_PENDING_PREDICATE}
    ORDER BY pr.id DESC
    LIMIT ? OFFSET ?
  `);
  const findByIdStmt = db.prepare(
    `SELECT * FROM pending_review WHERE id = ? AND workspace_key = ?`
  );
  const findByFingerprintStmt = db.prepare(`
    SELECT *
    FROM pending_review
    WHERE workspace_key = ?
      AND conflict_fingerprint = ?
      AND status IN ('open', 'resolved', 'approved', 'rejected')
    ORDER BY id DESC
  `);

  function mapRow(r) {
    if (!r) return null;
    return {
      id: r.id,
      workspaceKey: r.workspace_key,
      sourceTable: r.source_table,
      sourceId: r.source_id,
      reasonType: r.reason_type,
      detail: r.detail ? safeJson(r.detail) : null,
      status: r.status,
      createdAt: r.created_at,
      resolvedAt: r.resolved_at,
      resolvedBy: r.resolved_by,
      resolution: r.resolution,
      conflictFingerprint: r.conflict_fingerprint || null,
    };
  }

  return {
    insertMany(rows) {
      if (!Array.isArray(rows) || rows.length === 0) return { inserted: 0 };
      return runSqliteTransaction(db, () => {
        let inserted = 0;
        for (const r of rows) {
          insertStmt.run(
            r.workspaceKey,
            r.sourceTable,
            Number(r.sourceId),
            r.reasonType,
            r.detail == null ? null : JSON.stringify(r.detail),
            r.status || 'open',
            r.createdAt,
            r.conflictFingerprint || computeFingerprint(r)
          );
          inserted += 1;
        }
        return { inserted };
      }, { savepointName: 'pending_review_insert_many' });
    },
    resolve({ id, workspaceKey, status, resolution, resolvedBy, resolvedAt }) {
      return resolveStmt.run(
        status, resolvedAt, resolvedBy || null, resolution || null,
        Number(id), workspaceKey
      ).changes;
    },
    // 删指定来源行(默认 daily_receipt_export)上 open 的待补救。tour_match 重跑/重排队前清旧用。
    // reasonTypes(2026-07-16 同步一致性审计B2/M4):调用方必须声明只清自己产生的类型——
    // 此前无过滤,tour_match 自愈把同一 source_id 上的 second_pass_candidate 连带删掉
    // (每次结算触发的增量跑都在删,账单二次候选提示静默消失)。不传=保持旧行为(全删),
    // 但 tour_match 两处调用已改为显式传 tour 类白名单。
    deleteOpenBySourceIds({ workspaceKey, sourceTable = 'daily_receipt_export', sourceIds, reasonTypes = null }) {
      const list = Array.from(new Set((sourceIds || []).map(Number).filter(Number.isFinite)));
      if (!list.length) return 0;
      const reasons = Array.isArray(reasonTypes)
        ? reasonTypes.map((r) => String(r || '').trim()).filter(Boolean)
        : null;
      let deleted = 0;
      for (const chunk of chunkArray(list, SQLITE_IN_CHUNK_SIZE)) {
        const placeholders = chunk.map(() => '?').join(',');
        const reasonSql = reasons && reasons.length
          ? ` AND reason_type IN (${reasons.map(() => '?').join(',')})`
          : '';
        const sql = `DELETE FROM pending_review
                     WHERE workspace_key = ? AND source_table = ? AND status = 'open'
                       AND source_id IN (${placeholders})${reasonSql}`;
        const params = [workspaceKey, sourceTable, ...chunk];
        if (reasons && reasons.length) params.push(...reasons);
        deleted += db.prepare(sql).run(...params).changes;
      }
      return deleted;
    },
    updateFingerprint({ id, workspaceKey, conflictFingerprint }) {
      return updateFingerprintStmt.run(conflictFingerprint, Number(id), workspaceKey).changes;
    },
    /**
     * 字段冲突在「账单核对」tab 被解决时,同步关掉挂在该台账行上的 open 字段冲突待审。
     * 缺这一步会出孤儿:tab 清了 conflict_fields 归零,pending_review 却仍 open,
     * 首页/交付检查继续报阻塞(2026-06-12 运营截图实锤)。
     * bill-match 待审 source_table='store_bill',与台账的关联在 detail.dailyReceiptId。
     */
    closeFieldConflictByDailyReceiptId({ workspaceKey, dailyReceiptId, operator = 'system', resolution = 'resolved_in_conflict_tab' }) {
      return db.prepare(`
        UPDATE pending_review
        SET status = 'resolved', resolved_at = ?, resolved_by = ?, resolution = ?
        WHERE workspace_key = ?
          AND status = 'open'
          AND source_table = 'store_bill'
          AND reason_type = 'field_conflict'
          AND json_extract(detail, '$.dailyReceiptId') = ?
      `).run(
        new Date().toISOString(),
        operator || 'system',
        resolution,
        workspaceKey,
        Number(dailyReceiptId)
      ).changes;
    },
    closeByDaily({ workspaceKey, dailyReceiptId, operator = 'system' }) {
      return closeByDailyStmt.run(
        new Date().toISOString(),
        operator || 'system',
        workspaceKey,
        Number(dailyReceiptId)
      ).changes;
    },
    /**
     * 重跑清扫(孤儿自愈):关掉这些账单行上「本轮匹配没再遇到的」open 待审。
     * keepFingerprints = 本轮遇到的冲突指纹集合;不在集合里(含历史无指纹行)的
     * open 行 → resolved/superseded_by_rerun。冲突仍存在的行指纹在集合里、不动,
     * 保持同一条 open 行(B4 重放保护契约不变)。
     */
    closeStaleByStoreBillIds({
      workspaceKey, storeBillIds, keepFingerprints,
      operator = 'system', resolution = 'superseded_by_rerun',
    }) {
      if (!Array.isArray(storeBillIds) || storeBillIds.length === 0) return 0;
      const keep = keepFingerprints instanceof Set ? keepFingerprints : new Set(keepFingerprints || []);
      const ids = Array.from(new Set(storeBillIds.map(Number).filter(Number.isFinite)));
      if (!ids.length) return 0;
      const staleIds = [];
      for (const chunk of chunkArray(ids, SQLITE_IN_CHUNK_SIZE)) {
        const placeholders = chunk.map(() => '?').join(',');
        const rows = db.prepare(`
          SELECT id, conflict_fingerprint AS fp
          FROM pending_review
          WHERE workspace_key = ?
            AND source_table = 'store_bill'
            AND source_id IN (${placeholders})
            AND status = 'open'
        `).all(workspaceKey, ...chunk);
        for (const r of rows) {
          if (!r.fp || !keep.has(r.fp)) staleIds.push(Number(r.id));
        }
      }
      if (!staleIds.length) return 0;
      let changed = 0;
      const resolvedAt = new Date().toISOString();
      for (const chunk of chunkArray(staleIds, SQLITE_IN_CHUNK_SIZE)) {
        const placeholders = chunk.map(() => '?').join(',');
        changed += db.prepare(`
          UPDATE pending_review
          SET status = 'resolved', resolved_at = ?, resolved_by = ?, resolution = ?
          WHERE workspace_key = ? AND id IN (${placeholders}) AND status = 'open'
        `).run(resolvedAt, operator || 'system', resolution, workspaceKey, ...chunk).changes;
      }
      return changed;
    },
    closeByStoreBillIds({ workspaceKey, storeBillIds, operator = 'system', resolution = 'store_bill_replaced' }) {
      if (!Array.isArray(storeBillIds) || storeBillIds.length === 0) return 0;
      const ids = Array.from(new Set(storeBillIds.map(Number).filter(Number.isFinite)));
      if (!ids.length) return 0;
      let changed = 0;
      const resolvedAt = new Date().toISOString();
      for (const chunk of chunkArray(ids, SQLITE_IN_CHUNK_SIZE)) {
        const placeholders = chunk.map(() => '?').join(',');
        changed += db.prepare(`
          UPDATE pending_review
          SET status = 'resolved',
              resolved_at = ?,
              resolved_by = ?,
              resolution = ?
          WHERE workspace_key = ?
            AND source_table = 'store_bill'
            AND source_id IN (${placeholders})
            AND status = 'open'
        `).run(
          resolvedAt,
          operator || 'system',
          resolution,
          workspaceKey,
          ...chunk
        ).changes;
      }
      return changed;
    },
    ensureFingerprint({ id, workspaceKey }) {
      const row = mapRow(findByIdStmt.get(Number(id), workspaceKey));
      if (!row || row.conflictFingerprint) return row;
      const conflictFingerprint = computeFingerprint(row);
      updateFingerprintStmt.run(conflictFingerprint, Number(id), workspaceKey);
      return { ...row, conflictFingerprint };
    },
    findByFingerprint({ workspaceKey, fingerprint, statuses = null }) {
      const rows = findByFingerprintStmt.all(workspaceKey, fingerprint).map(mapRow);
      if (!Array.isArray(statuses) || statuses.length === 0) return rows[0] || null;
      const allowed = new Set(statuses);
      return rows.find((row) => allowed.has(row.status)) || null;
    },
    countOpen(workspaceKey) {
      return Number(countStmt.get(workspaceKey)?.n || 0);
    },
    count({ workspaceKey, status = null, reasonType = null }) {
      return Number(countFilteredStmt.get(
        workspaceKey,
        status, status,
        reasonType, reasonType
      )?.n || 0);
    },
    countByReason(workspaceKey) {
      return countByReasonStmt.all(workspaceKey);
    },
    findById({ id, workspaceKey }) {
      return mapRow(findByIdStmt.get(Number(id), workspaceKey));
    },
    list({ workspaceKey, status = null, reasonType = null, limit = 100, offset = 0 }) {
      return listStmt.all(
        workspaceKey,
        status, status,
        reasonType, reasonType,
        Number(limit), Number(offset)
      ).map(mapRow);
    },
  };
}

function safeJson(value) {
  try { return JSON.parse(value); } catch { return null; }
}

module.exports = { createPendingReviewRepository };
