const test = require('node:test');
const assert = require('node:assert/strict');

const { DOC_TYPES } = require('../lib/package_constants');
const {
  DEFAULT_SIGNATURE_STYLE,
  PROCESS_RESULTS,
  SIGNATURE_STYLE_OPTIONS,
  STATUS_OPTIONS,
  buildWorkflowMeta,
  getDocTypeFieldRuleSet,
} = require('../lib/workbench_definition');

test('status options keep all first and include all workflow statuses in order', () => {
  assert.deepEqual(STATUS_OPTIONS, [
    '全部',
    PROCESS_RESULTS.CLASSIFY,
    PROCESS_RESULTS.FIELDS,
    PROCESS_RESULTS.SIGNATURE,
    PROCESS_RESULTS.FINAL_REVIEW,
    PROCESS_RESULTS.APPROVED,
    PROCESS_RESULTS.REPHOTO,
  ]);
});

test('passport rule set skips signature (2026-06-12 下线) and keeps two key fields', () => {
  // 2026-07-02 中文名移出必填:前端 6-30 已下线该字段,后端规则同步退役
  // (否则 OCR 没抽到中文名时审核报"还缺中文名",界面又没输入框 → 死锁)。
  const rules = getDocTypeFieldRuleSet(DOC_TYPES.PASSPORT);
  assert.equal(rules.needsSignature, false);
  assert.equal(rules.fields.length, 2);
  assert.deepEqual(rules.fields.map((field) => field.validation?.type), [
    'english_name',
    'passport_no',
  ]);
});

test('receipt rule set skips signature and requires receipt store plus receipt fields', () => {
  const rules = getDocTypeFieldRuleSet(DOC_TYPES.RECEIPT);
  assert.equal(rules.needsSignature, false);
  assert.equal(rules.fields.length, 5);
  assert.deepEqual(rules.fields.map((field) => field.finalKey), [
    'receiptStoreFinal',
    'receiptNoFinal',
    'groupNoFinal',
    'purchaseDateFinal',
    'departureDateFinal',
  ]);
  assert.deepEqual(rules.fields.map((field) => field.validation?.type), [
    'receipt_store',
    'receipt_no',
    'group_no',
    'purchase_date',
    'departure_date',
  ]);
});

test('other rule set has no required fields and no signature requirement', () => {
  const rules = getDocTypeFieldRuleSet(DOC_TYPES.OTHER);
  assert.equal(rules.needsSignature, false);
  assert.deepEqual(rules.fields, []);
});

test('workflow meta exposes only passport, receipt, and other doc type labels to the frontend', () => {
  const workflowMeta = buildWorkflowMeta();
  assert.equal(workflowMeta.signature.defaultStyle, DEFAULT_SIGNATURE_STYLE);
  assert.deepEqual(workflowMeta.signature.styleOptions, SIGNATURE_STYLE_OPTIONS);
  assert.equal(workflowMeta.docTypeLabels[DOC_TYPES.PASSPORT], '护照');
  assert.equal(workflowMeta.docTypeLabels[DOC_TYPES.RECEIPT], '小票');
  assert.equal(workflowMeta.docTypeLabels[DOC_TYPES.OTHER], '其他');
  assert.equal(Object.prototype.hasOwnProperty.call(workflowMeta.docTypeLabels, DOC_TYPES.TICKET), false);
});
