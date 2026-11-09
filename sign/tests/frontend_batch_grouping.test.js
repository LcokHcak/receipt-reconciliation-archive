const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadModule() {
  return import(pathToFileURL(path.join(
    __dirname,
    '../frontend/src/lib/batchGrouping.js'
  )).href);
}

test('groupBatchesByDay:按创建日分组,今天/昨天标注,组内新在前', async () => {
  const { groupBatchesByDay } = await loadModule();
  const now = new Date('2026-07-02T12:00:00+09:00');
  const groups = groupBatchesByDay([
    { id: 'a', name: '早的', createdAt: '2026-07-01T02:00:00.000Z' },
    { id: 'b', name: '今天晚', createdAt: '2026-07-02T05:00:00.000Z' },
    { id: 'c', name: '今天早', createdAt: '2026-07-02T01:00:00.000Z' },
    { id: 'd', name: '没时间戳' },
  ], now);

  // 顺序:今天组在前(内部 b 先于 c),昨天组次之,未知最后
  assert.equal(groups[0].label.includes('今天'), true);
  assert.deepEqual(groups[0].items.map((x) => x.id), ['b', 'c']);
  assert.equal(groups[1].label.includes('昨天'), true);
  assert.deepEqual(groups[1].items.map((x) => x.id), ['a']);
  assert.equal(groups[2].key, '未知日期');
  assert.deepEqual(groups[2].items.map((x) => x.id), ['d']);
});

test('batchOptionLabel:名字·收票员·时刻,缺段自动省略', async () => {
  const { batchOptionLabel } = await loadModule();
  const full = batchOptionLabel({ name: '260702-小票10', ownerUsername: '小票10', createdAt: '2026-07-02T03:05:00.000Z' });
  assert.match(full, /^260702-小票10 · 小票10 · \d{2}:\d{2}$/);
  assert.equal(batchOptionLabel({ name: '仅名字' }), '仅名字');
  assert.equal(batchOptionLabel({ id: 'batch_x' }), 'batch_x');
});
