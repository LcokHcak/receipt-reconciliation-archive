const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  chunkArray,
  ensureDir,
  formatBusinessDateStamp,
  nowStamp,
  sanitizeAsciiFileComponent,
  sanitizeFileComponent,
} = require('../lib/workbench_utils');

test('ensureDir creates nested directories recursively', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-utils-'));
  const nestedDir = path.join(root, 'a', 'b', 'c');

  ensureDir(nestedDir);

  assert.equal(fs.existsSync(nestedDir), true);
  assert.equal(fs.statSync(nestedDir).isDirectory(), true);

  fs.rmSync(root, { recursive: true, force: true });
});

test('nowStamp returns a stable timestamp format for folder names', () => {
  assert.match(nowStamp(), /^\d{8}_\d{6}$/);
});

test('formatBusinessDateStamp uses the Asia Seoul business date', () => {
  assert.equal(formatBusinessDateStamp(new Date('2026-05-03T15:30:00.000Z')), '20260504');
});

test('sanitizeFileComponent removes invalid path characters and compresses separators', () => {
  assert.equal(sanitizeFileComponent('  A:/B  C***  '), 'A_B_C');
  assert.equal(sanitizeFileComponent(''), '');
});

test('sanitizeAsciiFileComponent returns python-safe internal file names', () => {
  assert.equal(
    sanitizeAsciiFileComponent('\u62a4\u7167 \u00e6\u008a\u00a4\u00e7\u0085\u00a7 123'),
    'c_123'
  );
  assert.equal(sanitizeAsciiFileComponent('\u62a4\u7167', 'image_1'), 'image_1');
  assert.equal(sanitizeAsciiFileComponent(' Lotte Receipt 01 ', 'image_1'), 'Lotte_Receipt_01');
});

test('chunkArray splits items into stable fixed-size batches', () => {
  assert.deepEqual(chunkArray([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunkArray([1, 2, 3], 10), [[1, 2, 3]]);
  assert.deepEqual(chunkArray([], 5), []);
});
