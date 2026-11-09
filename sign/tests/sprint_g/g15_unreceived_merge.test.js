'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..', '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('G15 unreceived page absorbs known missing receipts', () => {
  const view = read('frontend/src/views/v2/UnreceivedView.vue');
  assert.match(view, /fetchUnreceivedList/);
  assert.match(view, /unreceivedRows/);
  assert.doesNotMatch(view, /fetchOrphanBills/);
  assert.doesNotMatch(view, /fetchMissing/);
  assert.doesNotMatch(view, /fetchOrphanRows/);
  assert.doesNotMatch(view, /orphanRows/);
  assert.doesNotMatch(view, /activeTab === 'rows'/);
  assert.match(view, /未收清单|鏈敹娓呭崟/);
});

test('G15 unreceived page uses server-side pagination', () => {
  const view = read('frontend/src/views/v2/UnreceivedView.vue');
  const route = read('routes/monthly/bill_match_routes.js');

  assert.match(view, /const PAGE_SIZE = 50/);
  assert.match(view, /offset: pageOffset\.value/);
  assert.match(view, /filters\.folder/);
  assert.match(view, /URLSearchParams/);
  assert.match(view, /totalRows/);
  assert.match(view, /goPage/);
  assert.match(route, /\/bill-match\/unreceived/);
  assert.match(route, /folder/);
  assert.match(route, /folders/);
  assert.match(route, /clampInt\(req\.query\.limit/);
  assert.match(route, /filtered\.slice\(offset, offset \+ limit\)/);
  assert.match(route, /modes/);
});

test('G15 missing routes redirect to unified unreceived page', () => {
  const router = read('frontend/src/router/index.js');
  assert.match(router, /monthly\/:workspaceKey\/missing[\s\S]+unreceived/);
  assert.match(router, /monthly\/v2\/:workspaceKey\/missing[\s\S]+unreceived/);
  assert.doesNotMatch(router, /MissingView\.vue/);
});

test('G15 old MissingView is removed and bucket links target bill review', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'frontend/src/views/v2/MissingView.vue')), false);
  const bucket = read('frontend/src/components/v2/BucketCard.vue');
  assert.match(bucket, /bill-review/);
  assert.doesNotMatch(bucket, /pending-reviews/);
});
