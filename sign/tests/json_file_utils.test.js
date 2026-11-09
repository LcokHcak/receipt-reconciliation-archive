const test = require('node:test');
const assert = require('node:assert/strict');

const { stripUtf8Bom } = require('../lib/json_file_utils');

test('stripUtf8Bom removes a leading UTF-8 BOM before JSON parsing', () => {
  const text = stripUtf8Bom('\uFEFF{"ok":true}');

  assert.deepEqual(JSON.parse(text), { ok: true });
});
