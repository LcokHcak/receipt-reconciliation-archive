const test = require('node:test');
const assert = require('node:assert/strict');

const { buildWorkbenchStatePayload } = require('../services/workbench_meta_service');

test('workbench state payload can expose customer library root metadata alongside workbench state', () => {
  const payload = buildWorkbenchStatePayload({
    rootDir: 'D:/sign/passport_review_workbench',
    batches: [],
    signatureService: { open: false },
    customerLibrary: {
      activeRoot: 'D:/customer-library/202604',
      defaultRoot: 'D:/customer-library',
    },
  });

  assert.deepEqual(payload.customerLibrary, {
    activeRoot: 'D:/customer-library/202604',
    defaultRoot: 'D:/customer-library',
  });
});
