const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getDeletableTaskArtifactRelativePaths,
  getTaskArtifactRelativePaths,
} = require('../lib/workbench_task_artifacts');

test('getTaskArtifactRelativePaths de-duplicates blank and repeated paths', () => {
  const task = {
    sourceImagePath: 'source/shared.jpg',
    rawJsonPath: 'raw/task-a.json',
    initialRawJsonPath: 'raw/task-a.json',
    signatureRegionPath: '',
    finalSignaturePath: 'final/task-a.png',
  };

  assert.deepEqual(getTaskArtifactRelativePaths(task), [
    'source/shared.jpg',
    'raw/task-a.json',
    'final/task-a.png',
  ]);
});

test('getDeletableTaskArtifactRelativePaths keeps shared source image when other tasks still reference it', () => {
  const deletedTask = {
    sourceImagePath: 'source/shared.jpg',
    rawJsonPath: 'raw/task-b.json',
    initialRawJsonPath: 'raw/task-b.initial.json',
    signatureRegionPath: 'signature_regions/task-b.png',
    finalSignaturePath: '',
  };
  const remainingTasks = [
    {
      id: 'task-a',
      sourceImagePath: 'source/shared.jpg',
      rawJsonPath: 'raw/task-a.json',
      initialRawJsonPath: '',
      signatureRegionPath: '',
      finalSignaturePath: '',
    },
  ];

  assert.deepEqual(getDeletableTaskArtifactRelativePaths(deletedTask, remainingTasks), [
    'raw/task-b.json',
    'raw/task-b.initial.json',
    'signature_regions/task-b.png',
  ]);
});
