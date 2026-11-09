'use strict';

/**
 * 派生链阶段顺序 + 脏标记状态机的纯逻辑(无 IO)。
 *
 * 链:tour_match → bill_match → merge。dirty_from = 最浅需重跑的阶段;null = 新鲜。
 * 输入变更标脏(取最浅);某阶段跑完按顺序推进(消化掉它这一级)。
 */

const STAGE_ORDER = Object.freeze(['tour_match', 'bill_match', 'merge']);

function level(stage) {
  const i = STAGE_ORDER.indexOf(stage);
  return i === -1 ? Infinity : i;
}

/** 两个脏阶段取「更浅」的(null 视为最深/无)。 */
function shallower(a, b) {
  if (!a) return b || null;
  if (!b) return a || null;
  return level(a) <= level(b) ? a : b;
}

function nextAfter(stage) {
  return STAGE_ORDER[level(stage) + 1] || null;
}

/**
 * 某阶段跑完后的新 dirty_from。规则(对手点单个阶段也稳健):
 * - 跑完阶段 S → S 之后的阶段输入变了、变脏 → 至少 nextAfter(S)。
 * - 但若已有更浅的脏阶段(S 之前的某阶段还没跑)→ 保留那个更浅的(它还得先跑)。
 * 例:改了模式(dirty=tour)却只手点 bill_match → 仍 dirty=tour(tour 没重跑)。
 * 例:手点 bill_match(dirty=null)→ merge 变脏(匹配变了,合并结果过期)。
 * 例:跑完 merge → null(新鲜)。
 */
function afterStageRun(dirtyFrom, completedStage) {
  if (dirtyFrom && level(dirtyFrom) < level(completedStage)) return dirtyFrom;
  return nextAfter(completedStage);
}

/** ensureFresh 要按顺序跑的阶段:从 dirty_from 起到 merge 止。 */
function stagesToRun(dirtyFrom) {
  if (!dirtyFrom) return [];
  const start = level(dirtyFrom);
  if (!Number.isFinite(start)) return [];
  return STAGE_ORDER.slice(start);
}

module.exports = { STAGE_ORDER, level, shallower, nextAfter, afterStageRun, stagesToRun };
