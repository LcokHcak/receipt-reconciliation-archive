const test = require('node:test');
const assert = require('node:assert/strict');

const { DOC_TYPES } = require('../lib/package_constants');
const {
  getWebsiteSignatureEligibilityIssue,
  isEligibleForWebsiteGeneration,
} = require('../lib/signature_queue');

test('receipt task is never eligible for website signature generation', () => {
  const eligible = isEligibleForWebsiteGeneration({
    docTypeFinal: DOC_TYPES.RECEIPT,
    sourceType: 'uploaded',
    machineState: 'completed',
    chineseNameFinal: '张三',
  });

  assert.equal(eligible, false);
});

test('passport task must confirm classification before queueing website signature', () => {
  const eligible = isEligibleForWebsiteGeneration({
    docTypeFinal: DOC_TYPES.PASSPORT,
    sourceType: 'uploaded',
    machineState: 'completed',
    chineseNameFinal: '张三',
    classificationConfirmed: false,
  });

  assert.equal(eligible, false);
});

test('website signature eligibility reports a concrete reason', () => {
  const issue = getWebsiteSignatureEligibilityIssue({
    docTypeFinal: DOC_TYPES.RECEIPT,
    sourceType: 'uploaded',
    machineState: 'completed',
    chineseNameFinal: '寮犱笁',
    classificationConfirmed: true,
  });

  assert.equal(issue, '非护照记录不需要生成网站签字');
});
