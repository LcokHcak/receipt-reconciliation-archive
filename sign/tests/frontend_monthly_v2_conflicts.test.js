const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

function read(path) {
  return fs.readFileSync(path, 'utf8');
}

test('C2 conflicts view wires mock data, demo banner, tabs, and resolution actions', () => {
  const source = read('frontend/src/views/v2/ConflictsView.vue');
  assert.match(source, /getConflicts/);
  assert.match(source, /activeTab/);
  assert.match(source, /StatusBadge[^>]*variant="test"/);
  // 冲突解决走真实接口,且不再 console.log 含客户字段的 payload(PII)
  assert.match(source, /resolveConflict\(/);
  assert.doesNotMatch(source, /console\.log\(\{ type: 'resolve-conflict'/);
  assert.match(source, /pendingItems\.value\.splice/);
  assert.match(source, /resolvedItems\.value\.unshift/);
});

test('C2 conflict components expose list, detail, field diff, and lock toggle behavior', () => {
  const files = [
    'frontend/src/components/v2/ConflictList.vue',
    'frontend/src/components/v2/ConflictDetail.vue',
    'frontend/src/components/v2/FieldDiff.vue',
    'frontend/src/components/v2/LockToggle.vue',
  ];
  for (const file of files) {
    assert.ok(fs.existsSync(file), `${file} should exist`);
  }
  const list = read(files[0]);
  assert.match(list, /Lock/);
  assert.match(list, /Tooltip/);
  assert.match(list, /emit\('select'/);

  const detail = read(files[1]);
  assert.match(detail, /全部接受新值/);
  assert.match(detail, /应用解决/);
  assert.match(detail, /emit\('apply'/);

  const diff = read(files[2]);
  assert.match(diff, /保留库内/);
  assert.match(diff, /接受新值/);
  assert.match(diff, /手动输入/);
  assert.match(diff, /update:resolution/);

  const lock = read(files[3]);
  assert.match(lock, /处理后锁定此字段/);
  assert.match(lock, /update:modelValue/);
});

test('C2 conflict mock keeps at least 12 pending and 8 resolved rows', async () => {
  const { getConflicts } = await import('../frontend/src/mocks/v2/index.js');
  const data = getConflicts('demo-2026-05');
  assert.ok(data.pending.length >= 12);
  assert.ok(data.resolved.length >= 8);
  assert.ok(data.pending.some((item) => item.fields.some((field) => field.isLocked)));
});
