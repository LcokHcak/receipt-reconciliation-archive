'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('G15 t5: WorkspaceSwitcher loads monthly workspaces and can create a workspace', () => {
  const src = read('frontend/src/components/v2/WorkspaceSwitcher.vue');
  assert.match(src, /fetchMonthlyWorkspaces/);
  assert.match(src, /createMonthlyWorkspace/);
  assert.match(src, /mode: 'all'/);
  assert.match(src, /router\.push/);
  assert.match(src, /demoWorkspaces/);
  assert.match(src, /productionWorkspaces/);
});

test('G15 t6: AppLayout renders WorkspaceSwitcher in the global header', () => {
  const src = read('frontend/src/layouts/AppLayout.vue');
  assert.match(src, /WorkspaceSwitcher/);
  assert.match(src, /v-if="workspaceKey"/);
  assert.match(src, /ml-auto/);
});
