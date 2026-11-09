'use strict';

/**
 * Job audit surface — import_jobs (Sprint 1) + stage_jobs (Sprint 2 W4).
 *
 * Read-only inspection routes plus a single privileged escape hatch:
 * `POST /stage-jobs/:id/force-finish` for the operator to clear an
 * orphaned `running` row when a worker crashed mid-stage.
 */

const path = require('node:path');

const { workspaceKeyFromReq, clampInt } = require('./route_utils');

function registerJobRoutes({ app, guards, deps }) {
  const { read, finalReview } = guards;
  const { importJobRepo, stageJobRepo, stageLogService } = deps;

  // ── import jobs (Sprint 1) ────────────────────────────────
  app.get('/api/monthly/workspaces/:workspaceKey/import-jobs', ...read, (req, res) => {
    const workspaceKey = workspaceKeyFromReq(req);
    const limit = clampInt(req.query.limit, 1, 200, 50);
    const offset = clampInt(req.query.offset, 0, 1_000_000, 0);
    res.json({ jobs: importJobRepo.list({ workspaceKey, limit, offset }) });
  });

  app.get('/api/monthly/workspaces/:workspaceKey/import-jobs/:id', ...read, (req, res) => {
    const job = importJobRepo.findById(Number(req.params.id));
    if (!job) return res.status(404).json({ error: 'job not found' });
    res.json({ job });
  });

  // ── stage jobs (Sprint 2 W4, gated) ───────────────────────
  if (!stageJobRepo) return;

  app.get('/api/monthly/workspaces/:workspaceKey/stage-jobs', ...read, (req, res) => {
    const workspaceKey = workspaceKeyFromReq(req);
    const { stage = null, status = null } = req.query;
    const limit = clampInt(req.query.limit, 1, 200, 50);
    res.json({
      rows: stageJobRepo.listRecent({
        workspaceKey,
        stage: stage || null,
        status: status || null,
        limit,
      }),
    });
  });

  app.get(
    '/api/monthly/workspaces/:workspaceKey/stage-jobs/running',
    ...read,
    (req, res) => {
      const workspaceKey = workspaceKeyFromReq(req);
      res.json({
        rows: stageJobRepo.listRecent({
          workspaceKey, status: 'running', limit: 50,
        }),
      });
    }
  );

  app.get(
    '/api/monthly/workspaces/:workspaceKey/stage-jobs/:id/log',
    ...read,
    (req, res) => {
      if (!stageLogService) return res.status(404).json({ error: 'stage log service not configured' });
      const workspaceKey = workspaceKeyFromReq(req);
      const id = Number(req.params.id);
      const job = stageJobRepo.findById({ id });
      if (!job || job.workspaceKey !== workspaceKey) {
        return res.status(404).json({ error: 'stage_job not found' });
      }
      const filename = job.stats?.logFile;
      const filePath = stageLogService.resolveLogPath({ workspaceKey, filename });
      if (!filePath) return res.status(404).json({ error: 'stage log not found' });
      res.download(filePath, path.basename(filePath));
    }
  );

  app.post(
    '/api/monthly/workspaces/:workspaceKey/stage-jobs/:id/force-finish',
    ...finalReview,
    (req, res) => {
      const id = Number(req.params.id);
      const existing = stageJobRepo.findById({ id });
      if (!existing) return res.status(404).json({ error: 'stage_job not found' });
      if (existing.status !== 'running') {
        return res.status(400).json({ error: `already ${existing.status}` });
      }
      const changes = stageJobRepo.finish({
        id, status: 'cancelled',
        errorMessage: req.body?.reason || 'force_cancelled_by_operator',
      });
      res.json({
        ok: changes > 0,
        changes,
        cancelled: changes > 0,
        note: 'stage_job marked cancelled but underlying execution may still hold pipeline lock until completion',
      });
    }
  );
}

module.exports = { registerJobRoutes };
