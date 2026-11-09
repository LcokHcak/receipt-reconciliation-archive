'use strict';

/**
 * Sprint F F8 was originally a generic PendingReviewsView. G15 v2 moved
 * monthly pending work into domain-specific pages:
 * - field_conflict / ambiguous_match / fuzzy_match -> BillReviewView
 * - agent_mismatch / mode_unresolved -> daily remedy
 * - second_pass_candidate -> unreceived list
 *
 * Keep the API wrapper for shared backend calls, but the monthly v2 UI route
 * now redirects away from the generic PendingReviewsView.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const exists = (file) => fs.existsSync(path.join(root, file));

test('F8 t1: api/v2/pendingReviews.js still exports fetch + resolve via axios client', () => {
  assert.equal(exists('frontend/src/api/v2/pendingReviews.js'), true);
  const src = read('frontend/src/api/v2/pendingReviews.js');
  assert.match(src, /export function fetchPendingReviews\b/);
  assert.match(src, /export function resolvePendingReview\b/);
  assert.match(src, /from ['"]\.\.\/client['"]/);
  assert.match(src, /\/pending-reviews/);
});

test('F8 t2: api/v2/conflicts.js re-exports fetchPendingReviews from pendingReviews', () => {
  const src = read('frontend/src/api/v2/conflicts.js');
  assert.match(src, /export\s*\{\s*fetchPendingReviews\s*\}\s*from\s*['"]\.\/pendingReviews['"]/);
  assert.match(src, /export function resolveConflict\b/);
});

test('F8 t3: resolvePendingReview keeps the Sprint1 fallback payload shape', () => {
  const src = read('frontend/src/api/v2/pendingReviews.js');
  const fn = src.match(/resolvePendingReview[\s\S]*?\n\}/);
  assert.ok(fn, 'function body found');
  assert.doesNotMatch(fn[0], /decision/);
  assert.match(fn[0], /status:/);
  assert.match(fn[0], /resolution:/);
});

test('G15: /pending-reviews route redirects to bill-review and generic view is removed', () => {
  const router = read('frontend/src/router/index.js');
  assert.ok(router.includes('/monthly/v2/:workspaceKey/pending-reviews'));
  assert.match(router, /monthly\/v2\/:workspaceKey\/pending-reviews[\s\S]+bill-review/);
  assert.match(router, /monthly\/:workspaceKey\/pending-reviews[\s\S]+bill-review/);
  assert.doesNotMatch(router, /v2-monthly-pending-reviews/);
  assert.doesNotMatch(router, /PendingReviewsView\.vue/);
  assert.equal(exists('frontend/src/views/v2/PendingReviewsView.vue'), false);
});

test('G15: BillReviewView owns field, ambiguous, and fuzzy pending work', () => {
  const view = read('frontend/src/views/v2/BillReviewView.vue');
  assert.match(view, /field_conflict/);
  assert.match(view, /ambiguous_match/);
  assert.match(view, /fuzzy_match/);
  assert.match(view, /fetchPendingReviews/);
  assert.match(view, /resolvePendingReview/);
});

test('G15: BillReviewView prompts single-row rerun after key field edits', () => {
  const view = read('frontend/src/views/v2/BillReviewView.vue');
  assert.match(view, /receiptNo/);
  assert.match(view, /passportNo/);
  assert.match(view, /tourNo/);
  assert.match(view, /rerunBillMatchRow/);
  assert.match(view, /window\.confirm/);
});

test('G15: sidebar no longer exposes the generic pending reviews entry', () => {
  const sidebar = read('frontend/src/layouts/AppSidebar.vue');
  assert.doesNotMatch(sidebar, /pending-reviews/);
  assert.doesNotMatch(sidebar, /待人审/);
  assert.match(sidebar, /bill-review/);
  assert.match(sidebar, /账单核对/);
});

test('F8 t9: ConflictsView can still import pending review helpers for legacy conflict flow', () => {
  const view = read('frontend/src/views/v2/ConflictsView.vue');
  assert.match(view, /import\s*\{\s*fetchPendingReviews\s*,\s*resolveConflict\s*\}\s*from\s*['"]@\/api\/v2\/conflicts['"]/);
});
