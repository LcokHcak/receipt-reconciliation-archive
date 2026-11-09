'use strict';

/**
 * derivation_recompute_service — 派生新鲜度的状态机 + 按需重算编排。
 *
 * 业务原则:monthly_data / 交付包 = 「已核对台账 + 最新账单 + 最新配置」的纯派生结果,
 * 永不滞后。任何上游变更(账单/团号/模式/扣点/台账)标脏对应阶段;进最终核对页 / 出包前
 * ensureFresh 从最浅脏阶段往下重跑到 merge,导出永远跟最新匹配结果走。
 *
 * 脏阶段:tour_match < bill_match < merge(见 lib/monthly_pipeline/derivation_stages)。
 *   markDirty       上游变更时调,取最浅
 *   afterStageRun   某阶段(手点或编排)跑完后推进:downstream 变脏,更浅的保留
 *   ensureFresh     从 dirty_from 跑到 merge,清零
 */

const {
  shallower, afterStageRun, stagesToRun,
} = require('../../lib/monthly_pipeline/derivation_stages');

function createDerivationRecomputeService({
  workspaceRepo,
  monthlyDataRepo,
  tourMatchService,
  billMatchService,
  mergeService,
}) {
  if (!workspaceRepo) throw new Error('derivation_recompute_service: workspaceRepo required');

  function getDirtyFrom(workspaceKey) {
    return workspaceRepo.getDerivationDirtyFrom(workspaceKey);
  }

  /** 上游变更标脏(取最浅)。stage ∈ tour_match|bill_match|merge。 */
  function markDirty(workspaceKey, stage) {
    if (!workspaceKey || !stage) return null;
    const cur = workspaceRepo.getDerivationDirtyFrom(workspaceKey);
    const next = shallower(cur, stage);
    if (next !== cur) workspaceRepo.setDerivationDirtyFrom({ workspaceKey, dirtyFrom: next });
    return next;
  }

  /** 某阶段跑完(手点阶段按钮 / 编排内部)后推进脏标记。 */
  function onStageComplete(workspaceKey, stage) {
    if (!workspaceKey || !stage) return null;
    const cur = workspaceRepo.getDerivationDirtyFrom(workspaceKey);
    const next = afterStageRun(cur, stage);
    if (next !== cur) workspaceRepo.setDerivationDirtyFrom({ workspaceKey, dirtyFrom: next });
    return next;
  }

  function markFresh(workspaceKey) {
    workspaceRepo.setDerivationDirtyFrom({ workspaceKey, dirtyFrom: null });
  }

  /** 本月是否需要重算(脏 or 从没生成过)。 */
  function isStale(workspaceKey) {
    if (workspaceRepo.getDerivationDirtyFrom(workspaceKey)) return true;
    return Number(monthlyDataRepo?.countByWorkspace?.(workspaceKey) || 0) === 0;
  }

  /**
   * 从最浅脏阶段重跑到 merge,跑完清零。幂等:各阶段服务自身幂等(清旧重建)。
   * 注意:调用方负责并发锁(pipeline lock),本服务只编排顺序。
   * @returns {{ ran: string[], dirtyFrom: string|null }}
   */
  async function ensureFresh({ workspaceKey, stageJobId = null, stageLogService = null }) {
    if (!workspaceKey) throw new Error('workspaceKey required');
    let dirtyFrom = workspaceRepo.getDerivationDirtyFrom(workspaceKey);
    const monthlyEmpty = Number(monthlyDataRepo?.countByWorkspace?.(workspaceKey) || 0) === 0;
    // 从没生成过 → 至少 merge;有脏标记按脏标记走(更浅优先)
    if (monthlyEmpty) dirtyFrom = shallower(dirtyFrom, 'merge');
    if (!dirtyFrom) return { ran: [], dirtyFrom: null };

    const ran = [];
    let mergeStats = null;
    for (const stage of stagesToRun(dirtyFrom)) {
      if (stage === 'tour_match' && tourMatchService) {
        await tourMatchService.run({ workspaceKey });
      } else if (stage === 'bill_match' && billMatchService) {
        await billMatchService.run({ workspaceKey, stageJobId, stageLogService });
      } else if (stage === 'merge' && mergeService) {
        // 0729 静默排查:mergeService.run() 的统计原来被整个丢掉(await 后不接返回值),
        // 其中「因归不了桶而被丢出合并」的三个计数就此消失 —— 行从 monthly_data 里没了,
        // 界面上零痕迹。多数情况它是对的(那些渠道本就不走四桶交付),但"本该如此"
        // 和"归类坏了"长得一模一样,不交出来就永远分不出。
        mergeStats = await mergeService.run({ workspaceKey });
      } else {
        continue;
      }
      ran.push(stage);
    }
    workspaceRepo.setDerivationDirtyFrom({ workspaceKey, dirtyFrom: null });
    return { ran, dirtyFrom, mergeStats };
  }

  return { getDirtyFrom, markDirty, onStageComplete, markFresh, isStale, ensureFresh };
}

module.exports = { createDerivationRecomputeService };
