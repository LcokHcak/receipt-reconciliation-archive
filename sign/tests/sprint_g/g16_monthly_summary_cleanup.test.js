'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
}

test('G16 monthly shell drops low-value summary blocks and floating help widget', () => {
  const monthly = read('frontend/src/views/v2/MonthlyV2View.vue');
  const monthlyHeader = read('frontend/src/components/v2/MonthlyHeader.vue');
  const app = read('frontend/src/App.vue');

  assert.doesNotMatch(monthly, /ActivityFeed/);
  assert.doesNotMatch(monthly, /AlertList/);
  assert.doesNotMatch(monthly, /bucketCards/);
  assert.doesNotMatch(monthly, /operationStats/);
  assert.doesNotMatch(monthlyHeader, /modeLabel/);
  assert.doesNotMatch(monthlyHeader, /modeBindings/);
  assert.doesNotMatch(monthlyHeader, /MoreHorizontal/);
  assert.doesNotMatch(monthlyHeader, /moreMenu/);
  assert.doesNotMatch(app, /FeedbackWidget/);
});
