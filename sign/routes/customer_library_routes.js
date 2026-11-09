const ALL_ROLES = Object.freeze([
  'admin',
  'reviewer',
  'finance',
]);

function createRouteProtector(auth) {
  if (!auth?.authenticateToken || !auth?.requireRole) {
    return () => [];
  }
  return (...roles) => [
    auth.authenticateToken,
    auth.requireRole(...roles),
  ];
}

function registerCustomerLibraryRoutes({ app, upload, handlers, auth = null }) {
  const listWorkspaces = handlers.listCustomerLibraryWorkspaces;
  const ensureWorkspace = handlers.ensureCustomerLibraryWorkspace;
  const deleteWorkspace = handlers.deleteCustomerLibraryWorkspace;
  const listWorkspaceCustomers = handlers.listWorkspaceCustomers;
  const deleteWorkspaceCustomer = handlers.deleteWorkspaceCustomer;
  const importWorkspace = handlers.importCustomerWorkspace;
  const protect = createRouteProtector(auth);
  const read = protect(...ALL_ROLES);
  const adminOnly = protect('admin');
  const intake = protect('admin', 'reviewer');
  const imageReview = protect('admin', 'reviewer');
  const groupCodeUpload = typeof upload.single === 'function'
    ? upload.single('groupCodeFile')
    : upload.array('groupCodeFile', 1);

  app.get('/api/customer-library/state', ...read, handlers.getCustomerLibraryState);
  app.post('/api/customer-library/root', ...adminOnly, handlers.setCustomerLibraryRoot);
  app.get('/api/customer-library/workspaces', ...read, listWorkspaces);
  app.post('/api/customer-library/workspaces', ...intake, ensureWorkspace);
  app.delete('/api/customer-library/workspaces/:workspaceKey', ...adminOnly, deleteWorkspace);
  app.get('/api/customer-library/workspaces/:workspaceKey/customers', ...read, listWorkspaceCustomers);
  app.delete('/api/customer-library/workspaces/:workspaceKey/customers/:customerId', ...intake, deleteWorkspaceCustomer);
  app.get('/api/customer-library/workspaces/:workspaceKey/customers/:customerId/images/:imageId/file', ...read, handlers.getCustomerImageFile);
  app.post('/api/customer-library/workspaces/:workspaceKey/customers/:customerId/images/:imageId/review', ...imageReview, handlers.confirmWorkspaceCustomerImage);
  app.delete('/api/customer-library/workspaces/:workspaceKey/customers/:customerId/images/:imageId', ...imageReview, handlers.deleteWorkspaceCustomerImage);
  app.post('/api/customer-library/workspaces/:workspaceKey/preprocess', ...intake, handlers.preprocessWorkspaceCustomers);
  app.post('/api/customer-library/workspaces/:workspaceKey/customers/:customerId/preprocess', ...intake, handlers.preprocessWorkspaceCustomer);
  app.post('/api/customer-library/workspaces/:workspaceKey/customers/:customerId/images/upload', ...intake, upload.array('files', 50), handlers.appendCustomerImagesFromFiles);
  app.post('/api/customer-library/customers', ...intake, handlers.createCustomer);
  app.post('/api/customer-library/customers/upload', ...intake, upload.array('files', 200), handlers.createCustomerFromFiles);
  app.post('/api/customer-library/import-workspace', ...intake, groupCodeUpload, importWorkspace);
  app.post('/api/customer-library/append-workspace', ...intake, handlers.appendCustomerWorkspaceToBatch);
  app.post('/api/customer-library/append-customer', ...intake, handlers.appendCustomerToBatch);
  // 替换本批次团号表(审核台入口):只换团号表,不重导客户图
  app.post('/api/customer-library/batches/:batchId/group-code', ...intake, groupCodeUpload, handlers.replaceBatchGroupCode);
  // 库清理:列/删孤儿客户(批次已删但库里原图还在 = 废数据)
  app.get('/api/customer-library/cleanup/orphans', ...read, handlers.listLibraryOrphans);
  app.post('/api/customer-library/cleanup/delete', ...intake, handlers.deleteLibraryOrphans);
}

module.exports = {
  registerCustomerLibraryRoutes,
};
