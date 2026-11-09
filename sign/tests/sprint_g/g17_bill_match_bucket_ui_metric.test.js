'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
}

test('G17 bill-match UI uses ledger rows for primary match rate and keeps bill detail coverage separate', () => {
  const bucket = read('frontend/src/components/v2/BucketCard.vue');
  const view = read('frontend/src/views/v2/BillMatchView.vue');

  assert.match(bucket, /const receivedBillRows = computed/);
  assert.match(bucket, /const ledgerMatchRate = computed/);
  assert.match(bucket, /matched\.value \/ dailyCount\.value/);
  assert.match(bucket, /const billCoverageRate = computed/);
  assert.match(bucket, /receivedBillRows\.value \/ billCount\.value/);
  assert.match(bucket, /账单明细覆盖/);
  assert.match(bucket, /待核对/);
  assert.match(bucket, /有未收/);
  assert.match(view, /global\.value\.matchedBillRows/);
  assert.match(view, /global\.value\.matched/);
  assert.match(view, /已匹配台账/);
  assert.match(view, /账单明细覆盖/);
});
