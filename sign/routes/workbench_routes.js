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

function registerWorkbenchRoutes({ app, upload, handlers, auth = null }) {
  const protect = createRouteProtector(auth);
  const read = protect(...ALL_ROLES);
  const adminOnly = protect('admin');
  const intake = protect('admin', 'reviewer');
  const fieldReview = protect('admin', 'reviewer');
  const finalReview = protect('admin', 'finance');

  app.get('/api/health', handlers.getHealth);
  app.get('/api/state', ...read, handlers.getState);
  app.get('/api/my/todos', ...read, handlers.getMyTodos);
  app.post('/api/signature-service/open-browser', ...finalReview, handlers.openSignatureBrowser);
  app.post('/api/signature-service/close-browser', ...finalReview, handlers.closeSignatureBrowser);
  app.get('/api/batches/:batchId', ...read, handlers.getBatch);
  app.delete('/api/batches/:batchId', ...finalReview, handlers.deleteBatch);
  app.post('/api/batches/import', ...intake, upload.array('files', 3000), handlers.importBatch);
  app.post('/api/batches/:batchId/tasks/:taskId/manual-receipt', ...fieldReview, handlers.createManualReceiptFromTask);
  // 手画文档框(0730 第2期):在原图上框出这条任务对应的那张单据,交付时按它裁
  app.post('/api/batches/:batchId/tasks/:taskId/doc-box', ...fieldReview, handlers.setTaskDocBox);
  // 「查看原图」:切片被裁掉票面边缘时,回溯客户库切分前完整原图(只读)。
  app.get('/api/batches/:batchId/tasks/:taskId/original-image', ...read, handlers.getTaskOriginalImage);
  app.patch('/api/batches/:batchId/tasks/:taskId', ...fieldReview, handlers.updateTask);
  app.post('/api/batches/:batchId/tasks/requeue', ...fieldReview, handlers.requeueTasks);
  // P2d 改店重切:按(新)店档案用原图重切,旧任务删除,新切片归回同批次(仅 qwen 模式)
  app.post('/api/batches/:batchId/tasks/:taskId/resplit', ...fieldReview, handlers.resplitTask);
  // P2-b:按人画的框重读票面字段(只写 *Auto,不碰 *Final)
  app.post('/api/batches/:batchId/tasks/:taskId/reread-box', ...fieldReview, handlers.rereadTaskBox);
  app.post('/api/batches/:batchId/source-groups/:groupKey/approve', ...finalReview, handlers.approveSourceGroup);
  app.post('/api/batches/:batchId/import-ledger', ...fieldReview, handlers.importBatchLedger);
  // 流式逐客户结算(P1,与上面批次级导入并存):通过并结算 / 确认渠道模式。
  app.post('/api/batches/:batchId/source-groups/:groupKey/settle', ...fieldReview, handlers.settleSourceGroup);
  app.post('/api/batches/:batchId/source-groups/:groupKey/confirm-modes', ...fieldReview, handlers.confirmGroupModes);
  // 台账侧订正(2026-07-21):管理员专属——撤销已结算组台账(删行+快照留痕),组回可编辑态
  app.post('/api/batches/:batchId/source-groups/:groupKey/ledger-correction', ...adminOnly, handlers.correctGroupLedger);
  // 团号确认站(2026-07-10):候选聚合只读;确认/撤销与结算同 fieldReview(admin+reviewer,
  // 勿用 approve 的 finalReview——reviewer 403 前车之鉴);先验/回发队列同角色。
  app.get('/api/batches/:batchId/source-groups/:groupKey/tour-candidates', ...read, handlers.getGroupTourCandidates);
  app.post('/api/batches/:batchId/source-groups/:groupKey/confirm-tour', ...fieldReview, handlers.confirmGroupTour);
  app.post('/api/batches/:batchId/source-groups/:groupKey/unconfirm-tour', ...fieldReview, handlers.unconfirmGroupTour);
  app.post('/api/batches/:batchId/source-groups/:groupKey/tour-responded', ...fieldReview, handlers.markGroupTourResponded);
  // 先验/回发含他人确认流水与客户线索,收紧到 fieldReview(admin+reviewer)——
  // read=全角色会让任意登录账号传别人 workspaceKey 越权读(reviewer HIGH)。
  app.get('/api/tour-prior', ...fieldReview, handlers.getTourPrior);
  app.get('/api/sendback-queue', ...fieldReview, handlers.listSendbackQueue);
  app.post('/api/sendback-queue/:id/done', ...fieldReview, handlers.markSendbackDone);
  app.delete('/api/batches/:batchId/source-groups/:groupKey/customer', ...fieldReview, handlers.deleteSourceGroupCustomer);
  app.delete('/api/batches/:batchId/tasks/:taskId', ...fieldReview, handlers.deleteTask);
  app.post(
    '/api/batches/:batchId/tasks/:taskId/queue-website-signature',
    ...fieldReview,
    handlers.queueTaskWebsiteSignature
  );
  app.post('/api/batches/:batchId/queue-website-signatures', ...fieldReview, handlers.queueBatchWebsiteSignatures);
  app.delete('/api/batches/:batchId/tasks/:taskId/website-signature', ...fieldReview, handlers.deleteWebsiteSignature);
  app.post('/api/batches/:batchId/tasks/:taskId/manual-signature', ...fieldReview, handlers.saveManualSignature);
  app.delete('/api/batches/:batchId/tasks/:taskId/manual-signature', ...fieldReview, handlers.deleteManualSignature);
  app.post('/api/batches/:batchId/export', ...adminOnly, handlers.exportBatch);
  app.post('/api/batches/:batchId/export-customer-data', ...fieldReview, handlers.exportCustomerData);
  // 现代交付包:按类型三池(护照/机票/小票),小票按票号命名(上家现代免税店交付格式)
  app.post('/api/batches/:batchId/export-hyundai-delivery', ...fieldReview, handlers.exportHyundaiDelivery);
  // 乐天百货交付包(P4):门店分夹+客户夹双图(交易编号图/护照图)
  app.post('/api/batches/:batchId/export-lotte-dept-delivery', ...fieldReview, handlers.exportLotteDeptDelivery);
  // 多模式交付包:济州道辉/现代三池/其他模式各一文件夹/S活动小票双份(2026-07-07 四规则)
  app.post('/api/batches/:batchId/export-mode-delivery', ...fieldReview, handlers.exportModeDelivery);
}

module.exports = {
  registerWorkbenchRoutes,
};
