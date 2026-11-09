const test = require('node:test');
const assert = require('node:assert/strict');

// ── 无团号两路汇流(2026-07-20 行为三合一)回归 ────────────────────────────
// 病灶:字面量「无」(机场票哨兵)与 tourStance='none'(两步流表态)是同一业务语义,
// 但下游(确认硬闸/机场模式推断/组级回填/代理视图豁免)只认字面量——表态行被卡/丢模式。
// 收口:写入层表态自动回填「无」+ lib/no_tour 单源谓词兜存量。四件缺一即复发。

const { isNoTourTask, hasNoTourStance, NO_TOUR_LITERAL } = require('../lib/no_tour');
const { resolveTaskModeRule } = require('../lib/workbench_receipt_export');
const { createWorkbenchWriteService } = require('../services/workbench_write_service');
const { createTourConfirmService } = require('../services/tour_confirm_service');
const { createSourceGroup } = require('../lib/source_group_utils');

// ── 单源谓词 ─────────────────────────────────────────────────────────────
test('isNoTourTask:字面量「无」/表态none+空值 豁免;表态none+真团号不豁免', () => {
  assert.equal(isNoTourTask({ groupNoFinal: '无' }), true);
  assert.equal(isNoTourTask({ groupNoAuto: '无' }), true);
  assert.equal(isNoTourTask({ groupNoFinal: '', tourStance: 'none' }), true);
  // 表态后被 API 直改成真团号 → 按普通票走,绝不豁免
  assert.equal(isNoTourTask({ groupNoFinal: '71203', tourStance: 'none' }), false);
  assert.equal(isNoTourTask({ groupNoFinal: '' }), false);
  assert.equal(hasNoTourStance({ tourStance: 'none' }), true);
  assert.equal(hasNoTourStance({ tourStance: 'matched' }), false);
});

// ── 机场模式推断:表态路与字面量路产物一致 ────────────────────────────────
test('resolveTaskModeRule:表态none空团号 与 字面量「无」同出机场模式', () => {
  const base = { docTypeFinal: 'receipt', receiptNoFinal: '1712345678901234' };
  const literal = resolveTaskModeRule({ ...base, groupNoFinal: '无', groupNoMatchStatus: 'no_group' });
  const stanced = resolveTaskModeRule({ ...base, groupNoFinal: '', tourStance: 'none' });
  assert.equal(literal.mode, '新世界机场-振华');
  assert.equal(stanced.mode, '新世界机场-振华', '表态行此前丢成空模式(三处出口产物分家)');
  // 表态但团号被填了真值 → 不按机场走
  const real = resolveTaskModeRule({ ...base, groupNoFinal: '71203', tourStance: 'none' });
  assert.equal(real.mode, '');
  // 小票号不是 15/17 开头 → 两条路都不推机场
  const notAirport = resolveTaskModeRule({ docTypeFinal: 'receipt', receiptNoFinal: '9912345678901234', groupNoFinal: '', tourStance: 'none' });
  assert.equal(notAirport.mode, '');
});

// ── 确认硬闸(ENV 开):表态行豁免,不再 409 ─────────────────────────────
function makeTourConfirmService({ requireConfirm = '' } = {}) {
  return createTourConfirmService({
    groupCodePrematchHolder: {
      service: {
        lookupTour(batchId, tourNo) {
          if (String(tourNo).trim() === '71203') return { status: 'matched', mode: '乐天SG-本司', mismatchModes: '' };
          return { status: 'not_found', mode: '', mismatchModes: '' };
        },
        prematchTask() { return true; },
      },
    },
    tourConfirmLogRepo: { append: () => {} },
    sendbackQueueRepo: { enqueue: () => {} },
    slimModesEnv: () => '',
    requireConfirmEnv: () => requireConfirm,
    now: () => '2026-07-20T02:00:00.000Z',
  });
}

function stanceBatch(tasks) {
  return {
    id: 'batch_t',
    monthlyWorkspaceKey: '260720-小票01',
    sourceGroups: [createSourceGroup({ key: 'group_a', folderPath: 'CL-001', label: '测试组' })],
    tasks,
  };
}

test('assertTourConfirmed:表态none空团号组豁免(此前 ENV 硬闸下 approve/settle 双双 409)', () => {
  const svc = makeTourConfirmService({ requireConfirm: 'true' });
  const stancedOnly = stanceBatch([{
    id: 't1', sourceGroupKey: 'group_a', docTypeFinal: 'receipt',
    groupNoFinal: '', groupNoAuto: '', tourStance: 'none', receiptStoreFinal: 'THE SHILLA',
  }]);
  svc.assertTourConfirmed(stancedOnly, 'group_a'); // 不抛=豁免生效

  const untouched = stanceBatch([{
    id: 't2', sourceGroupKey: 'group_a', docTypeFinal: 'receipt',
    groupNoFinal: '71203', groupNoAuto: '', tourStance: '', receiptStoreFinal: 'THE SHILLA',
  }]);
  assert.throws(() => svc.assertTourConfirmed(untouched, 'group_a'), /团号还没确认/, '普通未确认组仍要拦');
});

test('confirmTour 回填:表态none行不被组团号覆盖(与机场票「无」同待遇)', () => {
  const svc = makeTourConfirmService();
  const batch = stanceBatch([
    { id: 'a', sourceGroupKey: 'group_a', docTypeFinal: 'receipt', groupNoFinal: '', groupNoAuto: '', receiptStoreFinal: 'THE SHILLA' },
    { id: 'b', sourceGroupKey: 'group_a', docTypeFinal: 'receipt', groupNoFinal: '', groupNoAuto: '', tourStance: 'none', receiptStoreFinal: 'THE SHILLA' },
  ]);
  svc.confirmTour(batch, 'group_a', { tourNo: '71203', source: 'majority', operator: '测试' });
  assert.equal(batch.tasks[0].groupNoFinal, '71203', '空号票正常回填');
  assert.equal(batch.tasks[1].groupNoFinal, '', '表态行绝不回填(此前被静默灌上组团号)');
});

// ── 写入层回填:表态即「无」,两条路物理汇流 ─────────────────────────────
function createWriteService(taskOverrides = {}) {
  const batch = {
    id: 'batch_1',
    name: 'Batch 1',
    tasks: [{
      id: 'task_1',
      version: 1,
      docTypeFinal: 'receipt',
      extractedNameFinal: '', passportNoFinal: '', chineseNameFinal: '',
      receiptStoreFinal: 'THE SHILLA', receiptNoFinal: '1712345678901234',
      groupNoFinal: '', groupNoAuto: '',
      purchaseDateFinal: '', departureDateFinal: '',
      signatureStyle: 'default', reviewNote: '',
      finalSignatureSource: '', finalSignaturePath: '',
      reviewed: false, reviewedAt: '', rephotoRequested: false,
      sourceImagePath: 'source/a.jpg',
      ...taskOverrides,
    }],
  };
  const service = createWorkbenchWriteService({
    defaultScenario: 'FullProcess',
    nowStamp: () => '20260720010101',
    withBatchWrite: async (_batchId, action) => action(),
    hasBatch: () => true,
    loadBatch: () => batch,
    saveBatchAsync: () => {},
    summarizeBatch: (b) => ({ id: b.id, taskCount: b.tasks.length }),
    buildBatchSkeleton: (batchId, name, scenario) => ({ id: batchId, name, scenario, machineState: 'queued', tasks: [], sourceGroups: [] }),
    batchSubdirs: () => ({}),
    createManualTaskFromFactory: () => ({ id: 'manual_task_1', docTypeFinal: 'passport' }),
    createManualReceiptTaskFromSource: (sourceTask) => ({ id: 'manual_receipt_1', sourceImagePath: sourceTask.sourceImagePath, docTypeFinal: 'receipt' }),
    normalizeFieldValue: (value) => String(value || '').trim(),
    resolveTask: (inputBatch, taskId) => inputBatch.tasks.find((t) => t.id === taskId) || null,
    normalizeTask: (task) => ({ ...task }),
    normalizeDocType: (value) => String(value || 'passport').trim() || 'passport',
    clearTaskSignatureArtifacts: () => {},
    clearEditableFieldsForDocTypeSwitch: (_task, nextDocType) => ({ docTypeFinal: nextDocType }),
    markClassificationConfirmed: (task) => { task.classificationConfirmed = true; },
    didEditableWorkflowChange: () => true,
    syncWebsiteSignatureAfterFieldChange: () => false,
    websiteSignatureSource: 'website',
    removeFileIfExists: () => {},
    resolveBatchRelativePath: (_batchId, rel) => rel,
    recoverCompletedStateAfterManualReview: () => {},
    recalcTask: () => {},
    touchTask: () => {},
    applyComputedFields: (task) => task,
  });
  return { batch, service };
}

test('updateTask:表态none自动回填「无」(写入层汇流)', async () => {
  const { batch, service } = createWriteService();
  const res = await service.updateTask({
    batchId: 'batch_1', taskId: 'task_1',
    body: { tourStance: 'none', groupNoFinal: '' },
  });
  assert.equal(res.status, 200);
  assert.equal(batch.tasks[0].groupNoFinal, NO_TOUR_LITERAL);
  assert.equal(batch.tasks[0].tourStance, 'none');
  assert.ok(batch.tasks[0].tourStancedAt, '表态时间服务端盖章');
});

test('updateTask:撤销表态回滚哨兵「无」;真团号不回滚', async () => {
  const { batch, service } = createWriteService({ tourStance: 'none', tourStancedAt: '2026-07-20T01:00:00.000Z', groupNoFinal: '无' });
  await service.updateTask({ batchId: 'batch_1', taskId: 'task_1', body: { tourStance: '' } });
  assert.equal(batch.tasks[0].groupNoFinal, '', '撤销表态恢复"必须重新表态"的强制力');

  const real = createWriteService({ tourStance: 'none', tourStancedAt: '2026-07-20T01:00:00.000Z', groupNoFinal: '71203' });
  await real.service.updateTask({ batchId: 'batch_1', taskId: 'task_1', body: { tourStance: '' } });
  assert.equal(real.batch.tasks[0].groupNoFinal, '71203', '人工敲过的真团号绝不动');
});

test('updateTask:旧草稿把「无」覆盖回空串 → 当场自愈(表态还在)', async () => {
  const { batch, service } = createWriteService({ tourStance: 'none', tourStancedAt: '2026-07-20T01:00:00.000Z', groupNoFinal: '无' });
  // 前端旧草稿(表态前拉的)保存:groupNoFinal='' 且不带 tourStance 键
  await service.updateTask({ batchId: 'batch_1', taskId: 'task_1', body: { groupNoFinal: '', reviewNote: 'x' } });
  assert.equal(batch.tasks[0].groupNoFinal, NO_TOUR_LITERAL, '表态仍在 → 空团号自动补回「无」');
});

test('updateTask:非小票不回填(护照任务带杂散表态也不吃「无」)', async () => {
  const { batch, service } = createWriteService({ docTypeFinal: 'passport', receiptStoreFinal: '', receiptNoFinal: '' });
  await service.updateTask({ batchId: 'batch_1', taskId: 'task_1', body: { tourStance: 'none' } });
  assert.equal(batch.tasks[0].groupNoFinal, '', '回填只对小票生效');
});
