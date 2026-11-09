const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadDropBufferModule() {
  return import(pathToFileURL(path.join(
    __dirname,
    '../frontend/src/lib/dropBuffer.js'
  )).href);
}

function makeFile(name, options = {}) {
  return {
    name,
    size: options.size ?? 100,
    lastModified: options.lastModified ?? 1234,
    webkitRelativePath: options.webkitRelativePath || '',
  };
}

test('appendUniqueFiles appends later drops instead of replacing earlier files', async () => {
  const { appendUniqueFiles } = await loadDropBufferModule();

  const firstDrop = [makeFile('passport.jpg')];
  const secondDrop = [makeFile('receipt.jpg')];

  const result = appendUniqueFiles(firstDrop, secondDrop);

  assert.deepEqual(result.map((file) => file.name), ['passport.jpg', 'receipt.jpg']);
});

test('appendUniqueFiles skips the same file when it is dropped twice', async () => {
  const { appendUniqueFiles } = await loadDropBufferModule();
  const file = makeFile('passport.jpg', { size: 321, lastModified: 5678 });

  const result = appendUniqueFiles([file], [file]);

  assert.equal(result.length, 1);
  assert.equal(result[0], file);
});
