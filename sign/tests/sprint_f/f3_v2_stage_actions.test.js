'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const exists = (file) => fs.existsSync(path.join(root, file));

test('F3 t1: api/v2/stages.js exists and exports 5 stage wrappers', () => {
  assert.equal(exists('frontend/src/api/v2/stages.js'), true);
  const src = read('frontend/src/api/v2/stages.js');
  ['runTourMatch', 'runBillMatch', 'runMerge', 'runSecondPass', 'runMonthlyExport']
    .forEach((name) => assert.match(src, new RegExp(`export function ${name}\\b`), name));
  assert.match(src, /from ['"]\.\.\/client['"]/);
});

test('F3 t2: stages.js endpoint paths align with v1 monthly.js', () => {
  const v2 = read('frontend/src/api/v2/stages.js');
  ['stages/tour-match', 'stages/bill-match', 'stages/merge', 'stages/second-pass', 'exports/monthly-data']
    .forEach((endpoint) => assert.match(v2, new RegExp(endpoint), endpoint));
  assert.match(v2, /STAGE_TIMEOUT_MS\s*=\s*10\s*\*\s*60\s*\*\s*1000/);
});

test('F3 t3: MonthlyV2View imports merge stage and no longer exposes direct pipeline stage actions', () => {
  const view = read('frontend/src/views/v2/MonthlyV2View.vue');
  assert.match(view, /from ['"]@\/api\/v2\/stages['"]/);
  assert.match(view, /runMerge/);
  assert.doesNotMatch(view, /function handleStage\(payload\)\s*{\s*console\.log\(payload\)\s*}/);
  assert.doesNotMatch(view, /async function handleStage\(payload\)/);
  assert.doesNotMatch(view, /STAGE_HANDLERS\s*=/);
});

test('F3 t4: MonthlyV2View routes users to the operational workbenches', () => {
  const view = read('frontend/src/views/v2/MonthlyV2View.vue');
  [
    'v2-monthly-ledger',
    'v2-monthly-bill-match',
    'v2-monthly-bill-review',
    'v2-monthly-unreceived',
    'v2-monthly-delivery',
  ].forEach((routeName) => assert.match(view, new RegExp(routeName), routeName));
  assert.match(view, /nextAction/);
  assert.match(view, /quickActions/);
});


test('F3 t6: export action decodes the active backend error codes', () => {
  const view = read('frontend/src/views/v2/MonthlyV2View.vue');
  ['PIPELINE_LOCKED', 'merge_blocked', 'STAGE_ALREADY_RUNNING', 'service_unavailable']
    .forEach((code) => assert.match(view, new RegExp(code), code));
  assert.doesNotMatch(view, /WORKSPACE_LOCKED/);
});

test('F3 t7: export success path refreshes overview + sets stageResult', () => {
  const view = read('frontend/src/views/v2/MonthlyV2View.vue');
  assert.match(view, /await\s+loadOverview\(\)/);
  assert.match(view, /stageResult\.value\s*=\s*{[\s\S]*?success:\s*true/);
  assert.match(view, /stageResult\.value\s*=\s*{[\s\S]*?success:\s*false/);
  assert.match(view, /runningStage\.value\s*=\s*null/);
  assert.match(view, /router\.push\(routeFor\(['"]v2-monthly-delivery['"]\)\)/);
});
