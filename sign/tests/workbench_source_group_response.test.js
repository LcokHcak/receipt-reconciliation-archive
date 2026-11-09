const test = require('node:test');
const assert = require('node:assert/strict');

const { createWorkbenchSourceGroupResponseBuilder } = require('../lib/workbench_source_group_response');

test('source group response builder adds task counts and attachment URLs', () => {
  const { buildResponseSourceGroups } = createWorkbenchSourceGroupResponseBuilder({
    toStorageUrl: (batchId, relativePath) => `/storage/${batchId}/${relativePath}`,
  });
  const batch = {
    id: 'batch-1',
    sourceGroups: [{
      key: 'group-a',
      folderPath: 'CL001',
      label: 'CL001',
      attachmentFiles: [{ id: 'att-1', originalFileName: 'bill.xlsx', storedRelativePath: 'attachments/bill.xlsx', extension: '.xlsx' }],
    }],
    tasks: [
      { id: 'task-1', sourceGroupKey: 'group-a', machineState: 'completed' },
      { id: 'task-2', sourceGroupKey: 'group-a', machineState: 'queued' },
    ],
  };

  assert.deepEqual(buildResponseSourceGroups(batch), [{
    key: 'group-a',
    folderPath: 'CL001',
    label: 'CL001',
    settledAt: '', // 组级结算状态(P2):未结算默认空,随 sourceGroups 透传给前端
    settlementStatus: '',
    tourConfirm: null,
    ledgerCorrections: [], // 台账订正留痕(e0fe887 起进 sourceGroups 白名单,默认空数组)
    taskCount: 2,
    completedCount: 1,
    attachmentFiles: [{
      id: 'att-1',
      originalFileName: 'bill.xlsx',
      storedRelativePath: 'attachments/bill.xlsx',
      extension: '.xlsx',
      url: '/storage/batch-1/attachments/bill.xlsx',
    }],
  }]);
});

test('source group response builder counts tasks with linear group-key reads', () => {
  const { buildResponseSourceGroups } = createWorkbenchSourceGroupResponseBuilder({
    toStorageUrl: () => '',
  });
  const groups = Array.from({ length: 80 }, (_, index) => ({
    key: `group-${index}`,
    folderPath: `CL${index}`,
    label: `CL${index}`,
  }));
  let groupKeyReads = 0;
  const tasks = groups.flatMap((group) => Array.from({ length: 5 }, (_, index) => ({
    id: `${group.key}-task-${index}`,
    get sourceGroupKey() {
      groupKeyReads += 1;
      return group.key;
    },
    machineState: index % 2 === 0 ? 'completed' : 'queued',
  })));

  const response = buildResponseSourceGroups({
    id: 'batch-1',
    sourceGroups: groups,
    tasks,
  });

  assert.equal(response.length, 80);
  assert.ok(groupKeyReads <= tasks.length + 5, `expected linear group-key reads, got ${groupKeyReads}`);
});
