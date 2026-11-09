'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..', '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('G20 brand activity view exposes a real xlsx import action wired to store-bill import', () => {
  const view = read('frontend/src/views/v2/BrandActivityView.vue');

  assert.match(view, /FileDropzone/);
  assert.match(view, /uploadImport/);
  assert.match(view, /uploadBrandActivity/);
  assert.match(view, /uploadImport\(\s*workspaceKey\.value\s*,\s*['"]store-bill['"]/);
  assert.match(view, /@file="uploadBrandActivity"/);
  assert.match(view, /await load\(\)/);
});
