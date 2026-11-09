'use strict';

const { runSqliteTransaction } = require('../lib/storage/sqlite_transaction');
const { chunkArray } = require('../lib/workbench_utils');

const SQLITE_IN_CHUNK_SIZE = 500;

/**
 * bill_match_log — per-match decision log written by stage-2/3 engines.
 */

function createBillMatchLogRepository({ db }) {
  if (!db) throw new Error('db is required');

  const insertStmt = db.prepare(`
    INSERT INTO bill_match_log (
      workspace_key, daily_receipt_id, store_bill_id,
      match_priority, match_key, match_status,
      conflict_fields, matched_at, confirmed_by, confirmed_at, note
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const countStmt = db.prepare(
    `SELECT COUNT(1) AS n FROM bill_match_log WHERE workspace_key = ?`
  );
  const countByStatusStmt = db.prepare(`
    SELECT match_status AS status, match_priority AS priority, COUNT(1) AS n
    FROM bill_match_log WHERE workspace_key = ?
    GROUP BY match_status, match_priority
    ORDER BY status, priority
  `);
  const findByDailyStmt = db.prepare(`
    SELECT * FROM bill_match_log
    WHERE workspace_key = ? AND daily_receipt_id = ?
    ORDER BY matched_at DESC
  `);
  const findByBillStmt = db.prepare(`
    SELECT * FROM bill_match_log
    WHERE workspace_key = ? AND store_bill_id = ?
    ORDER BY matched_at DESC
  `);
  const deleteByDailyStmt = db.prepare(`
    DELETE FROM bill_match_log
    WHERE workspace_key = ? AND daily_receipt_id = ?
  `);
  const listStmt = db.prepare(`
    SELECT * FROM bill_match_log
    WHERE workspace_key = ?
      AND (? IS NULL OR match_status = ?)
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `);

  function mapRow(r) {
    if (!r) return null;
    return {
      id: r.id,
      workspaceKey: r.workspace_key,
      dailyReceiptId: r.daily_receipt_id,
      storeBillId: r.store_bill_id,
      matchPriority: r.match_priority,
      matchKey: r.match_key,
      matchStatus: r.match_status,
      conflictFields: r.conflict_fields ? safeJson(r.conflict_fields) : null,
      matchedAt: r.matched_at,
      confirmedBy: r.confirmed_by,
      confirmedAt: r.confirmed_at,
      note: r.note,
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
            r.dailyReceiptId == null ? null : Number(r.dailyReceiptId),
            r.storeBillId == null ? null : Number(r.storeBillId),
            Number(r.matchPriority),
            r.matchKey || null,
            r.matchStatus,
            r.conflictFields ? JSON.stringify(r.conflictFields) : null,
            r.matchedAt,
            r.confirmedBy || null,
            r.confirmedAt || null,
            r.note || null
          );
          inserted += 1;
        }
        return { inserted };
      }, { savepointName: 'bill_match_log_insert_many' });
    },
    countByWorkspace(workspaceKey) {
      return Number(countStmt.get(workspaceKey)?.n || 0);
    },
    countByStatus(workspaceKey) {
      return countByStatusStmt.all(workspaceKey);
    },
    // 轻量全量(不分页、不截断):桶汇总按 store_bill_id 归桶聚合用。
    iterateLight(workspaceKey) {
      return db.prepare(`
        SELECT id,
               store_bill_id AS storeBillId,
               daily_receipt_id AS dailyReceiptId,
               match_status AS matchStatus,
               match_priority AS matchPriority
        FROM bill_match_log WHERE workspace_key = ?
        ORDER BY id ASC
      `).all(workspaceKey);
    },
    findByDaily({ workspaceKey, dailyReceiptId }) {
      return findByDailyStmt.all(workspaceKey, Number(dailyReceiptId)).map(mapRow);
    },
    findByBill({ workspaceKey, storeBillId }) {
      return findByBillStmt.all(workspaceKey, Number(storeBillId)).map(mapRow);
    },
    deleteByDaily({ workspaceKey, dailyReceiptId }) {
      return deleteByDailyStmt.run(workspaceKey, Number(dailyReceiptId)).changes;
    },
    // A1(2026-07-16 同步一致性审计):锁定行的 matched 日志要留(merge 靠它建月度行),
    // 反查这些日志挂的账单 id → 引擎跳过不重匹配。
    listStoreBillIdsByDailyIds({ workspaceKey, dailyIds }) {
      if (!Array.isArray(dailyIds) || dailyIds.length === 0) return [];
      const ids = Array.from(new Set(dailyIds.map(Number).filter(Number.isFinite)));
      if (!ids.length) return [];
      const out = new Set();
      for (const chunk of chunkArray(ids, SQLITE_IN_CHUNK_SIZE)) {
        const placeholders = chunk.map(() => '?').join(',');
        for (const row of db.prepare(`
          SELECT DISTINCT store_bill_id AS id
          FROM bill_match_log
          WHERE workspace_key = ?
            AND daily_receipt_id IN (${placeholders})
            AND match_status = 'matched'
            AND store_bill_id IS NOT NULL
        `).all(workspaceKey, ...chunk)) {
          out.add(Number(row.id));
        }
      }
      return [...out];
    },
    listDailyIdsByStoreBillIds({ workspaceKey, storeBillIds }) {
      if (!Array.isArray(storeBillIds) || storeBillIds.length === 0) return [];
      const ids = Array.from(new Set(storeBillIds.map(Number).filter(Number.isFinite)));
      if (!ids.length) return [];
      const dailyIds = new Set();
      for (const chunk of chunkArray(ids, SQLITE_IN_CHUNK_SIZE)) {
        const placeholders = chunk.map(() => '?').join(',');
        for (const row of db.prepare(`
          SELECT DISTINCT daily_receipt_id AS id
          FROM bill_match_log
          WHERE workspace_key = ?
            AND store_bill_id IN (${placeholders})
            AND daily_receipt_id IS NOT NULL
        `).all(workspaceKey, ...chunk)) {
          dailyIds.add(Number(row.id));
        }
      }
      return Array.from(dailyIds);
    },
    deleteByStoreBillIds({ workspaceKey, storeBillIds }) {
      if (!Array.isArray(storeBillIds) || storeBillIds.length === 0) return 0;
      const ids = Array.from(new Set(storeBillIds.map(Number).filter(Number.isFinite)));
      if (!ids.length) return 0;
      let deleted = 0;
      for (const chunk of chunkArray(ids, SQLITE_IN_CHUNK_SIZE)) {
        const placeholders = chunk.map(() => '?').join(',');
        deleted += db.prepare(`
          DELETE FROM bill_match_log
          WHERE workspace_key = ? AND store_bill_id IN (${placeholders})
        `).run(workspaceKey, ...chunk).changes;
      }
      return deleted;
    },
    list({ workspaceKey, status = null, limit = 100, offset = 0 }) {
      return listStmt.all(workspaceKey, status, status, Number(limit), Number(offset)).map(mapRow);
    },
  };
}

function safeJson(value) {
  try { return JSON.parse(value); } catch { return null; }
}

module.exports = { createBillMatchLogRepository };
