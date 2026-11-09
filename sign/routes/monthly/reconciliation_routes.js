'use strict';

/**
 * Monthly reconciliation surface.
 *
 * A read-only API for the monthly overview to show calculation口径,
 * formula checks, source-row traces, and recent operation snapshots.
 */

const { workspaceKeyFromReq, clampInt } = require('./route_utils');

function registerReconciliationRoutes({ app, guards, deps }) {
  const { read } = guards;
  const { workspaceService, monthlyReconciliationService } = deps;

  app.get('/api/monthly/workspaces/:workspaceKey/reconciliation', ...read, (req, res) => {
    if (!monthlyReconciliationService || typeof monthlyReconciliationService.build !== 'function') {
      return res.status(503).json({ error: 'monthly reconciliation not available' });
    }
    try {
      const workspaceKey = workspaceKeyFromReq(req);
      const workspace = workspaceService.getOrThrow(workspaceKey);
      const isTestMode = workspaceService.isTestWorkspace(workspace.workspaceKey);
      const detailLimit = clampInt(req.query.detailLimit, 1, 100, 20);
      res.json({
        ...monthlyReconciliationService.build({ workspaceKey: workspace.workspaceKey, detailLimit }),
        isTestMode,
      });
    } catch (error) {
      res.status(error?.statusCode || 404).json({ error: error?.message || 'reconciliation failed' });
    }
  });
}

module.exports = { registerReconciliationRoutes };
