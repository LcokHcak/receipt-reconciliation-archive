function createWorkbenchGroupApprovalService({
  approveSourceGroupTasks,
  saveBatchAsync,
  batchRootDirResolver,
  customerFinalizeService,
  markClassificationConfirmed,
  recalcTask,
  touchTask,
  ledgerBridgeService = null,
}) {
  // Kept as a late-bound dependency for compatibility. Ledger writes now happen
  // only through the explicit batch import action, not per group approval.
  let _bridge = ledgerBridgeService; // 兼容期 late-bound 占位:setter 仍在但已无读方

  function setLedgerBridgeService(service) {
    _bridge = service;
  }

  async function approveGroup({ batch, groupKey }) {
    const groupTasks = (batch?.tasks || []).filter((task) => String(task?.sourceGroupKey || '').trim() === groupKey);
    const sourceGroup = (batch?.sourceGroups || []).find((group) => String(group?.key || '').trim() === String(groupKey || '').trim()) || null;
    // 2026-07-07 软拦化:approveSourceGroupTasks 阻断时不再改任何任务状态(不再 markGroupRephoto),
    // 故失败路径无需保存批次(旧版会把整组误标的需重拍落盘)。成功才落盘。
    const approvedTaskIds = approveSourceGroupTasks(groupTasks, {
      markClassificationConfirmed,
      recalcTask,
      touchTask,
    });

    await saveBatchAsync(batch);

    const finalization = await customerFinalizeService.finalizeApprovedGroup({
      batchId: batch.id,
      batchRootDir: batchRootDirResolver(batch.id),
      groupKey,
      sourceGroupLabel: sourceGroup?.label || '',
      sourceGroupFolderPath: sourceGroup?.folderPath || '',
      groupTasks,
    });

    return {
      approvedTaskIds,
      finalization,
      ledgerSync: null,
    };
  }

  return {
    approveGroup,
    setLedgerBridgeService,
  };
}

module.exports = {
  createWorkbenchGroupApprovalService,
};
