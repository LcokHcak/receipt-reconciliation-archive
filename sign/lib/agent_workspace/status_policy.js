'use strict';

/**
 * 代理工作台 V2 — 高层审核状态策略(纯函数)。
 *
 * 架构文档 §5.1:一个客户只显示一个最高优先级状态,详情返回全部 reasonCodes。
 * 优先级固定,不随 UI 变化。票级两步流修订(2026-07-12):
 *   tour_pending 判据 = overlay.stanceLockedCount > 0(存在未表态小票),
 *   不再看组级 sourceGroup.tourConfirm。
 *
 * 显式口径(测试锁死):必审全部完成但组未结算 → needs_confirm + 'awaiting_settlement'
 * 原因码(它确实在等人工结算/背书,不能标 passed——passed 必须 settled)。
 */

const STATUS_PRIORITY = Object.freeze([
  'rephoto',
  'recognizing',
  'ready_for_sync',
  'tour_pending',
  'review_pending',
  'needs_remedy',
  'needs_confirm',
  'passed',
]);

// 主流程下一步(架构文档 §5.2):状态 → 动作键;深链构造在前端 links 模块。
const NEXT_ACTION_BY_STATUS = Object.freeze({
  rephoto: 'review_rephoto',
  recognizing: 'view_recognition',
  ready_for_sync: 'sync_to_batch',
  tour_pending: 'confirm_tour',
  review_pending: 'review_fields',
  needs_remedy: 'handle_remedy',
  needs_confirm: 'handle_confirm',
  passed: 'view_record',
});

const EMPTY_OVERLAY = Object.freeze({
  hasTasks: false,
  recognizingCount: 0,
  rephotoCount: 0,
  stanceLockedCount: 0,
  pendingReviewCount: 0,
});

function deriveCustomerStatus({ hasActiveBatch = false, overlay = null, settlementStatus = '' } = {}) {
  const o = overlay || EMPTY_OVERLAY;
  const settle = String(settlementStatus || '').trim();

  const allWorkDone = o.rephotoCount === 0
    && o.recognizingCount === 0
    && o.stanceLockedCount === 0
    && o.pendingReviewCount === 0;

  const awaitingSettlement = Boolean(hasActiveBatch) && allWorkDone && settle !== 'settled'
    && settle !== 'needs_remedy' && settle !== 'needs_confirm';

  const conditions = {
    rephoto: o.rephotoCount > 0,
    recognizing: o.recognizingCount > 0,
    ready_for_sync: !hasActiveBatch,
    tour_pending: o.stanceLockedCount > 0,
    review_pending: o.pendingReviewCount > 0,
    needs_remedy: settle === 'needs_remedy',
    needs_confirm: settle === 'needs_confirm' || awaitingSettlement,
    passed: Boolean(hasActiveBatch) && allWorkDone && settle === 'settled',
  };

  const reasonCodes = STATUS_PRIORITY.filter((key) => conditions[key]);
  if (awaitingSettlement) reasonCodes.push('awaiting_settlement');

  const reviewStatus = STATUS_PRIORITY.find((key) => conditions[key]) || 'review_pending';
  const nextAction = awaitingSettlement && reviewStatus === 'needs_confirm'
    ? 'settle_group'
    : (NEXT_ACTION_BY_STATUS[reviewStatus] || 'review_fields');

  return { reviewStatus, nextAction, reasonCodes };
}

module.exports = {
  STATUS_PRIORITY,
  NEXT_ACTION_BY_STATUS,
  deriveCustomerStatus,
};
