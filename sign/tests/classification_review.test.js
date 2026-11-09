const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  applyManualOverride,
  buildSourceKey,
  loadManualOverrides,
  summarizeDocTypes,
} = require('../lib/classification_review');

test('buildSourceKey returns root-relative forward-slash path when source is inside input dir', () => {
  // 用原生分隔符路径(跨平台:Windows 反斜杠/Linux 正斜杠),不写死本机 D: 字面量
  const inputDir = path.resolve('input', 'workspace', '111');
  const sourceKey = buildSourceKey(
    inputDir,
    path.join(inputDir, 'AN YUMENG EQ91', '1d0cedd.jpg')
  );

  assert.equal(sourceKey, 'AN YUMENG EQ91/1d0cedd.jpg');
});

test('loadManualOverrides accepts exported entry array payloads', () => {
  const overrides = loadManualOverrides({
    entries: [
      {
        sourceKey: 'AN YUMENG EQ91/1d0cedd.jpg',
        docTypeFinal: 'passport',
        reviewNote: '人工改成护照',
      },
    ],
  });

  assert.deepEqual(overrides.get('AN YUMENG EQ91/1d0cedd.jpg'), {
    docTypeFinal: 'passport',
    reviewNote: '人工改成护照',
  });
});

test('applyManualOverride prefers manual final doc type when override exists', () => {
  const overrides = new Map([
    [
      'AN YUMENG EQ91/1d0cedd.jpg',
      {
        docTypeFinal: 'passport',
        reviewNote: '人工确认是护照',
      },
    ],
  ]);

  const entry = applyManualOverride(
    {
      sourceKey: 'AN YUMENG EQ91/1d0cedd.jpg',
      sourcePath: 'D:\\input\\workspace\\111\\AN YUMENG EQ91\\1d0cedd.jpg',
      docTypeAuto: 'receipt',
    },
    overrides
  );

  assert.equal(entry.docTypeFinal, 'passport');
  assert.equal(entry.manualOverride, true);
  assert.equal(entry.manualReviewNote, '人工确认是护照');
});

test('summarizeDocTypes folds legacy ticket entries into other', () => {
  const counts = summarizeDocTypes([
    { docTypeFinal: 'passport' },
    { docTypeFinal: 'passport' },
    { docTypeFinal: 'ticket' },
  ]);

  assert.deepEqual(counts, {
    passport: 2,
    other: 1,
  });
});
