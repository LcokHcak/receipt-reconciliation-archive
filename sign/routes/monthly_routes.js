'use strict';

/**
 * Monthly pipeline routes — orchestrator.
 *
 * Each surface lives in its own module under routes/monthly/*. This file
 * just sanity-checks the core deps, builds the role guards once, then
 * lets every sub-router pull what it needs from a shared deps bag.
 *
 * Why a single bag instead of explicit deps per sub-router: Sprint 2
 * grew to ~30 deps and constructor signature churn dominated diffs. The
 * shared bag keeps that pain out of route-only changes.
 */

const { buildProtect } = require('./monthly/route_utils');
const { registerWorkspaceRoutes } = require('./monthly/workspace_routes');
const { registerImportRoutes } = require('./monthly/import_routes');
const { registerListingRoutes } = require('./monthly/listing_routes');
const { registerCrossCheckRoutes } = require('./monthly/cross_check_routes');
const { registerStageRoutes } = require('./monthly/stage_routes');
const { registerExportRoutes } = require('./monthly/export_routes');
const { registerJobRoutes } = require('./monthly/job_routes');
const { registerBadcaseRoutes } = require('./monthly/badcase_routes');
const { registerReconciliationRoutes } = require('./monthly/reconciliation_routes');
const { createBatchOperationsRoutes } = require('./monthly/batch_operations_routes');
const { registerConfigRoutes } = require('./monthly/config_routes');
const { registerManualEntryRoutes } = require('./monthly/manual_entry_routes');
const { registerV2OrphanRoutes } = require('./monthly/v2_orphan_routes');
const { registerBillMatchRoutes } = require('./monthly/bill_match_routes');

function createMonthlyRoutes(opts = {}) {
  if (!opts.workspaceService || !opts.importService || !opts.errorDetectionService) {
    throw new Error('services required');
  }

  // Single deps bag passed to every sub-router. Optional repos / services
  // default to null upstream; sub-routers gate routes that need them.
  const deps = Object.freeze({ ...opts });

  return {
    register(app, auth) {
      const guards = buildProtect(auth);
      const ctx = { app, guards, deps };
      registerWorkspaceRoutes(ctx);
      registerImportRoutes(ctx);
      registerListingRoutes(ctx);
      registerCrossCheckRoutes(ctx);
      registerStageRoutes(ctx);
      registerExportRoutes(ctx);
      registerJobRoutes(ctx);
      registerBadcaseRoutes(ctx);
      registerReconciliationRoutes(ctx);
      registerConfigRoutes(ctx);
      registerManualEntryRoutes(ctx);
      registerV2OrphanRoutes(ctx);
      registerBillMatchRoutes(ctx);

      // 批量操作路由
      if (deps.batchOperationsService) {
        const batchOpsRoutes = createBatchOperationsRoutes({
          batchOperationsService: deps.batchOperationsService,
          workspaceService: deps.workspaceService,
          auth,
        });
        batchOpsRoutes.register(app);
      }
    },
  };
}

module.exports = { createMonthlyRoutes };
