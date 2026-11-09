import { hasSevereReviewReason } from './reviewReasons';

/**
 * 三档复核(操作员诉求:大概率没问题简略看 / 可能有问题再审 / 看不清重拍)。
 * 从 task 现有字段 needsReview + reviewReasons + docTypeConfidence 推导,
 * paddle / qwen 两后端都设这些字段,故两种模式通用。
 *
 *   high   无 needsReview → 一眼过(可批量通过)
 *   low    严重 reason(图糊/切坏/识别失败/未识别出单据)或置信度极低 → 建议重拍
 *   medium 其余 needsReview(字段级,可编辑修正)→ 重点看
 *
 * @param {object} task
 * @returns {'high'|'medium'|'low'}
 */
export function reviewTier(task = {}) {
  const reasons = Array.isArray(task?.reviewReasons) ? task.reviewReasons : [];
  const needsReview = Boolean(task?.needsReview) || reasons.length > 0;
  if (!needsReview) return 'high';
  if (hasSevereReviewReason(reasons)) return 'low';
  const conf = Number(task?.docTypeConfidence);
  if (Number.isFinite(conf) && conf > 0 && conf < 0.4) return 'low';
  return 'medium';
}

// 档位展示元数据。0729「绿色整套删掉」硬规则:高档=一眼过=不用管,归「其余」→ 灰阶
// (原绿 dot #0F6E56/bg #E1F5EE)。中/低档是**要处理**的,按规则保留琥珀/红。
// 三档仍两两可辨(灰/琥珀/红),色弱也分得开;而且灰色不会再和「已通过」抢注意力。
export const REVIEW_TIER_META = {
  high: { key: 'high', label: '高 · 一眼过', dot: '#94A3B8', bg: '#F1F5F9', border: '#CBD5E1', text: '#475569' },
  medium: { key: 'medium', label: '中 · 重点看', dot: '#BA7517', bg: '#FAEEDA', border: '#FAC775', text: '#633806' },
  low: { key: 'low', label: '低 · 建议重拍', dot: '#A32D2D', bg: '#FCEBEB', border: '#F7C1C1', text: '#791F1F' },
};

export function reviewTierMeta(tier) {
  return REVIEW_TIER_META[tier] || REVIEW_TIER_META.high;
}
