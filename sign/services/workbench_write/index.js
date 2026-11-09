'use strict';

const fs = require('fs');
const path = require('path');

const { createBatchOperations } = require('./batch');
const { createCommon } = require('./common');
const { createSignatureOperations } = require('./signature');
const { createTaskOperations } = require('./task');

const DEFAULT_SIGNATURE_PROCESS_RESULT = '\u5f85\u7b7e\u5b57';

function createWorkbenchWriteService({
  defaultScenario,
  nowStamp,
  withBatchWrite,
  hasBatch,
  loadBatch,
  saveBatchAsync,
  summarizeBatch,
  buildBatchSkeleton,
  batchSubdirs,
  createManualTaskFromFactory,
  createManualReceiptTaskFromSource,
  normalizeFieldValue,
  resolveTask,
  normalizeTask,
  normalizeDocType,
  clearTaskSignatureArtifacts,
  clearEditableFieldsForDocTypeSwitch,
  markClassificationConfirmed,
  didEditableWorkflowChange,
  syncWebsiteSignatureAfterFieldChange,
  websiteSignatureSource,
  removeFileIfExists,
  resolveBatchRelativePath,
  recoverCompletedStateAfterManualReview,
  recalcTask,
  touchTask,
  workbenchGroupApprovalService,
  removeTaskArtifacts,
  clearActiveBatch,
  removeBatchProjection,
  removeBatchDirectory,
  getWebsiteSignatureEligibilityIssue,
  isEligibleForWebsiteGeneration,
  createSignatureJob,
  signatureSiteWorker,
  clearWebsiteFinalSignatureAsset,
  manualSignatureSource,
  restoreAutomaticSignatureState,
  batchDir,
  fileSystem = fs,
  pathModule = path,
  applyComputedFields,
  signatureProcessResult = DEFAULT_SIGNATURE_PROCESS_RESULT,
  onProjectionRemoveError = () => {},
}) {
  const common = createCommon({
    withBatchWrite,
    hasBatch,
    loadBatch,
    saveBatchAsync,
    summarizeBatch,
    fileSystem,
    removeBatchProjection,
    onProjectionRemoveError,
  });

  const signatureOperations = createSignatureOperations({
    common,
    batchSubdirs,
    normalizeFieldValue,
    resolveTask,
    markClassificationConfirmed,
    removeFileIfExists,
    resolveBatchRelativePath,
    recalcTask,
    touchTask,
    getWebsiteSignatureEligibilityIssue,
    isEligibleForWebsiteGeneration,
    createSignatureJob,
    signatureSiteWorker,
    clearWebsiteFinalSignatureAsset,
    manualSignatureSource,
    restoreAutomaticSignatureState,
    batchDir,
    pathModule,
    applyComputedFields,
    signatureProcessResult,
  });

  // 团号预匹配(晚绑定 holder:monthlyDb 在本服务之后创建,server 装配完通过 setter 注入)。
  const groupCodePrematchHolder = { service: null };
  const workflowTaskCoordinatorHolder = { service: null }; // V2 Task7:票级表态→运营任务对账(晚绑定)

  const taskOperations = createTaskOperations({
    common,
    defaultScenario,
    nowStamp,
    buildBatchSkeleton,
    batchSubdirs,
    createManualTaskFromFactory,
    createManualReceiptTaskFromSource,
    normalizeFieldValue,
    resolveTask,
    normalizeTask,
    normalizeDocType,
    clearTaskSignatureArtifacts,
    clearEditableFieldsForDocTypeSwitch,
    markClassificationConfirmed,
    didEditableWorkflowChange,
    syncWebsiteSignatureAfterFieldChange,
    websiteSignatureSource,
    removeFileIfExists,
    resolveBatchRelativePath,
    recoverCompletedStateAfterManualReview,
    recalcTask,
    touchTask,
    removeTaskArtifacts,
    clearActiveBatch,
    removeBatchDirectory,
    applyComputedFields,
    queueAutomaticWebsiteSignature: signatureOperations.queueAutomaticWebsiteSignature,
    groupCodePrematchHolder,
    workflowTaskCoordinatorHolder,
  });

  const batchOperations = createBatchOperations({
    common,
    clearActiveBatch,
    removeBatchDirectory,
    workbenchGroupApprovalService,
  });

  return {
    approveSourceGroup: batchOperations.approveSourceGroup,
    createManualReceiptFromTask: taskOperations.createManualReceiptFromTask,
    setTaskDocBox: taskOperations.setTaskDocBox,
    createManualTask: taskOperations.createManualTask,
    deleteBatch: batchOperations.deleteBatch,
    deleteManualSignature: signatureOperations.deleteManualSignature,
    markBatchExported: batchOperations.markBatchExported,
    markBatchExportFailed: batchOperations.markBatchExportFailed,
    deleteTask: taskOperations.deleteTask,
    deleteWebsiteSignature: signatureOperations.deleteWebsiteSignature,
    queueBatchWebsiteSignatures: signatureOperations.queueBatchWebsiteSignatures,
    queueTaskWebsiteSignature: signatureOperations.queueTaskWebsiteSignature,
    saveManualSignature: signatureOperations.saveManualSignature,
    updateTask: taskOperations.updateTask,
    setGroupCodePrematchService(service) {
      groupCodePrematchHolder.service = service || null;
    },
    setWorkflowTaskCoordinator(service) {
      workflowTaskCoordinatorHolder.service = service || null;
    },
  };
}

module.exports = {
  createWorkbenchWriteService,
};
