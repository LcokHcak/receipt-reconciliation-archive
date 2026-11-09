const test = require('node:test');
const assert = require('node:assert/strict');

const { DOC_TYPES } = require('../lib/package_constants');
const { getWebsiteSignatureEligibilityIssue } = require('../lib/signature_queue');
const { recoverCompletedStateAfterManualReview } = require('../lib/workbench_task_recovery');

test('recoverCompletedStateAfterManualReview completes an OCR-error passport after manual fields are complete', () => {
  const task = {
    machineState: 'error',
    error: 'OCR failed',
    ocrError: 'OCR failed',
    sourceType: 'uploaded',
    docTypeFinal: DOC_TYPES.PASSPORT,
    classificationConfirmed: true,
    extractedNameFinal: 'SUN XIN RUI',
    passportNoFinal: 'EM9432012',
    chineseNameFinal: '孙鑫蕊',
    finalSignaturePath: '',
    finalSignatureSource: '',
  };

  assert.equal(recoverCompletedStateAfterManualReview(task), true);
  assert.equal(task.machineState, 'completed');
  assert.equal(task.error, '');
  assert.equal(task.ocrError, '');
  assert.equal(getWebsiteSignatureEligibilityIssue(task), '');
});

test('recoverCompletedStateAfterManualReview keeps error state when manual fields are still missing', () => {
  // 2026-07-02 中文名退役后不再构成缺字段 → 改用护照号缺失验证"还缺字段保持error"路径
  const task = {
    machineState: 'error',
    error: 'OCR failed',
    ocrError: 'OCR failed',
    sourceType: 'uploaded',
    docTypeFinal: DOC_TYPES.PASSPORT,
    classificationConfirmed: true,
    extractedNameFinal: 'SUN XIN RUI',
    passportNoFinal: '',
  };

  assert.equal(recoverCompletedStateAfterManualReview(task), false);
  assert.equal(task.machineState, 'error');
  assert.equal(task.error, 'OCR failed');
  assert.equal(task.ocrError, 'OCR failed');
});

test('recoverCompletedStateAfterManualReview completes a manually fixed task even after it was resumed as processing', () => {
  const task = {
    machineState: 'processing',
    error: '',
    ocrError: 'old OCR failure',
    sourceType: 'uploaded',
    docTypeFinal: DOC_TYPES.PASSPORT,
    classificationConfirmed: true,
    extractedNameFinal: 'SUN XIN RUI',
    passportNoFinal: 'EM9432012',
    chineseNameFinal: '\u5b59\u946b\u854a',
    finalSignaturePath: '',
    finalSignatureSource: '',
  };

  assert.equal(recoverCompletedStateAfterManualReview(task), true);
  assert.equal(task.machineState, 'completed');
  assert.equal(task.error, '');
  assert.equal(task.ocrError, '');
  assert.equal(getWebsiteSignatureEligibilityIssue(task), '');
});
