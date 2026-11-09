const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getTaskVersion,
  incrementTaskVersion,
  hasTaskVersionChanged,
  markStaleModelResultSkipped,
} = require('../lib/workbench_task_versioning');

test('getTaskVersion treats legacy tasks without a version as version 1', () => {
  assert.equal(getTaskVersion({}), 1);
  assert.equal(getTaskVersion({ version: 0 }), 1);
  assert.equal(getTaskVersion({ version: 'not-a-number' }), 1);
  assert.equal(getTaskVersion({ version: 4 }), 4);
});

test('incrementTaskVersion advances legacy and current task versions', () => {
  const legacyTask = {};
  const currentTask = { version: 7 };

  assert.equal(incrementTaskVersion(legacyTask), 2);
  assert.equal(legacyTask.version, 2);
  assert.equal(incrementTaskVersion(currentTask), 8);
  assert.equal(currentTask.version, 8);
});

test('hasTaskVersionChanged compares the latest task to the pending OCR snapshot', () => {
  assert.equal(hasTaskVersionChanged({ version: 1 }, { version: 1 }), false);
  assert.equal(hasTaskVersionChanged({}, {}), false);
  assert.equal(hasTaskVersionChanged({ version: 2 }, { version: 1 }), true);
  assert.equal(hasTaskVersionChanged({ version: 3 }, 2), true);
});

test('markStaleModelResultSkipped leaves user fields intact and exits processing state', () => {
  const calls = [];
  const task = {
    machineState: 'processing',
    error: 'old error',
    ocrError: 'old ocr error',
    extractedNameFinal: 'User Name',
  };

  markStaleModelResultSkipped(task, {
    recalcTask: (inputTask) => {
      calls.push(['recalcTask', inputTask.extractedNameFinal]);
      inputTask.processResult = 'field_review';
    },
    touchTask: (inputTask) => {
      calls.push(['touchTask', inputTask.processResult]);
    },
  });

  assert.equal(task.machineState, 'completed');
  assert.equal(task.error, '');
  assert.equal(task.ocrError, '');
  assert.equal(task.extractedNameFinal, 'User Name');
  assert.deepEqual(calls, [
    ['recalcTask', 'User Name'],
    ['touchTask', 'field_review'],
  ]);
});
