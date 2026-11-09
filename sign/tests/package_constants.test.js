const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_REVIEW_STATE,
  DOC_TYPES,
  EXCEL_EXTENSIONS,
  IMAGE_EXTENSIONS,
  REVIEW_STATUSES,
  TASK_TYPES,
} = require('../lib/package_constants');

test('package constants expose the supported image and excel extensions', () => {
  assert.deepEqual(IMAGE_EXTENSIONS, ['.jpg', '.jpeg', '.png']);
  assert.deepEqual(EXCEL_EXTENSIONS, ['.xlsx', '.xls']);
});

test('package constants expose stable document and task type enums', () => {
  assert.deepEqual(DOC_TYPES, {
    PASSPORT: 'passport',
    RECEIPT: 'receipt',
    OTHER: 'other',
    EXCEL: 'excel',
  });

  assert.deepEqual(TASK_TYPES, {
    PASSPORT: 'passport',
    RECEIPT: 'receipt',
  });
});

test('package constants expose review status defaults', () => {
  assert.deepEqual(REVIEW_STATUSES, {
    PENDING: 'pending',
    REVIEW_REQUIRED: 'review_required',
    REVIEWED: 'reviewed',
  });

  assert.deepEqual(DEFAULT_REVIEW_STATE, {
    needsReview: false,
    reviewReasons: [],
    reviewStatus: 'pending',
  });
});
