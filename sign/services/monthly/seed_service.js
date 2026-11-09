'use strict';

const { buildScenario } = require('../../lib/monthly/seed/scenarios');

const ALLOWED_SCENARIOS = new Set([
  'all_matched',
  'field_conflict',
  'unmatched_unreceived',
  'cross_month',
  'large_volume',
]);

function createMonthlySeedService({
  workspaceService,
  workspaceResetService,
  dailyReceiptRepo,
  storeBillRepo,
  groupCodeRepo,
  receivedReceiptRepo,
} = {}) {
  if (!workspaceService || !workspaceResetService) {
    throw new Error('monthly_seed_service: workspaceService and workspaceResetService required');
  }
  if (!dailyReceiptRepo || !storeBillRepo || !groupCodeRepo || !receivedReceiptRepo) {
    throw new Error('monthly_seed_service: monthly repositories required');
  }

  async function seedWorkspace({
    workspaceKey,
    scenario,
    reset = true,
    count,
    operator = null,
  } = {}) {
    if (!ALLOWED_SCENARIOS.has(scenario)) {
      const error = new Error(`unsupported seed scenario: ${scenario}`);
      error.statusCode = 400;
      error.code = 'INVALID_SEED_SCENARIO';
      throw error;
    }

    const workspace = workspaceService.getOrThrow(workspaceKey);
    const parsed = workspaceService.parseKey(workspace.workspaceKey);
    if (!parsed.isDemo) {
      const error = new Error('seed_only_allowed_on_demo_workspaces');
      error.statusCode = 403;
      error.code = 'SEED_DEMO_ONLY';
      throw error;
    }

    const started = Date.now();
    if (reset !== false) {
      await workspaceResetService.clearWorkspace({
        workspaceKey: workspace.workspaceKey,
        confirmWorkspaceKey: workspace.workspaceKey,
        operator,
        backup: false,
        allowDemoOnly: true,
      });
    }

    const generated = buildScenario({
      scenario,
      workspaceKey: workspace.workspaceKey,
      count,
      importedAt: new Date().toISOString(),
    });

    const daily = dailyReceiptRepo.insertMany(generated.daily);
    const bill = storeBillRepo.insertMany(generated.bill);
    const groupCode = groupCodeRepo.insertMany(generated.groupCode);
    const received = receivedReceiptRepo.insertMany(generated.received);

    const response = {
      ok: true,
      scenario,
      inserted: {
        daily: daily.inserted,
        bill: bill.inserted,
        groupCode: groupCode.inserted,
        received: received.inserted,
      },
      durationMs: Date.now() - started,
    };
    if (generated.metadata) response.metadata = generated.metadata;
    return response;
  }

  return { seedWorkspace };
}

module.exports = {
  createMonthlySeedService,
};
