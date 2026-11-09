const test = require('node:test');
const assert = require('node:assert/strict');

const { DOC_TYPES } = require('../lib/package_constants');
const { PROCESS_RESULTS } = require('../lib/workbench_task_flow');
const { buildTaskWorkflowState } = require('../lib/workbench_workflow_state');

test('buildTaskWorkflowState exposes one backend workflow contract for a task', () => {
  const workflow = buildTaskWorkflowState({
    machineState: 'completed',
    docTypeFinal: DOC_TYPES.PASSPORT,
    classificationConfirmed: true,
    extractedNameFinal: 'ZHANG SAN',
    passportNoFinal: 'E12345678',
    chineseNameFinal: '张三',
    finalSignaturePath: 'final_signatures/task_1.png',
  });

  assert.equal(workflow.processResult, PROCESS_RESULTS.FINAL_REVIEW);
  assert.equal(workflow.stage, 'final_review');
  assert.equal(workflow.canApproveTask, true);
  assert.equal(workflow.fieldSummary.classificationConfirmed, true);
  assert.equal(workflow.fieldSummary.missingFields.length, 0);
  assert.equal(workflow.fieldSummary.invalidFields.length, 0);
});

test('buildTaskWorkflowState reports blocking fields with stable stage keys', () => {
  // 小票号已解禁(cb24667:非空即通过)→ '123' 不再是 invalid;改用团号(未解禁)验证 invalid 通道。
  const workflow = buildTaskWorkflowState({
    machineState: 'completed',
    docTypeFinal: DOC_TYPES.RECEIPT,
    classificationConfirmed: true,
    receiptStoreFinal: 'LOTTE',
    receiptNoFinal: '123',
    groupNoFinal: '99',
  });

  assert.equal(workflow.processResult, PROCESS_RESULTS.FIELDS);
  assert.equal(workflow.stage, 'fields');
  assert.equal(workflow.canApproveTask, false);
  assert.deepEqual(
    workflow.fieldSummary.missingFields.map((field) => field.key),
    ['purchaseDateFinal', 'departureDateFinal']
  );
  assert.deepEqual(
    workflow.fieldSummary.invalidFields.map((field) => field.key),
    ['groupNoFinal'] // LOTTE 纯数字团号需 8 位;小票号 '123' 解禁后合法
  );
});
