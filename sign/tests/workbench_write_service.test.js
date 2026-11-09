const test = require('node:test');
const assert = require('node:assert/strict');

const { createWorkbenchWriteService } = require('../services/workbench_write_service');

function createService(overrides = {}) {
  const callLog = [];
  const batch = overrides.batch || {
    id: 'batch_1',
    name: 'Batch 1',
    tasks: [
      {
        id: 'task_1',
        docTypeFinal: 'passport',
        extractedNameFinal: '',
        passportNoFinal: '',
        chineseNameFinal: '',
        receiptStoreFinal: '',
        receiptNoFinal: '',
        groupNoFinal: '',
        purchaseDateFinal: '',
        departureDateFinal: '',
        signatureStyle: 'default',
        reviewNote: '',
        finalSignatureSource: '',
        finalSignaturePath: '',
        reviewed: true,
        reviewedAt: '2026-04-21T00:00:00.000Z',
        rephotoRequested: false,
        sourceImagePath: 'source/a.jpg',
      },
    ],
  };

  const defaults = {
    defaultScenario: 'FullProcess',
    nowStamp: () => '20260421010101',
    withBatchWrite: async (_batchId, action, _options) => action(),
    hasBatch: () => true,
    loadBatch: () => batch,
    saveBatchAsync: (savedBatch) => {
      callLog.push('saveBatch');
      assert.equal(savedBatch, batch);
    },
    summarizeBatch: (savedBatch) => ({
      id: savedBatch.id,
      taskCount: savedBatch.tasks.length,
      includeTasks: true,
    }),
    buildBatchSkeleton: (batchId, name, scenario) => ({
      id: batchId,
      name,
      scenario,
      machineState: 'queued',
      tasks: [],
      sourceGroups: [],
    }),
    batchSubdirs: (batchId) => {
      callLog.push(`batchSubdirs:${batchId}`);
      return {};
    },
    createManualTaskFromFactory: (recordLabel) => ({
      id: 'manual_task_1',
      recordLabel,
      docTypeFinal: 'passport',
    }),
    createManualReceiptTaskFromSource: (sourceTask, recordLabel) => ({
      id: 'manual_receipt_1',
      sourceImagePath: sourceTask.sourceImagePath,
      docTypeFinal: 'receipt',
      recordLabel,
    }),
    normalizeFieldValue: (value) => String(value || '').trim(),
    resolveTask: (inputBatch, taskId) => inputBatch.tasks.find((task) => task.id === taskId) || null,
    normalizeTask: (task) => ({ ...task }),
    normalizeDocType: (value) => String(value || 'passport').trim() || 'passport',
    clearTaskSignatureArtifacts: () => {
      callLog.push('clearTaskSignatureArtifacts');
    },
    clearEditableFieldsForDocTypeSwitch: (_task, nextDocType) => ({
      docTypeFinal: nextDocType,
      extractedNameFinal: '',
      passportNoFinal: '',
      chineseNameFinal: '',
      receiptStoreFinal: '',
      receiptNoFinal: '',
      groupNoFinal: '',
      purchaseDateFinal: '',
      departureDateFinal: '',
    }),
    markClassificationConfirmed: (task) => {
      callLog.push('markClassificationConfirmed');
      task.classificationConfirmed = true;
    },
    didEditableWorkflowChange: () => true,
    syncWebsiteSignatureAfterFieldChange: () => false,
    websiteSignatureSource: 'website',
    removeFileIfExists: () => {
      callLog.push('removeFileIfExists');
    },
    resolveBatchRelativePath: (_batchId, relativePath) => relativePath,
    recoverCompletedStateAfterManualReview: () => {
      callLog.push('recoverCompletedStateAfterManualReview');
    },
    recalcTask: (task) => {
      callLog.push('recalcTask');
      task.processResult = '待终审';
    },
    touchTask: (task) => {
      callLog.push('touchTask');
      task.updatedAt = '2026-04-21T01:02:03.000Z';
    },
    workbenchGroupApprovalService: {
      approveGroup: async ({ groupKey }) => {
        callLog.push(`approveGroup:${groupKey}`);
        return {
          approvedTaskIds: ['task_1'],
          finalization: { folderNameFinal: 'ZHANG_SAN_P123456' },
        };
      },
    },
    removeTaskArtifacts: (batchId, task, remainingTasks) => {
      callLog.push(`removeTaskArtifacts:${batchId}:${task.id}:${remainingTasks.length}`);
    },
    clearActiveBatch: (batchId) => {
      callLog.push(`clearActiveBatch:${batchId}`);
    },
    removeBatchProjection: (batchId) => {
      callLog.push(`removeBatchProjection:${batchId}`);
    },
    removeBatchDirectory: (batchId) => {
      callLog.push(`removeBatchDirectory:${batchId}`);
    },
    getWebsiteSignatureEligibilityIssue: () => '',
    isEligibleForWebsiteGeneration: () => true,
    createSignatureJob: (inputBatch, task) => ({
      taskKey: `${inputBatch.id}:${task.id}`,
      batchId: inputBatch.id,
      taskId: task.id,
    }),
    signatureSiteWorker: {
      async queueJob() {
        callLog.push('queueJob');
        return {
          queued: true,
          reason: '',
          state: { open: true },
        };
      },
      async queueJobs(jobs) {
        callLog.push(`queueJobs:${jobs.length}`);
        return {
          queuedCount: jobs.length,
          state: { open: true },
          results: jobs.map(() => ({ queued: true })),
        };
      },
      getState() {
        return { open: true };
      },
    },
    clearWebsiteFinalSignatureAsset: () => {
      callLog.push('clearWebsiteFinalSignatureAsset');
    },
    manualSignatureSource: 'manual',
    restoreAutomaticSignatureState: () => {
      callLog.push('restoreAutomaticSignatureState');
    },
    batchDir: (batchId) => `/tmp/${batchId}`,
    fileSystem: {
      writeFileSync(filePath, buffer) {
        callLog.push(`writeFile:${filePath}:${buffer.length}`);
      },
      existsSync() {
        return true;
      },
      unlinkSync(filePath) {
        callLog.push(`unlinkFile:${filePath}`);
      },
    },
    pathModule: {
      join: (...parts) => parts.join('/'),
    },
    applyComputedFields: (_batchInput, task) => ({
      id: task.id,
      extractedNameFinal: task.extractedNameFinal,
      reviewed: task.reviewed,
      processResult: task.processResult,
    }),
    onProjectionRemoveError: (error, batchId) => {
      throw new Error(`unexpected projection remove error for ${batchId}: ${error.message}`);
    },
  };

  return {
    batch,
    callLog,
    service: createWorkbenchWriteService({
      ...defaults,
      ...overrides,
    }),
  };
}

test('updateTask persists batch edits and clears reviewed when editable workflow changed', async () => {
  const { batch, callLog, service } = createService();
  batch.tasks[0].version = 1;

  const payload = await service.updateTask({
    batchId: batch.id,
    taskId: 'task_1',
    body: {
      extractedNameFinal: ' Alice ',
    },
  });

  assert.equal(payload.status, 200);
  assert.deepEqual(payload.body, {
    ok: true,
    // 增量合并配套(2026-07-08):PATCH 捎带轻量批次元信息,前端不整批 refetch 后
    // 靠它刷新团号表解析状态(结算按钮解锁不滞后)
    batchMeta: { groupCodeStatus: null },
    task: {
      id: 'task_1',
      extractedNameFinal: 'ALICE',
      reviewed: false,
      processResult: '待终审',
    },
  });
  assert.equal(batch.tasks[0].classificationConfirmed, true);
  assert.equal(batch.tasks[0].reviewed, false);
  assert.equal(batch.tasks[0].reviewedAt, '');
  assert.equal(batch.tasks[0].version, 2);
  assert.ok(callLog.includes('saveBatch'));
});

test('updateTask:改文档类型与 reviewed:true 同笔 → 不通过(2026-07-13 其他→小票补救 bug)', async () => {
  const { batch, service } = createService();
  batch.tasks[0].docTypeFinal = 'other';
  batch.tasks[0].reviewed = false;
  // 同一笔既改类型(other→receipt)又要标已通过:类型变更优先,reviewed 被拦下
  await service.updateTask({
    batchId: batch.id,
    taskId: 'task_1',
    body: { docTypeFinal: 'receipt', reviewed: true },
  });
  assert.equal(batch.tasks[0].reviewed, false, '刚改类型的小票不能同笔盖已通过(会跳过团号两步锁)');
  assert.equal(batch.tasks[0].reviewedAt, '');

  // 对照:类型不变时 reviewed:true 照常通过
  batch.tasks[0].reviewed = false;
  await service.updateTask({ batchId: batch.id, taskId: 'task_1', body: { reviewed: true } });
  assert.equal(batch.tasks[0].reviewed, true, '类型未变的正常确认不受影响');
});

test('updateTask waits for async batch persistence before returning', async () => {
  let persisted = false;
  let resolveSave;
  const saveFinished = new Promise((resolve) => {
    resolveSave = resolve;
  });
  const { batch, service } = createService({
    async saveBatchAsync() {
      await saveFinished;
      persisted = true;
    },
  });

  const pendingPayload = service.updateTask({
    batchId: batch.id,
    taskId: 'task_1',
    body: {
      extractedNameFinal: ' Alice ',
    },
  });
  await Promise.resolve();
  assert.equal(persisted, false);
  resolveSave();
  const payload = await pendingPayload;

  assert.equal(payload.status, 200);
  assert.equal(persisted, true);
});

test('updateTask persists trimmed receipt store edits', async () => {
  const { batch, service } = createService({
    applyComputedFields: (_batchInput, task) => ({
      id: task.id,
      receiptStoreFinal: task.receiptStoreFinal,
      processResult: task.processResult,
    }),
  });

  const payload = await service.updateTask({
    batchId: batch.id,
    taskId: 'task_1',
    body: {
      docTypeFinal: 'receipt',
      receiptStoreFinal: ' LOTTE ',
    },
  });

  assert.equal(payload.status, 200);
  assert.equal(batch.tasks[0].receiptStoreFinal, 'LOTTE');
  assert.equal(payload.body.task.receiptStoreFinal, 'LOTTE');
});

test('approveSourceGroup maps approval validation errors into a 409 payload', async () => {
  const { batch, service } = createService({
    workbenchGroupApprovalService: {
      async approveGroup() {
        const error = new Error('Group cannot be approved');
        error.code = 'GROUP_APPROVAL_INVALID';
        error.taskId = 'task_1';
        error.issue = 'missing_signature';
        throw error;
      },
    },
  });

  const payload = await service.approveSourceGroup({
    batchId: batch.id,
    groupKey: 'group_1',
  });

  assert.deepEqual(payload, {
    status: 409,
    body: {
      error: 'Group cannot be approved',
      taskId: 'task_1',
      issue: 'missing_signature',
      // 红条定位契约:前端「定位到这张图」只认 details.taskId(顶层 taskId 是历史形状)
      details: {
        taskId: 'task_1',
        issue: 'missing_signature',
        markedRephoto: false,
      },
    },
  });
});

test('approveSourceGroup 归档撞名(真重复建档)→409 带组名+可定位 details(与结算路径同形状)', async () => {
  const { batch, service } = createService({
    batch: {
      id: 'batch_1',
      tasks: [
        { id: 'task_9', sourceGroupKey: 'group_1', docTypeFinal: 'receipt', sourceImagePath: 'source/a.jpg' },
      ],
      sourceGroups: [{ key: 'group_1', label: '小龙33' }],
    },
    workbenchGroupApprovalService: {
      async approveGroup() {
        const error = new Error('folder exists');
        error.code = 'CUSTOMER_FOLDER_EXISTS';
        error.folderName = '小龙33';
        error.duplicateReceiptNos = ['901088-26-005572'];
        throw error;
      },
    },
  });

  const payload = await service.approveSourceGroup({ batchId: batch.id, groupKey: 'group_1' });

  assert.equal(payload.status, 409);
  assert.equal(payload.body.code, 'CUSTOMER_FOLDER_EXISTS');
  assert.match(payload.body.error, /【小龙33】/, '报错必须带组名,操作员才找得到是哪组');
  // 红条定位+「删除这组重复客户」按钮的契约字段
  assert.deepEqual(payload.body.details, {
    duplicateReceiptNos: ['901088-26-005572'],
    groupKey: 'group_1',
    groupLabel: '小龙33',
    taskId: 'task_9',
  });
});

test('deleteTask removes the whole batch and SQLite projection when the last task is deleted', async () => {
  const batch = {
    id: 'batch_1',
    tasks: [
      {
        id: 'task_1',
      },
    ],
  };
  const { callLog, service } = createService({ batch });

  const payload = await service.deleteTask({
    batchId: 'batch_1',
    taskId: 'task_1',
  });

  assert.deepEqual(payload, {
    status: 200,
    body: {
      ok: true,
      batchDeleted: true,
      batchId: 'batch_1',
      deletedTaskId: 'task_1',
    },
  });
  assert.deepEqual(callLog, [
    'removeTaskArtifacts:batch_1:task_1:0',
    'clearActiveBatch:batch_1',
    'removeBatchProjection:batch_1',
    'removeBatchDirectory:batch_1',
  ]);
});

test('queueTaskWebsiteSignature updates queued state and persists the batch', async () => {
  const { batch, callLog, service } = createService();

  const payload = await service.queueTaskWebsiteSignature({
    batchId: batch.id,
    taskId: 'task_1',
  });

  assert.equal(payload.status, 200);
  assert.deepEqual(payload.body, {
    ok: true,
    queued: true,
    reason: '',
    service: { open: true },
    task: {
      id: 'task_1',
      extractedNameFinal: '',
      reviewed: true,
      processResult: '待终审',
    },
  });
  assert.equal(batch.tasks[0].signatureJobStatus, 'queued');
  assert.equal(batch.tasks[0].signatureJobError, '');
  assert.ok(callLog.includes('queueJob'));
  assert.ok(callLog.includes('saveBatch'));
});

test('queueTaskWebsiteSignature can overwrite an existing final signature on explicit request', async () => {
  const { batch, callLog, service } = createService({
    batch: {
      id: 'batch_1',
      name: 'Batch 1',
      tasks: [
        {
          id: 'task_1',
          docTypeFinal: 'passport',
          machineState: 'completed',
          sourceType: 'uploaded',
          classificationConfirmed: true,
          extractedNameFinal: 'ANG LIMIN',
          passportNoFinal: 'E12345678',
          chineseNameFinal: '安丽敏',
          signatureStyle: 'default',
          signatureJobStatus: 'done',
          signatureJobError: '',
          finalSignatureSource: 'manual',
          finalSignaturePath: 'final_signatures/task_1__manual_signature.png',
          signatureGeneratedAt: '2026-04-21T01:01:01.000Z',
          reviewed: false,
          reviewedAt: '',
          rephotoRequested: false,
          sourceImagePath: 'source/a.jpg',
        },
      ],
    },
    getWebsiteSignatureEligibilityIssue: (task) => (
      task.finalSignatureSource ? '当前已有签字' : ''
    ),
  });

  const payload = await service.queueTaskWebsiteSignature({
    batchId: batch.id,
    taskId: 'task_1',
  });

  assert.equal(payload.status, 200);
  assert.equal(batch.tasks[0].finalSignaturePath, '');
  assert.equal(batch.tasks[0].finalSignatureSource, '');
  assert.equal(batch.tasks[0].signatureGeneratedAt, '');
  assert.equal(batch.tasks[0].signatureJobStatus, 'queued');
  assert.equal(batch.tasks[0].signatureJobError, '');
  assert.ok(callLog.includes('removeFileIfExists'));
  assert.ok(callLog.includes('queueJob'));
  assert.ok(callLog.includes('saveBatch'));
});

test('updateTask automatically queues website signature when passport fields become ready', async () => {
  const { batch, callLog, service } = createService({
    batch: {
      id: 'batch_1',
      name: 'Batch 1',
      tasks: [
        {
          id: 'task_1',
          docTypeFinal: 'passport',
          machineState: 'completed',
          sourceType: 'uploaded',
          classificationConfirmed: true,
          extractedNameFinal: 'ANG LIMIN',
          passportNoFinal: 'E12345678',
          chineseNameFinal: '',
          signatureStyle: 'default',
          signatureJobStatus: 'idle',
          signatureJobError: '',
          finalSignatureSource: '',
          finalSignaturePath: '',
          reviewed: false,
          reviewedAt: '',
          rephotoRequested: false,
          sourceImagePath: 'source/a.jpg',
        },
      ],
    },
    didEditableWorkflowChange: () => true,
    recalcTask: (task) => {
      callLog.push('recalcTask');
      task.processResult = '\u5f85\u7b7e\u5b57';
    },
    applyComputedFields: (_batchInput, task) => ({
      id: task.id,
      chineseNameFinal: task.chineseNameFinal,
      signatureJobStatus: task.signatureJobStatus,
      processResult: task.processResult,
    }),
  });

  const payload = await service.updateTask({
    batchId: batch.id,
    taskId: 'task_1',
    body: {
      chineseNameFinal: '\u5f20\u4e09',
    },
  });

  assert.equal(payload.status, 200);
  assert.equal(batch.tasks[0].signatureJobStatus, 'queued');
  assert.equal(batch.tasks[0].signatureJobError, '');
  assert.equal(batch.tasks[0].reviewed, false);
  assert.deepEqual(payload.body.task, {
    id: 'task_1',
    chineseNameFinal: '\u5f20\u4e09',
    signatureJobStatus: 'queued',
    processResult: '\u5f85\u7b7e\u5b57',
  });
  assert.ok(callLog.includes('queueJob'));
  assert.ok(callLog.includes('saveBatch'));
});

test('updateTask does not auto-retry a failed signature until the name or style changes', async () => {
  const { batch, callLog, service } = createService({
    batch: {
      id: 'batch_1',
      name: 'Batch 1',
      tasks: [
        {
          id: 'task_1',
          docTypeFinal: 'passport',
          machineState: 'completed',
          sourceType: 'uploaded',
          classificationConfirmed: true,
          extractedNameFinal: 'ANG LIMIN',
          passportNoFinal: 'E12345678',
          chineseNameFinal: '\u5f20\u4e09',
          signatureStyle: 'default',
          signatureJobStatus: 'failed',
          signatureJobError: 'network failed',
          finalSignatureSource: '',
          finalSignaturePath: '',
          reviewed: false,
          reviewedAt: '',
          rephotoRequested: false,
          sourceImagePath: 'source/a.jpg',
        },
      ],
    },
    syncWebsiteSignatureAfterFieldChange: (_previousTask, nextTask) => {
      nextTask.chineseNameFinal = String(nextTask.chineseNameFinal || '').trim();
      return false;
    },
    recalcTask: (task) => {
      callLog.push('recalcTask');
      task.processResult = '\u5f85\u7b7e\u5b57';
    },
  });

  const payload = await service.updateTask({
    batchId: batch.id,
    taskId: 'task_1',
    body: {
      reviewNote: 'retry later',
    },
  });

  assert.equal(payload.status, 200);
  assert.equal(batch.tasks[0].signatureJobStatus, 'failed');
  assert.equal(batch.tasks[0].signatureJobError, 'network failed');
  assert.equal(callLog.includes('queueJob'), false);
});

test('saveManualSignature writes the file and switches the task to manual signature state', async () => {
  const { batch, callLog, service } = createService({
    batchSubdirs: () => ({
      finalSignatures: '/tmp/batch_1/final_signatures',
    }),
  });
  batch.tasks[0].version = 3;

  const payload = await service.saveManualSignature({
    batchId: batch.id,
    taskId: 'task_1',
    dataUrl: 'data:image/png;base64,aGVsbG8=',
  });

  assert.equal(payload.status, 200);
  assert.deepEqual(payload.body, {
    ok: true,
    task: {
      id: 'task_1',
      extractedNameFinal: '',
      reviewed: true,
      processResult: '待终审',
    },
  });
  assert.equal(batch.tasks[0].finalSignatureSource, 'manual');
  assert.equal(batch.tasks[0].finalSignaturePath, 'final_signatures/task_1__manual_signature.png');
  assert.equal(batch.tasks[0].rephotoRequested, false);
  assert.equal(batch.tasks[0].version, 4);
  assert.ok(callLog.includes('clearWebsiteFinalSignatureAsset'));
  assert.ok(callLog.some((entry) => entry.startsWith('writeFile:/tmp/batch_1/final_signatures/task_1__manual_signature.png:')));
  assert.ok(callLog.includes('saveBatch'));
});

test('saveManualSignature waits for async signature file persistence before saving the batch', async () => {
  const callLog = [];
  let resolveWrite;
  const writeStarted = new Promise((resolve) => {
    resolveWrite = resolve;
  });
  const { batch, service } = createService({
    saveBatchAsync: () => {
      callLog.push('saveBatch');
    },
    clearWebsiteFinalSignatureAsset: () => {
      callLog.push('clearWebsiteFinalSignatureAsset');
    },
    batchSubdirs: () => ({
      finalSignatures: '/tmp/batch_1/final_signatures',
    }),
    fileSystem: {
      promises: {
        async writeFile(filePath, buffer) {
          callLog.push(`writeFile:${filePath}:${buffer.length}`);
          await writeStarted;
          callLog.push('writeFileDone');
        },
      },
    },
  });

  const pending = service.saveManualSignature({
    batchId: batch.id,
    taskId: 'task_1',
    dataUrl: 'data:image/png;base64,aGVsbG8=',
  });
  await Promise.resolve();

  assert.deepEqual(callLog, ['clearWebsiteFinalSignatureAsset', 'writeFile:/tmp/batch_1/final_signatures/task_1__manual_signature.png:5']);
  resolveWrite();
  const payload = await pending;

  assert.equal(payload.status, 200);
  assert.deepEqual(callLog, [
    'clearWebsiteFinalSignatureAsset',
    'writeFile:/tmp/batch_1/final_signatures/task_1__manual_signature.png:5',
    'writeFileDone',
    'saveBatch',
  ]);
});

test('百货身份护栏走真实写路径:免税小票 PATCH 夹带护照号/英文名 → 拒收不落盘;百货放行(2026-07-14 复审 MEDIUM)', async () => {
  const batch = {
    id: 'batch_g', name: 'g',
    tasks: [
      { id: 'duty_r', docTypeFinal: 'receipt', receiptStoreFinal: 'LOTTE', passportNoFinal: '', extractedNameFinal: '', reviewed: false, sourceImagePath: 'source/a.jpg' },
      { id: 'dept_r', docTypeFinal: 'receipt', receiptStoreFinal: 'LOTTE_DEPT', passportNoFinal: '', extractedNameFinal: '', reviewed: false, sourceImagePath: 'source/b.jpg' },
    ],
  };
  const { service } = createService({ batch });

  // 免税小票:normalizer 有意丢弃非空身份值——调用方不得 ?? 回填(曾被架空)
  await service.updateTask({ batchId: 'batch_g', taskId: 'duty_r', body: { receiptStoreFinal: 'LOTTE', passportNoFinal: 'EQ1234567', extractedNameFinal: 'ZHANG SAN' } });
  const duty = batch.tasks.find((t) => t.id === 'duty_r');
  assert.equal(duty.passportNoFinal, '', '免税小票不得夹带护照号');
  assert.equal(duty.extractedNameFinal, '', '免税小票不得夹带英文名');

  // 百货小票:同框身份合法,照常归一落盘
  await service.updateTask({ batchId: 'batch_g', taskId: 'dept_r', body: { receiptStoreFinal: 'LOTTE_DEPT', passportNoFinal: 'eq7654321' } });
  const dept = batch.tasks.find((t) => t.id === 'dept_r');
  assert.equal(dept.passportNoFinal, 'EQ7654321', '百货身份放行并归一');
});

// B5(2026-07-16 同步一致性审计):已结算组的票不可删(台账证据保护);未结算组照旧可删
test('deleteTask blocks tasks in settled groups with 409 (ledger evidence protection)', async () => {
  const batch = {
    id: 'batch_settled',
    sourceGroups: [
      { key: 'g_settled', settledAt: '2026-07-16T00:00:00.000Z', settlementStatus: 'settled' },
      { key: 'g_open' },
    ],
    tasks: [
      { id: 'task_s', sourceGroupKey: 'g_settled', reviewed: true },
      { id: 'task_o', sourceGroupKey: 'g_open' },
    ],
  };
  const { service } = createService({ batch });

  const blocked = await service.deleteTask({ batchId: 'batch_settled', taskId: 'task_s' });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, 'delete_blocked_settled');
  assert.equal(batch.tasks.length, 2, '已结算组的票必须原样保留');

  const allowed = await service.deleteTask({ batchId: 'batch_settled', taskId: 'task_o' });
  assert.equal(allowed.status, 200);
  assert.equal(batch.tasks.length, 1, '未结算组照旧可删');
});

// L152(2026-07-23 拍板「禁止编辑已结算组·引导台账订正」):已结算组的原始票改字段会被去重静默吞掉,
// 直接 409 引导走台账订正;豁免 sourceType='manual'(同图补小票的新票,正等审核+re-settle);
// 未结算组照常可改。
function settledBatchFixture() {
  const t = (id, over) => ({
    id, docTypeFinal: 'receipt', extractedNameFinal: '', passportNoFinal: '', chineseNameFinal: '',
    receiptStoreFinal: 'LOTTE', receiptNoFinal: '111', groupNoFinal: '', purchaseDateFinal: '', departureDateFinal: '',
    signatureStyle: 'default', reviewNote: '', finalSignatureSource: '', finalSignaturePath: '',
    reviewed: true, reviewedAt: '2026-07-01T00:00:00.000Z', rephotoRequested: false, sourceImagePath: 'source/a.jpg',
    sourceType: 'imported', ...over,
  });
  return {
    id: 'batch_s', name: 'S',
    tasks: [
      t('t_settled', { sourceGroupKey: 'gSettled' }), // 已结算组的原始票
      t('t_manual', { sourceGroupKey: 'gSettled', sourceType: 'manual' }), // 同图补小票新加的票
      t('t_open', { sourceGroupKey: 'gOpen' }), // 未结算组的票
    ],
    sourceGroups: [
      { key: 'gSettled', label: '已结算组', settledAt: '2026-07-01T00:00:00.000Z' },
      { key: 'gOpen', label: '未结算组' },
    ],
  };
}

test('L152:已结算组的原始票改字段 → 409 edit_blocked_settled 引导台账订正', async () => {
  const { service } = createService({ batch: settledBatchFixture() });
  const payload = await service.updateTask({ batchId: 'batch_s', taskId: 't_settled', body: { receiptNoFinal: '999' } });
  assert.equal(payload.status, 409, '已结算组原始票改字段被拦');
  assert.equal(payload.body.code, 'edit_blocked_settled');
});

test('L152:已结算组内 manual(同图补小票)票仍可改,补图审核流程不被拦', async () => {
  const { service } = createService({ batch: settledBatchFixture() });
  const payload = await service.updateTask({ batchId: 'batch_s', taskId: 't_manual', body: { receiptNoFinal: '999' } });
  assert.equal(payload.status, 200, 'manual 补图票豁免,可正常审核');
});

test('L152:未结算组的票照常可改(守卫只拦已结算)', async () => {
  const { service } = createService({ batch: settledBatchFixture() });
  const payload = await service.updateTask({ batchId: 'batch_s', taskId: 't_open', body: { receiptNoFinal: '999' } });
  assert.equal(payload.status, 200, '未结算组不拦');
});
