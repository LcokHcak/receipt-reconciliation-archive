'use strict';

/**
 * Stage pipeline surface — tour-match / bill-match / merge / second-pass.
 *
 * Every stage is a POST that:
 *   1. resolves the workspace
 *   2. (if wired) acquires a stage_job lock via runStageWithLock
 *   3. invokes the service
 *   4. returns { job?, ...stats } on success or 409/500 via handleStageError
 *
 * The lock guarantees a single workspace can't have two concurrent runs
 * of the same stage stomping on each other. Without stageJobRepo wired
 * (tests / dev), routes fall back to direct invocation.
 */

const { runStageWithLock } = require('../../lib/monthly_pipeline/stage_lock');
const {
  workspaceKeyFromReq,
  clampInt,
  handleStageError,
  ensureWorkspaceWritable,
  createStagePreconditionError,
} = require('./route_utils');

function buildStageRunner({
  stage, defaultOperator, deps, runImpl, precondition = null,
}) {
  return async (req, res) => {
    try {
      const workspaceKey = workspaceKeyFromReq(req);
      ensureWorkspaceWritable({ workspaceService: deps.workspaceService, workspaceKey });
      if (precondition) precondition({ workspaceKey, deps });
      const operator = req.user?.username || defaultOperator;
      const idempotencyKey = extractIdempotencyKey(req);
      const ctx = { workspaceKey, operator, req };
      if (deps.stageJobRepo) {
        const { job, result } = await runStageWithLock({
          stageJobRepo: deps.stageJobRepo,
          pipelineLockService: deps.pipelineLockService || null,
          workspaceKey, stage, operator, idempotencyKey,
          run: ({ job: stageJob }) => runImpl({
            ...ctx,
            stageJobId: stageJob?.id || null,
            stageLogService: deps.stageLogService || null,
          }),
          afterSuccess: ({ job: stageJob, result }) => {
            markDerivationAfterStage(deps, workspaceKey, stage);
            return attachStageLog({
              deps, workspaceKey, stage, operator, job: stageJob, result,
            });
          },
        });
        return res.json({ job, ...result });
      }
      const result = await runImpl(ctx);
      markDerivationAfterStage(deps, workspaceKey, stage);
      res.json(result);
    } catch (error) {
      handleStageError(res, error, `${stage} failed`);
    }
  };
}

// 阶段跑完后推进派生脏标记:tour/bill/merge 走状态机推进(downstream 变脏);
// second_pass 改了匹配 → 直接标 merge 脏。让"改完→出包"永远拿最新结果。
function markDerivationAfterStage(deps, workspaceKey, stage) {
  const svc = deps.derivationRecomputeService;
  if (!svc) return;
  try {
    if (stage === 'second_pass') svc.markDirty(workspaceKey, 'merge');
    else svc.onStageComplete(workspaceKey, stage);
  } catch {
    // 标记失败不影响阶段结果本身(下次进核对页/出包仍会按需校正)
  }
}

function extractIdempotencyKey(req) {
  // Clients may send idempotencyKey to make repeated stage button clicks
  // reuse the same stage_job instead of starting duplicate work.
  const value = req.body?.idempotencyKey ?? req.query?.idempotencyKey;
  const text = String(value || '').trim();
  return text || null;
}

function attachStageLog({ deps, workspaceKey, stage, operator, job, result }) {
  if (!deps.stageLogService || result?.logFile) return result;
  const meta = deps.stageLogService.writeStageSummary({
    workspaceKey,
    stage,
    stageJobId: job?.id || null,
    startedAt: job?.startedAt || null,
    operator,
    result,
  });
  return { ...result, logFile: meta.logFile };
}

function registerStageRoutes({ app, guards, deps }) {
  const { intake } = guards;
  const {
    tourMatchService, billMatchService, mergeService, secondPassMissingService,
  } = deps;

  if (tourMatchService) {
    app.post(
      '/api/monthly/workspaces/:workspaceKey/stages/tour-match',
      ...intake,
      buildStageRunner({
        stage: 'tour_match',
        defaultOperator: 'tour_match_api',
        deps,
        runImpl: ({ workspaceKey, req }) => {
          const scope = String(req.body?.scope || '').trim();
          let sinceIso = null;
          if (scope === 'today') {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            sinceIso = today.toISOString();
          } else if (req.body?.sinceIso) {
            sinceIso = String(req.body.sinceIso);
          }
          return tourMatchService.run({ workspaceKey, sinceIso });
        },
      })
    );
  }

  // 换团号表 / 用当前表后,重新匹配"某批次"的未命中行:
  //   ① reset 该批次待补救行 → pending(matched / 别批次 / 缺日期不动)
  //   ② tourMatchService.run({ workspaceKey, batchId }) 只扫该批次 pending,用最新 batch_group_code 重跑
  // 复用 stage:'tour_match' runner → 跑完自动标脏下游 bill_match;并发锁与 tour-match 共用。
  if (tourMatchService) {
    app.post(
      '/api/monthly/workspaces/:workspaceKey/stages/tour-rematch',
      ...intake,
      buildStageRunner({
        stage: 'tour_match',
        defaultOperator: 'tour_rematch_api',
        deps,
        runImpl: async ({ workspaceKey, req }) => {
          const batchId = String(req.body?.batchId || '').trim();
          if (!batchId) throw createStagePreconditionError('请先选择要重新匹配的批次');
          const resetCount = deps.dailyReceiptRepo?.resetTourMatchForRematch
            ? deps.dailyReceiptRepo.resetTourMatchForRematch({ workspaceKey, batchId })
            : 0;
          const result = await tourMatchService.run({ workspaceKey, batchId });
          return { ...result, batchId, resetCount };
        },
      })
    );
  }

  if (billMatchService) {
    app.post(
      '/api/monthly/workspaces/:workspaceKey/stages/bill-match',
      ...intake,
      buildStageRunner({
        stage: 'bill_match',
        defaultOperator: 'bill_match_api',
        deps,
        precondition: ({ workspaceKey, deps }) => {
          if (Number(deps.storeBillRepo?.countByWorkspace?.(workspaceKey) || 0) <= 0) {
            throw createStagePreconditionError('先导入店铺账单，再运行账单匹配');
          }
        },
        runImpl: ({ workspaceKey, stageJobId, stageLogService }) => billMatchService.run({
          workspaceKey,
          stageJobId,
          stageLogService,
        }),
      })
    );
  }

  if (mergeService) {
    app.post(
      '/api/monthly/workspaces/:workspaceKey/stages/merge',
      ...intake,
      buildStageRunner({
        stage: 'merge',
        defaultOperator: 'merge_api',
        deps,
        precondition: ({ workspaceKey, deps }) => {
          if (Number(deps.billMatchLogRepo?.countByWorkspace?.(workspaceKey) || 0) <= 0) {
            throw createStagePreconditionError('先运行账单匹配，再合并月度数据');
          }
          deps.modeConfigService?.validateMergeReady?.(workspaceKey);
        },
        runImpl: ({ workspaceKey }) => mergeService.run({ workspaceKey }),
      })
    );
  }

  if (secondPassMissingService) {
    app.post(
      '/api/monthly/workspaces/:workspaceKey/stages/second-pass',
      ...intake,
      buildStageRunner({
        stage: 'second_pass',
        defaultOperator: 'second_pass_api',
        deps,
        runImpl: ({ workspaceKey, req }) => secondPassMissingService.run({
          workspaceKey,
          dateWindowDays: clampInt(req.body?.dateWindowDays, 0, 30, 2),
        }),
      })
    );
  }

  // 按需重算:进最终核对页 / 出包前调用。若 stale(脏 or 从没生成过)就从最浅脏阶段
  // 跑到 merge,整段持一把 pipeline 锁(内部直调服务,不嵌套 stage 锁);新鲜则 no-op。
  if (deps.derivationRecomputeService) {
    app.post(
      '/api/monthly/workspaces/:workspaceKey/stages/ensure-fresh',
      ...intake,
      buildStageRunner({
        stage: 'recompute',
        defaultOperator: 'ensure_fresh_api',
        deps,
        runImpl: ({ workspaceKey, stageJobId, stageLogService }) => deps.derivationRecomputeService.ensureFresh({
          workspaceKey, stageJobId, stageLogService,
        }),
      })
    );
  }
}

module.exports = { registerStageRoutes };
