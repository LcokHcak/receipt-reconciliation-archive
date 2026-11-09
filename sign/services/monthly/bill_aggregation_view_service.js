'use strict';

/**
 * bill_aggregation_view_service (G19 改造 A)
 *
 * 账单匹配规则 docx 要求:以【小票号】为第一顺位匹配,统计与核对按"小票维度"。
 * 但 store_bill 是商品行级(同一小票号 N 个商品行)。本 service 只做"运行时聚合视图",
 * 不建真表(数据层不动),按 (workspace_key, receipt_no) GROUP BY 给 UI / 统计用。
 *
 * 注:聚合只读,绝不改 store_bill 数据。
 */
function createBillAggregationViewService({ db, storeBillRepo }) {
  if (!db) throw new Error('bill_aggregation_view_service: db required');
  if (!storeBillRepo) throw new Error('bill_aggregation_view_service: storeBillRepo required');

  const receiptLevelStmt = db.prepare(`
    SELECT receipt_no                       AS receiptNo,
           MIN(purchase_date)               AS purchaseDate,
           MAX(passport_no)                 AS passportNo,
           MAX(name)                        AS name,
           MAX(full_name)                   AS fullName,
           MAX(tour_no)                     AS tourNo,
           MAX(store_family)                AS storeFamily,
           MAX(store_branch)                AS storeBranch,
           MAX(mode)                        AS mode,
           MAX(mode_normalized)             AS modeNormalized,
           MAX(departure_date)              AS departureDate,
           SUM(COALESCE(net_krw, 0))        AS totalNetKrw,
           SUM(COALESCE(net_usd, 0))        AS totalNetUsd,
           SUM(COALESCE(gross_krw, 0))      AS totalGrossKrw,
           SUM(COALESCE(qty, 0))            AS totalQty,
           COUNT(*)                         AS itemCount,
           GROUP_CONCAT(id)                 AS detailIdsRaw
    FROM store_bill
    WHERE workspace_key = ?
      AND (? IS NULL OR store_family = ?)
      AND receipt_no IS NOT NULL
      AND receipt_no != ''
    GROUP BY receipt_no
    ORDER BY MIN(purchase_date) ASC, receipt_no ASC
  `);

  const matchStatusStmt = db.prepare(`
    SELECT match_status AS matchStatus, COUNT(*) AS n
    FROM bill_match_log
    WHERE workspace_key = ?
      AND store_bill_id IN (
        SELECT id FROM store_bill WHERE workspace_key = ? AND receipt_no = ?
      )
    GROUP BY match_status
  `);

  /**
   * 按小票号聚合 store_bill。
   * @param {string} workspaceKey
   * @param {{ family?: string|null }} [opts] family 即 store_family(业务桶)过滤,可空
   * @returns {Array<object>} 每行 = 1 张小票
   */
  function getReceiptLevelView(workspaceKey, { family = null } = {}) {
    if (!workspaceKey) throw new Error('workspaceKey required');
    const fam = family || null;
    const rows = receiptLevelStmt.all(workspaceKey, fam, fam);
    return rows.map((row) => ({
      ...row,
      detailIds: splitIds(row.detailIdsRaw),
      detailIdsRaw: undefined,
    }));
  }

  /**
   * 单张小票的商品行明细(UI 展开看商品用)。
   */
  function getReceiptDetail(workspaceKey, receiptNo) {
    if (!workspaceKey) throw new Error('workspaceKey required');
    if (!receiptNo) return [];
    return storeBillRepo.findByReceipt({ workspaceKey, receiptNo });
  }

  /**
   * 单张小票下所有商品行的匹配状态聚合。
   * @returns {Array<{ matchStatus: string, n: number }>}
   */
  function getReceiptMatchStatus(workspaceKey, receiptNo) {
    if (!workspaceKey) throw new Error('workspaceKey required');
    if (!receiptNo) return [];
    return matchStatusStmt.all(workspaceKey, workspaceKey, receiptNo);
  }

  return { getReceiptLevelView, getReceiptDetail, getReceiptMatchStatus };
}

function splitIds(raw) {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
}

module.exports = { createBillAggregationViewService };
