'use strict';

/**
 * Cross-check + departure-sync surface (Sprint 1).
 *
 * Lives off in its own file because these are the only routes that talk
 * to crossCheckService / departureSyncAuditRepo, and they have a totally
 * different mental model from the stage pipeline (sync vs. async).
 */

const {
  workspaceKeyFromReq,
  clampInt,
  ensureWorkspaceWritable,
  handleStageError,
} = require('./route_utils');
const { runStageWithLock } = require('../../lib/monthly_pipeline/stage_lock');

function registerCrossCheckRoutes({ app, guards, deps }) {
  const { read, intake, fieldReview } = guards;
  const { errorDetectionService, crossCheckService, departureSyncAuditRepo, workspaceService } = deps;

  app.post('/api/monthly/workspaces/:workspaceKey/cross-check', ...intake, async (req, res) => {
    try {
      const workspaceKey = workspaceKeyFromReq(req);
      ensureWorkspaceWritable({ workspaceService, workspaceKey });
      const withDepartureSync = Boolean(req.body?.withDepartureSync);
      const operator = req.user?.username || 'cross_check_api';
      const run = () => errorDetectionService.runCrossCheck({
        workspaceKey,
        withDepartureSync,
        triggeredBy: operator,
      });
      if (deps.stageJobRepo) {
        const { job, result } = await runStageWithLock({
          stageJobRepo: deps.stageJobRepo,
          pipelineLockService: deps.pipelineLockService || null,
          workspaceKey,
          stage: 'cross_check',
          operator,
          idempotencyKey: req.body?.idempotencyKey || req.query?.idempotencyKey || null,
          run,
        });
        return res.json({ job, ...result });
      }
      res.json(run());
    } catch (error) {
      handleStageError(res, error, 'cross-check failed');
    }
  });

  app.post(
    '/api/monthly/workspaces/:workspaceKey/departure-sync',
    ...fieldReview,
    async (req, res) => {
      if (!crossCheckService) {
        return res.status(503).json({ error: 'cross-check service not wired' });
      }
      try {
        const workspaceKey = workspaceKeyFromReq(req);
        ensureWorkspaceWritable({ workspaceService, workspaceKey });
        const operator = req.user?.username || 'departure_sync_api';
        const run = () => crossCheckService.run({
          workspaceKey,
          triggeredBy: operator,
        });
        if (deps.stageJobRepo) {
          const { job, result } = await runStageWithLock({
            stageJobRepo: deps.stageJobRepo,
            pipelineLockService: deps.pipelineLockService || null,
            workspaceKey,
            stage: 'cross_check',
            operator,
            idempotencyKey: req.body?.idempotencyKey || req.query?.idempotencyKey || null,
            run,
          });
          return res.json({ job, ...result });
        }
        res.json(run());
      } catch (error) {
        handleStageError(res, error, 'departure-sync failed');
      }
    }
  );

  app.get(
    '/api/monthly/workspaces/:workspaceKey/departure-sync/audit',
    ...read,
    (req, res) => {
      if (!departureSyncAuditRepo) {
        return res.json({ rows: [], total: 0 });
      }
      const workspaceKey = workspaceKeyFromReq(req);
      const limit = clampInt(req.query.limit, 1, 500, 100);
      const offset = clampInt(req.query.offset, 0, 1_000_000, 0);
      res.json({
        rows: departureSyncAuditRepo.list({ workspaceKey, limit, offset }),
        total: departureSyncAuditRepo.count(workspaceKey),
      });
    }
  );
}

module.exports = { registerCrossCheckRoutes };
