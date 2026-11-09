'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..', '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('G15 v2 bill-review route is registered and backed by a dedicated view', () => {
  const router = read('frontend/src/router/index.js');
  assert.match(router, /\/monthly\/v2\/:workspaceKey\/bill-review/);
  assert.match(router, /BillReviewView\.vue/);
});

test('G15 v2 bill-review API exposes conflicts, resolve, and row rerun calls', () => {
  const api = read('frontend/src/api/v2/billReview.js');
  assert.match(api, /bill-match\/conflicts/);
  assert.match(api, /bill-match\/resolve-conflict/);
  assert.match(api, /bill-match\/rerun-row/);
  assert.match(api, /bill-match\/daily-without-bill/);
});

test('G15 v2 bill-match routes receive the bucket service dependency in production wiring', () => {
  const server = read('workbench_server.js');
  const route = read('routes/monthly/bill_match_routes.js');
  const routeDeps = server.slice(
    server.indexOf('const monthlyRoutes = createMonthlyRoutes({'),
    server.indexOf('const app = createWorkbenchApp({')
  );

  assert.match(route, /if \(!billMatchBucketService\) return;/);
  assert.match(routeDeps, /billMatchBucketService:\s*monthlyBillMatchBucketService/);
});

test('G15 v2 bill-review page has field conflict, ambiguous, and fuzzy tabs with rerun prompt', () => {
  const view = read('frontend/src/views/v2/BillReviewView.vue');
  assert.match(view, /field_conflict/);
  assert.match(view, /ambiguous_match/);
  assert.match(view, /fuzzy_match/);
  assert.match(view, /daily_without_bill/);
  // 2026-06-12: 小票无账单改客户级(count-mismatch+direction),行级接口退役
  assert.match(view, /fetchCountMismatch/);
  assert.match(view, /direction/);
  assert.match(view, /receiptNo|passportNo|tourNo/);
  assert.match(view, /rerunBillMatchRow/);
});

test('G15 v2 bill-review page paginates review tabs server-side', () => {
  const view = read('frontend/src/views/v2/BillReviewView.vue');
  assert.match(view, /const PAGE_SIZE = 50/);
  assert.match(view, /pageState/);
  assert.match(view, /reasonType:\s*tab/);
  assert.match(view, /offset:\s*page\.offset/);
  assert.match(view, /goPage/);
});

test('G15 v2 bill-review applies fuzzy and ambiguous candidate decisions', () => {
  const view = read('frontend/src/views/v2/BillReviewView.vue');
  assert.match(view, /selectedCandidateByReviewId/);
  assert.match(view, /chosenDailyId/);
  assert.match(view, /resolvePendingReviewDecision/);
  assert.match(view, /台账 #/);
});
