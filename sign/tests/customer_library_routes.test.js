const test = require('node:test');
const assert = require('node:assert/strict');

const { registerCustomerLibraryRoutes } = require('../routes/customer_library_routes');

test('customer library routes register workspace-first endpoints only', () => {
  const calls = [];
  const app = {
    get(routePath, handler) {
      calls.push(['get', routePath, handler]);
    },
    post(routePath, ...handlers) {
      calls.push(['post', routePath, handlers]);
    },
    delete(routePath, handler) {
      calls.push(['delete', routePath, handler]);
    },
  };
  const upload = {
    array(name, limit) {
      return `upload:${name}:${limit}`;
    },
  };
  const handlers = {
    getCustomerLibraryState() {},
    setCustomerLibraryRoot() {},
    listCustomerLibraryWorkspaces() {},
    ensureCustomerLibraryWorkspace() {},
    deleteCustomerLibraryWorkspace() {},
    listWorkspaceCustomers() {},
    deleteWorkspaceCustomer() {},
    getCustomerImageFile() {},
    confirmWorkspaceCustomerImage() {},
    deleteWorkspaceCustomerImage() {},
    preprocessWorkspaceCustomers() {},
    preprocessWorkspaceCustomer() {},
    createCustomer() {},
    createCustomerFromFiles() {},
    appendCustomerImagesFromFiles() {},
    importCustomerWorkspace() {},
    appendCustomerWorkspaceToBatch() {},
    appendCustomerToBatch() {},
    replaceBatchGroupCode() {},
  };

  registerCustomerLibraryRoutes({ app, upload, handlers });

  assert.deepEqual(
    calls.map(([method, routePath]) => `${method} ${routePath}`),
    [
      'get /api/customer-library/state',
      'post /api/customer-library/root',
      'get /api/customer-library/workspaces',
      'post /api/customer-library/workspaces',
      'delete /api/customer-library/workspaces/:workspaceKey',
      'get /api/customer-library/workspaces/:workspaceKey/customers',
      'delete /api/customer-library/workspaces/:workspaceKey/customers/:customerId',
      'get /api/customer-library/workspaces/:workspaceKey/customers/:customerId/images/:imageId/file',
      'post /api/customer-library/workspaces/:workspaceKey/customers/:customerId/images/:imageId/review',
      'delete /api/customer-library/workspaces/:workspaceKey/customers/:customerId/images/:imageId',
      'post /api/customer-library/workspaces/:workspaceKey/preprocess',
      'post /api/customer-library/workspaces/:workspaceKey/customers/:customerId/preprocess',
      'post /api/customer-library/workspaces/:workspaceKey/customers/:customerId/images/upload',
      'post /api/customer-library/customers',
      'post /api/customer-library/customers/upload',
      'post /api/customer-library/import-workspace',
      'post /api/customer-library/append-workspace',
      'post /api/customer-library/append-customer',
      'post /api/customer-library/batches/:batchId/group-code',
      'get /api/customer-library/cleanup/orphans',
      'post /api/customer-library/cleanup/delete',
    ]
  );
  const uploadCall = calls.find(([, routePath]) => routePath === '/api/customer-library/customers/upload');
  assert.deepEqual(uploadCall[2], ['upload:files:200', handlers.createCustomerFromFiles]);
  const appendImagesCall = calls.find(([, routePath]) => routePath === '/api/customer-library/workspaces/:workspaceKey/customers/:customerId/images/upload');
  assert.deepEqual(appendImagesCall[2], ['upload:files:50', handlers.appendCustomerImagesFromFiles]);
});
