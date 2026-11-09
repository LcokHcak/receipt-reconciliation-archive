const test = require('node:test');
const assert = require('node:assert/strict');

const { ROOT_SOURCE_GROUP_KEY, ROOT_SOURCE_GROUP_LABEL } = require('../lib/source_group_utils');
const { DOC_TYPES } = require('../lib/package_constants');
const { createWorkbenchSqliteSyncService } = require('../services/workbench_sqlite_sync_service');

function createSyncService() {
  return createWorkbenchSqliteSyncService({
    sqliteRepository: {
      replaceBatchProjection(projection) {
        return projection;
      },
      deleteBatch() {},
      getCounts() {
        return {
          batchCount: 0,
          travelerGroupCount: 0,
          receiptRecordCount: 0,
          passportRecordCount: 0,
        };
      },
    },
  });
}

test('buildProjection falls back to the root source group label when a task has no folder metadata', () => {
  const syncService = createSyncService();

  const projection = syncService.buildProjection({
    id: 'batch_demo',
    name: 'Demo Batch',
    scenario: 'FullProcess',
    createdAt: '2026-04-17T00:00:00.000Z',
    updatedAt: '2026-04-17T00:00:00.000Z',
    machineState: 'completed',
    sourceGroups: [],
    tasks: [
      {
        id: 'task_root_1',
        sourceGroupKey: ROOT_SOURCE_GROUP_KEY,
        sourceGroupLabel: '',
        docTypeFinal: DOC_TYPES.PASSPORT,
        sourceImagePath: 'source/a.jpg',
        processResult: '待分类确认',
      },
    ],
  });

  assert.equal(projection.travelerGroups.length, 1);
  assert.equal(projection.travelerGroups[0].folder_key, ROOT_SOURCE_GROUP_KEY);
  assert.equal(projection.travelerGroups[0].folder_name, ROOT_SOURCE_GROUP_LABEL);
});

test('buildProjection keeps manual tasks as receipt records', () => {
  const syncService = createSyncService();

  const projection = syncService.buildProjection({
    id: 'batch_manual',
    name: 'Manual Batch',
    scenario: 'FullProcess',
    createdAt: '2026-04-17T00:00:00.000Z',
    updatedAt: '2026-04-17T00:00:00.000Z',
    machineState: 'completed',
    sourceGroups: [
      {
        key: 'traveler_1',
        label: 'ZHANG SAN',
        folderPath: 'ZHANG SAN',
        attachmentFiles: [],
      },
    ],
    tasks: [
      {
        id: 'manual_receipt_1',
        sourceGroupKey: 'traveler_1',
        sourceGroupLabel: 'ZHANG SAN',
        docTypeFinal: DOC_TYPES.RECEIPT,
        sourceType: 'manual',
        sourceImagePath: '',
        receiptNoFinal: 'R-1001',
        purchaseDateFinal: '2026-04-17',
        processResult: '待终审',
      },
    ],
  });

  assert.equal(projection.receiptRecords.length, 1);
  assert.equal(projection.receiptRecords[0].is_manual_added, 1);
  assert.equal(projection.receiptRecords[0].receipt_no, 'R-1001');
});

test('buildProjection derives record status from the shared workflow state contract', () => {
  const syncService = createSyncService();

  const projection = syncService.buildProjection({
    id: 'batch_workflow_state',
    name: 'Workflow State Batch',
    scenario: 'FullProcess',
    createdAt: '2026-04-17T00:00:00.000Z',
    updatedAt: '2026-04-17T00:00:00.000Z',
    machineState: 'completed',
    sourceGroups: [],
    tasks: [
      {
        id: 'receipt_missing_fields',
        sourceGroupKey: ROOT_SOURCE_GROUP_KEY,
        docTypeFinal: DOC_TYPES.RECEIPT,
        classificationConfirmed: true,
        receiptStoreFinal: 'LOTTE',
        workflowState: {
          processResult: '寰呰ˉ瀛楁',
          stage: 'fields',
        },
      },
    ],
  });

  assert.equal(projection.sourceImages[0].process_result, '寰呰ˉ瀛楁');
  assert.equal(projection.receiptRecords[0].status, 'draft');
  assert.equal(projection.batch.status, 'in_review');
});
