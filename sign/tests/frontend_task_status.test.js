const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadTaskStatusModule() {
  return import(pathToFileURL(path.join(
    __dirname,
    '../frontend/src/lib/taskStatus.js'
  )).href);
}

test('task status shows OCR lifecycle before review confirmation', async () => {
  const { getTaskStatusState } = await loadTaskStatusModule();

  assert.deepEqual(getTaskStatusState({ machineState: 'queued' }), {
    label: '等待识别',
    tone: 'neutral',
  });
  assert.deepEqual(getTaskStatusState({ machineState: 'processing' }), {
    label: '识别中',
    tone: 'warning',
  });
  assert.deepEqual(getTaskStatusState({ machineState: 'completed', docTypeFinal: 'receipt' }), {
    label: '待确认',
    tone: 'warning',
  });
});

test('task status keeps final human review states above OCR states', async () => {
  const { getTaskStatusState } = await loadTaskStatusModule();

  assert.deepEqual(getTaskStatusState({ machineState: 'processing', rephotoRequested: true }), {
    label: '需重拍',
    tone: 'danger',
  });
  assert.deepEqual(getTaskStatusState({ machineState: 'completed', processResult: '已通过' }), {
    label: '已通过',
    tone: 'success',
  });
  assert.deepEqual(getTaskStatusState({ machineState: 'completed', reviewStatus: '已拒绝' }), {
    label: '已拒绝',
    tone: 'danger',
  });
});
