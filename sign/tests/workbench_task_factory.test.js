const test = require('node:test');
const assert = require('node:assert/strict');

const { DOC_TYPES } = require('../lib/package_constants');
const { ROOT_SOURCE_GROUP_KEY } = require('../lib/source_group_utils');
const {
  createImportedImageTask,
  createManualReceiptTaskFromSource,
  createManualTask,
} = require('../lib/workbench_task_factory');

test('createManualTask creates a root-level manual task', () => {
  const task = createManualTask('custom_label');

  assert.match(task.id, /^task_manual_/);
  assert.equal(task.originalFileName, 'custom_label');
  assert.equal(task.sourceType, 'manual');
  assert.equal(task.sourceGroupKey, ROOT_SOURCE_GROUP_KEY);
  assert.equal(task.docTypeFinal, DOC_TYPES.PASSPORT);
  assert.equal(task.classificationConfirmed, false);
  assert.equal(task.sourceImagePath, '');
  assert.equal(task.version, 1);
});

test('createManualReceiptTaskFromSource inherits current image and group context', () => {
  const sourceTask = {
    id: 'task_a1',
    sourceImagePath: 'source/task_a1__receipt.jpg',
    sourceOriginalPath: 'traveler-a/receipt.jpg',
    sourceFileName: 'receipt.jpg',
    sourceFolderName: 'traveler-a',
    sourceFolderPath: 'traveler-a',
    sourceKey: 'traveler-a/receipt.jpg',
    sourceGroupKey: 'traveler-a',
    sourceGroupLabel: 'traveler-a',
    customerAgentName: 'Agent Han',
  };

  const task = createManualReceiptTaskFromSource(sourceTask);

  assert.match(task.id, /^task_manual_/);
  assert.equal(task.sourceType, 'manual');
  assert.equal(task.docTypeFinal, DOC_TYPES.RECEIPT);
  assert.equal(task.classificationConfirmed, true);
  assert.equal(task.version, 1);
  assert.equal(task.sourceImagePath, sourceTask.sourceImagePath);
  assert.equal(task.sourceGroupKey, sourceTask.sourceGroupKey);
  assert.equal(task.sourceGroupLabel, sourceTask.sourceGroupLabel);
  assert.equal(task.customerAgentName, 'Agent Han');
  assert.match(task.originalFileName, /^manual_receipt_/);
  assert.match(task.sourceKey, /#manual_receipt_/);
});

test('createImportedImageTask creates a queued uploaded task with source-group context', () => {
  const task = createImportedImageTask({
    taskId: 'task_001',
    originalFileName: 'passport.jpg',
    sourceImagePath: 'source/task_001__passport.jpg',
    sourceOriginalPath: '202604/CL20260420-001/passport.jpg',
    sourceFileName: 'passport.jpg',
    sourceFolderName: 'CL20260420-001',
    sourceFolderPath: 'CL20260420-001',
    sourceGroupKey: 'group_abc123',
    sourceGroupLabel: 'CL20260420-001',
    customerAgentName: 'Agent Han',
  });

  assert.equal(task.id, 'task_001');
  assert.equal(task.sourceType, 'uploaded');
  assert.equal(task.machineState, 'queued');
  assert.equal(task.classificationConfirmed, false);
  assert.equal(task.version, 1);
  assert.equal(task.sourceGroupKey, 'group_abc123');
  assert.equal(task.sourceGroupLabel, 'CL20260420-001');
  assert.equal(task.customerAgentName, 'Agent Han');
  assert.equal(task.sourceImagePath, 'source/task_001__passport.jpg');
  assert.equal(task.sourceOriginalPath, '202604/CL20260420-001/passport.jpg');
  assert.equal(task.docTypeFinal, DOC_TYPES.PASSPORT);
});
