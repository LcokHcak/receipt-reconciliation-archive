const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createWorkbenchStateService } = require('../services/workbench_state_service');

test('workbench state service builds the main workbench state payload', async () => {
  let listBatchesCalled = false;
  const stateService = createWorkbenchStateService({
    workbenchRoot: 'D:/sign/passport_review_workbench',
    defaultCustomerLibraryRoot: 'D:/sign/passport_review_workbench/storage/customer_library',
    listBatches: async () => {
      listBatchesCalled = true;
      return [{ id: 'batch-1' }];
    },
    getSignatureServiceState: () => ({ open: true }),
    customerLibraryRepository: {
      getActiveRoot: () => 'D:/customer-library/active',
    },
    customerIntakeService: {
      getState: () => ({ activeRoot: 'D:/customer-library/active' }),
      listWorkspaces: () => ['workspace-a'],
      listMonths: () => ['202604'],
    },
  });

  const payload = await stateService.getWorkbenchState();

  assert.equal(listBatchesCalled, true);
  assert.equal(payload.rootDir, 'D:/sign/passport_review_workbench');
  assert.deepEqual(payload.batches, [{ id: 'batch-1' }]);
  assert.deepEqual(payload.customerLibrary, {
    activeRoot: 'D:/customer-library/active',
    defaultRoot: path.resolve('D:/sign/passport_review_workbench/storage/customer_library'),
  });
  assert.deepEqual(payload.signatureService, { open: true });
  assert.ok(payload.workflowMeta);
});

test('workbench state service filters batch list for reviewer-owned batches', async () => {
  const stateService = createWorkbenchStateService({
    workbenchRoot: 'D:/sign/passport_review_workbench',
    defaultCustomerLibraryRoot: 'D:/sign/passport_review_workbench/storage/customer_library',
    listBatches: async () => [
      { id: 'batch-alice', ownerUsername: 'alice' },
      { id: 'batch-bob', ownerUsername: 'bob' },
    ],
    getSignatureServiceState: () => ({ open: false }),
    customerLibraryRepository: {
      getActiveRoot: () => 'D:/customer-library/active',
    },
    customerIntakeService: {
      getState: () => ({ activeRoot: 'D:/customer-library/active' }),
      listWorkspaces: () => [],
      listMonths: () => [],
    },
  });

  const reviewerPayload = await stateService.getWorkbenchState({
    username: 'alice',
    role: 'reviewer',
  });
  assert.deepEqual(reviewerPayload.batches.map((batch) => batch.id), ['batch-alice']);

  const financePayload = await stateService.getWorkbenchState({
    username: 'finance',
    role: 'finance',
  });
  assert.deepEqual(financePayload.batches.map((batch) => batch.id), ['batch-alice', 'batch-bob']);
});

test('workbench state service builds the customer library payload with workspace fallback', () => {
  const stateService = createWorkbenchStateService({
    workbenchRoot: 'D:/sign/passport_review_workbench',
    defaultCustomerLibraryRoot: 'D:/sign/passport_review_workbench/storage/customer_library',
    listBatches: () => [],
    getSignatureServiceState: () => ({ open: false }),
    customerLibraryRepository: {
      getActiveRoot: () => 'D:/customer-library/active',
    },
    customerIntakeService: {
      getState: () => ({ activeRoot: 'D:/customer-library/active', customerCount: 2 }),
      listWorkspaces: () => ['workspace-a', 'workspace-b'],
      listMonths: () => ['202604'],
    },
  });

  const payload = stateService.getCustomerLibraryState();

  assert.deepEqual(payload, {
    ok: true,
    activeRoot: 'D:/customer-library/active',
    customerCount: 2,
    defaultRoot: path.resolve('D:/sign/passport_review_workbench/storage/customer_library'),
    workspaceKey: 'workspace-b',
    workspaces: ['workspace-a', 'workspace-b'],
    months: ['202604'],
  });
});
