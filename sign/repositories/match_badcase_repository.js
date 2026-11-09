'use strict';

const { runSqliteTransaction } = require('../lib/storage/sqlite_transaction');
const { chunkArray } = require('../lib/workbench_utils');

const SQLITE_IN_CHUNK_SIZE = 500;

/**
 * match_badcase repository — 内部反馈闭环（A1）。
 *
 * 每次匹配阶段对一条 daily/bill 做出非"完美匹配"的决策时，落一条现场快照：
 * 输入、归一化结果、候选、决策、走的规则。运营在 UI 上看到错的，写一句
 * user_note + 给个 verdict（这是错的 / 应该匹配上 / 可接受），开发就能
 * 用一条 SQL 找出所有"运营标记为错"的样本去对照规则。
 *
 * 配合 RULE_VERSION 常量（A3），可以追"昨天还对今天就错了"这种问题。
 */

const KIND = Object.freeze({
  TOUR_NOT_FOUND: 'tour_not_found',
  AGENT_MISMATCH: 'agent_mismatch',
  MODE_UNRESOLVED: 'mode_unresolved',
  DATE_OUT_OF_WINDOW: 'date_out_of_window',
  AMBIGUOUS_MATCH: 'ambiguous_match',
  FUZZY_MATCH: 'fuzzy_match',
  FIELD_CONFLICT: 'field_conflict',
  UNMATCHED: 'unmatched',
  MANUAL: 'manual',
});

const VERDICT = Object.freeze({
  PENDING: 'pending',
  WRONG_MATCH: 'wrong_match',
  SHOULD_MATCH: 'should_match',
  ACCEPTABLE: 'acceptable',
});

function createMatchBadcaseRepository({ db }) {
  if (!db) throw new Error('db is required');

  const insertStmt = db.prepare(`
    INSERT INTO match_badcase (
      workspace_key, stage, kind, rule_version,
      source_table, source_id, daily_receipt_id, store_bill_id,
      receipt_no, tour_no, passport_no, name, purchase_date,
      snapshot, user_note, user_verdict, reviewed_by, reviewed_at,
      created_at, stage_job_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const updateVerdictStmt = db.prepare(`
    UPDATE match_badcase
    SET user_note = ?, user_verdict = ?, reviewed_by = ?, reviewed_at = ?
    WHERE id = ? AND workspace_key = ?
  `);

  const listStmt = db.prepare(`
    SELECT * FROM match_badcase
    WHERE workspace_key = ?
      AND (? IS NULL OR stage = ?)
      AND (? IS NULL OR kind = ?)
      AND (? IS NULL OR user_verdict = ?)
      AND (? IS NULL OR rule_version = ?)
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `);
  const countStmt = db.prepare(`
    SELECT COUNT(1) AS n FROM match_badcase
    WHERE workspace_key = ?
      AND (? IS NULL OR stage = ?)
      AND (? IS NULL OR kind = ?)
      AND (? IS NULL OR user_verdict = ?)
      AND (? IS NULL OR rule_version = ?)
  `);
  const findByIdStmt = db.prepare(
    `SELECT * FROM match_badcase WHERE id = ? AND workspace_key = ?`
  );
  const deleteByDailyStmt = db.prepare(`
    DELETE FROM match_badcase
    WHERE workspace_key = ? AND daily_receipt_id = ?
  `);
  const summaryStmt = db.prepare(`
    SELECT stage, kind, COUNT(1) AS n
    FROM match_badcase
    WHERE workspace_key = ?
    GROUP BY stage, kind
    ORDER BY n DESC
  `);
  const verdictBreakdownStmt = db.prepare(`
    SELECT user_verdict AS verdict, COUNT(1) AS n
    FROM match_badcase
    WHERE workspace_key = ?
    GROUP BY user_verdict
  `);

  function mapRow(r) {
    if (!r) return null;
    let snapshot = null;
    if (r.snapshot) {
      try { snapshot = JSON.parse(r.snapshot); } catch { snapshot = null; }
    }
    return {
      id: r.id,
      workspaceKey: r.workspace_key,
      stage: r.stage,
      kind: r.kind,
      ruleVersion: r.rule_version,
      sourceTable: r.source_table,
      sourceId: r.source_id,
      dailyReceiptId: r.daily_receipt_id,
      storeBillId: r.store_bill_id,
      receiptNo: r.receipt_no,
      tourNo: r.tour_no,
      passportNo: r.passport_no,
      name: r.name,
      purchaseDate: r.purchase_date,
      snapshot,
      userNote: r.user_note,
      userVerdict: r.user_verdict,
      reviewedBy: r.reviewed_by,
      reviewedAt: r.reviewed_at,
      createdAt: r.created_at,
      stageJobId: r.stage_job_id,
    };
  }

  return {
    KIND,
    VERDICT,

    /**
     * 批量写入。badcase 是 fire-and-forget 的快照，错了不应阻断主流程，
     * 调用方可以包 try/catch 但失败也只是丢一条诊断信息。
     */
    insertMany(rows) {
      if (!Array.isArray(rows) || rows.length === 0) return { inserted: 0 };
      return runSqliteTransaction(db, () => {
        let inserted = 0;
        for (const r of rows) {
          insertStmt.run(
            r.workspaceKey,
            r.stage,
            r.kind,
            r.ruleVersion || null,
            r.sourceTable || null,
            r.sourceId == null ? null : Number(r.sourceId),
            r.dailyReceiptId == null ? null : Number(r.dailyReceiptId),
            r.storeBillId == null ? null : Number(r.storeBillId),
            r.receiptNo || null,
            r.tourNo || null,
            r.passportNo || null,
            r.name || null,
            r.purchaseDate || null,
            r.snapshot ? JSON.stringify(r.snapshot) : '{}',
            r.userNote || null,
            r.userVerdict || 'pending',
            r.reviewedBy || null,
            r.reviewedAt || null,
            r.createdAt,
            r.stageJobId == null ? null : Number(r.stageJobId)
          );
          inserted += 1;
        }
        return { inserted };
      }, { savepointName: 'match_badcase_insert_many' });
    },

    setVerdict({ id, workspaceKey, userNote, userVerdict, reviewedBy, reviewedAt }) {
      return updateVerdictStmt.run(
        userNote || null,
        userVerdict || 'pending',
        reviewedBy || null,
        reviewedAt || new Date().toISOString(),
        Number(id),
        workspaceKey
      ).changes;
    },

    findById({ id, workspaceKey }) {
      return mapRow(findByIdStmt.get(Number(id), workspaceKey));
    },

    deleteByDaily({ workspaceKey, dailyReceiptId }) {
      return deleteByDailyStmt.run(workspaceKey, Number(dailyReceiptId)).changes;
    },
    deleteByStoreBillIds({ workspaceKey, storeBillIds }) {
      if (!Array.isArray(storeBillIds) || storeBillIds.length === 0) return 0;
      const ids = Array.from(new Set(storeBillIds.map(Number).filter(Number.isFinite)));
      if (!ids.length) return 0;
      let deleted = 0;
      for (const chunk of chunkArray(ids, SQLITE_IN_CHUNK_SIZE)) {
        const placeholders = chunk.map(() => '?').join(',');
        deleted += db.prepare(`
          DELETE FROM match_badcase
          WHERE workspace_key = ? AND store_bill_id IN (${placeholders})
        `).run(workspaceKey, ...chunk).changes;
      }
      return deleted;
    },

    list({ workspaceKey, stage = null, kind = null, verdict = null, ruleVersion = null, limit = 100, offset = 0 }) {
      return listStmt.all(
        workspaceKey,
        stage, stage,
        kind, kind,
        verdict, verdict,
        ruleVersion, ruleVersion,
        Number(limit), Number(offset)
      ).map(mapRow);
    },

    count({ workspaceKey, stage = null, kind = null, verdict = null, ruleVersion = null }) {
      return Number(countStmt.get(
        workspaceKey,
        stage, stage,
        kind, kind,
        verdict, verdict,
        ruleVersion, ruleVersion
      )?.n || 0);
    },

    summary(workspaceKey) {
      return summaryStmt.all(workspaceKey);
    },

    verdictBreakdown(workspaceKey) {
      return verdictBreakdownStmt.all(workspaceKey);
    },
  };
}

module.exports = {
  createMatchBadcaseRepository,
  KIND,
  VERDICT,
};
