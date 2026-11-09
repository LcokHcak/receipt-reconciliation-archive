'use strict';

/**
 * actionable_pending_sql — 「活跃待审」谓词的单一来源。
 *
 * 背景:首页阻塞计数、账单核对徽标、交付前检查阻塞 三处都要回答同一个问题——
 * 「这条 open 的 pending_review 现在还算不算需要人处理的阻塞?」。此前这段 SQL 在
 * pending_review_repository 与 final_delivery_export_service 各写了一份(双实现),
 * 改一处漏一处就会口径分叉。统一到这里,两处 import 同一字符串。
 *
 * 用法:调用方把 pending_review 别名为 `pr`,拼成
 *   WHERE pr.workspace_key = ? AND pr.status='open' AND ${ACTIONABLE_PENDING_PREDICATE}
 *
 * 「孤儿自校正」:有些 open pending 的底层问题其实已被修好,只是记录没人关
 * (例:团号补救后台账变 matched;字段冲突在别处改对后台账 conflict_fields 清空)。
 * 这类记录不该再算活跃阻塞,否则会出现「首页/交付说有阻塞、对应处理页却是空的、
 * 运营看不到原因」。下面用「回查台账当前状态」把它们排除——计数立即自校正,
 * 不依赖重跑流水线(重跑只是顺手把记录 mark 成 resolved/superseded,不是前提)。
 */

// 团号阶段原因:台账行经补救/重分类后变 matched 或 skipped_mode_not_required → 失效。
const TOUR_STAGE_REASONS = Object.freeze([
  'tour_not_found',
  'tour_ambiguous',
  'tour_store_mismatch',
  'date_out_of_window',
  'agent_mismatch',
  'mode_unresolved',
]);
const TOUR_STAGE_REASON_LIST = TOUR_STAGE_REASONS.map((reason) => `'${reason}'`).join(',');

const ACTIONABLE_PENDING_PREDICATE = `
    NOT (
      pr.status = 'open'
      AND pr.source_table = 'daily_receipt_export'
      AND pr.reason_type IN (${TOUR_STAGE_REASON_LIST})
      AND EXISTS (
        SELECT 1
        FROM daily_receipt_export d
        WHERE d.workspace_key = pr.workspace_key
          AND d.id = pr.source_id
          AND d.tour_match_status IN ('matched', 'skipped_mode_not_required')
      )
    )
    AND NOT (
      pr.status = 'open'
      AND pr.source_table = 'store_bill'
      AND pr.reason_type = 'field_conflict'
      AND EXISTS (
        SELECT 1
        FROM daily_receipt_export d
        WHERE d.workspace_key = pr.workspace_key
          AND d.id = CAST(json_extract(pr.detail, '$.dailyReceiptId') AS INTEGER)
          AND (d.conflict_fields IS NULL OR d.conflict_fields = '')
          AND d.bill_match_status = 'matched'
      )
    )
`;

module.exports = { ACTIONABLE_PENDING_PREDICATE, TOUR_STAGE_REASONS };
