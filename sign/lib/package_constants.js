const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png'];
const EXCEL_EXTENSIONS = ['.xlsx', '.xls'];

const DOC_TYPES = Object.freeze({
  PASSPORT: 'passport',
  RECEIPT: 'receipt',
  OTHER: 'other',
  EXCEL: 'excel',
});

const TASK_TYPES = Object.freeze({
  PASSPORT: 'passport',
  RECEIPT: 'receipt',
});

const REVIEW_STATUSES = Object.freeze({
  PENDING: 'pending',
  REVIEW_REQUIRED: 'review_required',
  REVIEWED: 'reviewed',
});

const DEFAULT_REVIEW_STATE = Object.freeze({
  needsReview: false,
  reviewReasons: [],
  reviewStatus: REVIEW_STATUSES.PENDING,
});

module.exports = {
  DEFAULT_REVIEW_STATE,
  DOC_TYPES,
  EXCEL_EXTENSIONS,
  IMAGE_EXTENSIONS,
  REVIEW_STATUSES,
  TASK_TYPES,
};
