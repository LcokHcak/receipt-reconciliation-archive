const test = require('node:test');
const assert = require('node:assert/strict');

const { createWorkbenchGroupApprovalService } = require('../services/workbench_group_approval_service');
const { DOC_TYPES } = require('../lib/package_constants');
const { PROCESS_RESULTS, deriveTaskState } = require('../lib/workbench_task_flow');
const { approveSourceGroupTasks } = require('../lib/workbench_group_review');

test('approveGroup saves the batch and finalizes customer outputs after approving a source group', async () => {
  const callOrder = [];
  const finalized = [];
  const batch = {
    id: 'batch_1',
    sourceGroups: [
      {
        key: 'group_1',
        label: 'CL20260420-001',
        folderPath: 'CL20260420-001',
      },
    ],
    tasks: [
      {
        id: 'task_1',
        sourceGroupKey: 'group_1',
        docTypeFinal: 'passport',
      },
      {
        id: 'task_2',
        sourceGroupKey: 'group_1',
        docTypeFinal: 'receipt',
      },
    ],
  };

  const service = createWorkbenchGroupApprovalService({
    approveSourceGroupTasks(groupTasks, helpers) {
      callOrder.push('approve');
      groupTasks.forEach((task) => {
        helpers.markClassificationConfirmed(task);
        task.reviewed = true;
        task.reviewedAt = '2026-04-20T12:00:00.000Z';
        helpers.recalcTask(task);
        helpers.touchTask(task);
      });
      return groupTasks.map((task) => task.id);
    },
    saveBatchAsync(savedBatch) {
      callOrder.push('save');
      assert.equal(savedBatch, batch);
    },
    batchRootDirResolver(batchId) {
      assert.equal(batchId, 'batch_1');
      return `/tmp/${batchId}`;
    },
    customerFinalizeService: {
      async finalizeApprovedGroup(args) {
        callOrder.push('finalize');
        finalized.push(args);
        return { folderNameFinal: 'HUANG_YU_EM7242787' };
      },
    },
    markClassificationConfirmed(task) {
      task.classificationConfirmed = true;
    },
    recalcTask(task) {
      task.processResult = 'approved';
    },
    touchTask(task) {
      task.updatedAt = '2026-04-20T12:00:00.000Z';
    },
  });

  const result = await service.approveGroup({ batch, groupKey: 'group_1' });

  assert.deepEqual(callOrder, ['approve', 'save', 'finalize']);
  assert.deepEqual(result.approvedTaskIds, ['task_1', 'task_2']);
  assert.deepEqual(finalized, [
    {
      batchId: 'batch_1',
      batchRootDir: '/tmp/batch_1',
      groupKey: 'group_1',
      sourceGroupLabel: 'CL20260420-001',
      sourceGroupFolderPath: 'CL20260420-001',
      groupTasks: batch.tasks,
    },
  ]);
  assert.deepEqual(result.finalization, { folderNameFinal: 'HUANG_YU_EM7242787' });
});

test('approveGroup does not write ledger rows before the explicit batch import step', async () => {
  const ledgerCalls = [];
  const batch = {
    id: 'batch_1',
    monthlyWorkspaceKey: '2026-05',
    sourceGroups: [
      { key: 'group_1', label: 'CL20260420-001', folderPath: 'CL20260420-001' },
    ],
    tasks: [
      { id: 'task_1', sourceGroupKey: 'group_1', docTypeFinal: 'passport' },
      { id: 'task_2', sourceGroupKey: 'group_1', docTypeFinal: 'receipt' },
    ],
  };

  const service = createWorkbenchGroupApprovalService({
    approveSourceGroupTasks(groupTasks) {
      return groupTasks.map((task) => task.id);
    },
    saveBatchAsync() {},
    batchRootDirResolver() { return '/tmp/batch_1'; },
    customerFinalizeService: {
      async finalizeApprovedGroup() {
        return { folderNameFinal: 'HUANG_YU_EM7242787' };
      },
    },
    markClassificationConfirmed() {},
    recalcTask() {},
    touchTask() {},
    ledgerBridgeService: {
      async syncApprovedGroup(args) {
        ledgerCalls.push(args);
        return { inserted: 1, skipped: 0, workspaceKey: args.workspaceKey };
      },
    },
  });

  const result = await service.approveGroup({ batch, groupKey: 'group_1', operator: 'reviewer1' });

  assert.equal(ledgerCalls.length, 0);
  assert.equal(result.ledgerSync, null);
});

test('approveGroup:护照数量问题软拦——不改状态、不落盘、不 finalize', async () => {
  let saveCount = 0;
  let finalizeCount = 0;
  const batch = {
    id: 'batch_1',
    sourceGroups: [
      { key: 'group_1', label: 'CL20260420-001', folderPath: 'CL20260420-001' },
    ],
    tasks: [
      {
        id: 'passport_1',
        sourceGroupKey: 'group_1',
        originalFileName: 'passport-1.jpg',
        docTypeFinal: DOC_TYPES.PASSPORT,
        classificationConfirmed: true,
        extractedNameFinal: 'KIM MINSU',
        passportNoFinal: 'M12345678',
        chineseNameFinal: 'KIM',
        finalSignaturePath: 'sign/passport-1.png',
        reviewed: false,
        reviewedAt: '',
        rephotoRequested: false,
        processResult: PROCESS_RESULTS.FINAL_REVIEW,
      },
      {
        id: 'passport_2',
        sourceGroupKey: 'group_1',
        originalFileName: 'passport-2.jpg',
        docTypeFinal: DOC_TYPES.PASSPORT,
        classificationConfirmed: true,
        extractedNameFinal: 'LEE MINSU',
        passportNoFinal: 'M87654321',
        chineseNameFinal: 'LEE',
        finalSignaturePath: 'sign/passport-2.png',
        reviewed: false,
        reviewedAt: '',
        rephotoRequested: false,
        processResult: PROCESS_RESULTS.FINAL_REVIEW,
      },
    ],
  };

  const service = createWorkbenchGroupApprovalService({
    approveSourceGroupTasks,
    saveBatchAsync(savedBatch) {
      saveCount += 1;
      assert.equal(savedBatch, batch);
    },
    batchRootDirResolver() { return '/tmp/batch_1'; },
    customerFinalizeService: {
      async finalizeApprovedGroup() {
        finalizeCount += 1;
        return {};
      },
    },
    markClassificationConfirmed() {},
    recalcTask(task) {
      task.processResult = deriveTaskState(task).processResult;
    },
    touchTask(task) {
      task.updatedAt = '2026-04-20T12:00:00.000Z';
    },
  });

  await assert.rejects(
    () => service.approveGroup({ batch, groupKey: 'group_1' }),
    (error) => {
      assert.equal(error.code, 'GROUP_APPROVAL_INVALID');
      assert.notEqual(error.markedRephoto, true); // 软拦化:不再 mass-mark 需重拍
      return true;
    }
  );

  // 阻断路径零副作用:不落盘、不 finalize、状态原封不动
  assert.equal(saveCount, 0);
  assert.equal(finalizeCount, 0);
  batch.tasks.forEach((task) => {
    assert.equal(task.rephotoRequested, false);
    assert.equal(task.processResult, PROCESS_RESULTS.FINAL_REVIEW);
  });
});
