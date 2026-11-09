const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildScenarioPlan,
  parseArgs,
  summarizeApiPayload,
  usage,
} = require('../scripts/run_ui_chaos_probe');

test('chaos scenario plan covers manual review, workspace, page, customer, and task flows', () => {
  const plan = buildScenarioPlan({
    workspace: 'stress-20260501-200',
  });

  const ids = plan.map((scenario) => scenario.id);

  assert.deepEqual(ids, [
    'page-mode-hop',
    'workspace-modal-address-edit',
    'workspace-switch-existing',
    'customer-detail-hop',
    'customer-image-buttons',
    'batch-open-and-group-hop',
    'review-field-edit',
    'review-action-buttons',
    'cross-page-customer-task-hop',
  ]);
  assert.equal(plan.every((scenario) => scenario.label && scenario.expectation), true);
  assert.equal(plan.find((scenario) => scenario.id === 'workspace-modal-address-edit').tags.includes('new-directory-address'), true);
  assert.equal(plan.find((scenario) => scenario.id === 'review-field-edit').tags.includes('field-edit'), true);
});

test('API payload summaries keep diagnostic counts without dumping full response bodies', () => {
  const summary = summarizeApiPayload({
    batches: [
      { id: 'batch_a', machineState: 'completed', counts: { total: 2 } },
      { id: 'batch_b', machineState: 'processing', counts: { total: 3 } },
    ],
    workspaces: ['w1', 'w2'],
    customers: [{ customerId: 'CL1', images: [{}, {}] }],
  });

  assert.deepEqual(summary, {
    batchCount: 2,
    batchIds: ['batch_a', 'batch_b'],
    batchStates: ['completed', 'processing'],
    batchCounts: [{ total: 2 }, { total: 3 }],
    workspaceCount: 2,
    workspaces: ['w1', 'w2'],
    customerCount: 1,
    imageCount: 2,
  });
});

test('chaos CLI supports read-only locked workspace probes', () => {
  const args = parseArgs([
    'node',
    'run_ui_chaos_probe.js',
    '--workspace',
    'opt-stress-20260503-2',
    '--read-only',
    '--unsafe-actions',
    '--allow-errors',
  ]);

  assert.equal(args.workspace, 'opt-stress-20260503-2');
  assert.equal(args.readOnly, true);
  assert.equal(args.unsafeActions, true);
  assert.equal(args.allowErrors, true);

  const plan = buildScenarioPlan(args);
  assert.match(
    plan.find((scenario) => scenario.id === 'workspace-modal-address-edit').expectation,
    /target workspace opt-stress-20260503-2/
  );
});

test('chaos CLI exposes help without starting a browser run', () => {
  const args = parseArgs([
    'node',
    'run_ui_chaos_probe.js',
    '--help',
  ]);

  assert.equal(args.help, true);
  assert.match(usage(), /--duration-ms/);
  assert.match(usage(), /--read-only/);
  assert.match(usage(), /--allow-errors/);
});
