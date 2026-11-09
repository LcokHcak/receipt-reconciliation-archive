const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const imageViewerPath = path.join(__dirname, '../frontend/src/components/ImageViewer.vue');
const fieldEditorPath = path.join(__dirname, '../frontend/src/components/FieldEditor.vue');
const reviewViewPath = path.join(__dirname, '../frontend/src/views/ReviewView.vue');

test('image viewer renders clickable field region overlays over the image', () => {
  const source = fs.readFileSync(imageViewerPath, 'utf8');

  assert.match(source, /fieldRegions/);
  assert.match(source, /activeFieldKey/);
  assert.match(source, /field-region-layer/);
  assert.match(source, /field-region-box/);
  assert.match(source, /on-field-region-select/);
  assert.match(source, /regionStyle/);
});

test('image viewer exposes persisted field region visibility and size controls', () => {
  const source = fs.readFileSync(imageViewerPath, 'utf8');

  assert.match(source, /fieldRegionSize/);
  assert.match(source, /setFieldRegionSize/);
  assert.match(source, /field-region-size-control/);
  assert.match(source, /--field-region-border-width/);
  assert.match(source, /localStorage/);
});

test('image viewer field region overlays render plain boxes without visible labels', () => {
  const source = fs.readFileSync(imageViewerPath, 'utf8');

  assert.doesNotMatch(source, /<span>\s*{{\s*region\.label\s*}}\s*<\/span>/);
  assert.doesNotMatch(source, /\.field-region-box span/);
  assert.match(source, /:title="regionTitle\(region\)"/);
});

test('field editor emits focused field keys and exposes field focus control', () => {
  const source = fs.readFileSync(fieldEditorPath, 'utf8');

  assert.match(source, /on-field-focus/);
  assert.match(source, /activeFieldKey/);
  assert.match(source, /focusField/);
  assert.match(source, /@focus="emitFieldFocus\(field\.key\)"/);
});

test('review view wires selected task field regions between image and form', () => {
  const source = fs.readFileSync(reviewViewPath, 'utf8');

  assert.match(source, /selectedTaskFieldRegions/);
  assert.match(source, /activeFieldKey/);
  assert.match(source, /focusReviewField/);
  assert.match(source, /:field-regions="selectedTaskFieldRegions"/);
  assert.match(source, /@on-field-region-select="focusReviewField"/);
  assert.match(source, /@on-field-focus="setActiveReviewField"/);
});
