'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const exists = (file) => fs.existsSync(path.join(root, file));

test('G15 t1: bill-match bucket api wrapper exports fetchBuckets + runBucketMatch', () => {
  const src = read('frontend/src/api/v2/billMatchBuckets.js');
  assert.match(src, /export function fetchBuckets\b/);
  assert.match(src, /export function runBucketMatch\b/);
  assert.match(src, /export function clearBucketBills\b/);
  assert.match(src, /\/bill-match\/buckets/);
  assert.match(src, /\/bill-match\/run-bucket/);
  assert.match(src, /api\.delete/);
});

test('G15 t2: BillMatchView renders BucketCard for backend buckets and global KPI', () => {
  assert.equal(exists('frontend/src/views/v2/BillMatchView.vue'), true);
  const src = read('frontend/src/views/v2/BillMatchView.vue');
  assert.match(src, /fetchBuckets/);
  assert.match(src, /runBillMatch/);
  assert.match(src, /runTourMatch/);
  assert.match(src, /v-for="bucket in buckets"/);
  assert.match(src, /<BucketCard/);
  for (const key of ['totalBills', 'totalDaily', 'matched', 'matchRate']) {
    assert.match(src, new RegExp(key), `BillMatchView must render ${key}`);
  }
});

test('G15 t3: BucketCard exposes deduct config, bill files, dropzone, and per-bucket match action', () => {
  assert.equal(exists('frontend/src/components/v2/BucketCard.vue'), true);
  const src = read('frontend/src/components/v2/BucketCard.vue');
  assert.match(src, /updateDeductConfig/);
  assert.match(src, /deductValue/);
  assert.match(src, /bucket\.modeRaws/);
  assert.match(src, /bucket\.billFiles/);
  assert.match(src, /FileDropzone/);
  assert.match(src, /uploadImport/);
  assert.match(src, /clearBucketBills/);
  assert.match(src, /替换本桶/);
  assert.match(src, /删除本桶/);
  assert.match(src, /runBucketMatch/);
});

test('G15 t3b: bucket upload carries explicit bucket folder and per-bucket deduct is independent', () => {
  const card = read('frontend/src/components/v2/BucketCard.vue');
  const imports = read('frontend/src/api/v2/imports.js');
  const page = read('frontend/src/views/v2/BillMatchView.vue');

  assert.match(imports, /bucketFolder/);
  assert.match(card, /bucketFolder:\s*props\.bucket\.folder/);
  assert.doesNotMatch(card, /confirm:\s*true/);
  assert.doesNotMatch(page, /data-testid="confirm-deduct"/);
  assert.doesNotMatch(page, /确认扣点|还差未填扣点/);
});

test('G15 t3c: monthly import upload keeps the connection open for large xlsx files', () => {
  const imports = read('frontend/src/api/v2/imports.js');
  assert.match(imports, /const\s+UPLOAD_TIMEOUT_MS\s*=\s*30\s*\*\s*60\s*\*\s*1000/);
  assert.match(imports, /timeout:\s*UPLOAD_TIMEOUT_MS/);
  assert.doesNotMatch(imports, /timeout:\s*2\s*\*\s*60\s*\*\s*1000/);
  assert.doesNotMatch(imports, /timeout:\s*10\s*\*\s*60\s*\*\s*1000/);
});

test('G15 t4: router and sidebar point to /bill-match control center', () => {
  const router = read('frontend/src/router/index.js');
  const sidebar = read('frontend/src/layouts/AppSidebar.vue');
  assert.match(router, /\/monthly\/v2\/:workspaceKey\/bill-match/);
  assert.match(router, /name: 'v2-monthly-bill-match'/);
  assert.match(router, /BillMatchView\.vue/);
  assert.match(sidebar, /v2\('bill-match'\)/);
});
