'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// 审计L593:deletedSourcePaths 墓碑是「删过的图不许 append/sweep 去重时复活」的唯一真相源
// (bridge getBatchSourceOriginalPathSet 消费)。两个写墓碑点原本 slice(-500) 硬截断→单批次累计
// 删除的不同原图路径超 500 时逐出最旧墓碑,审核台删过的重复护照/废图重建任务复活反复出现。
// 修=去掉截断(includes 去重保证无重复,上界=该批次曾出现图片数量级,有界且体量小)。
// 契约测试锁死:两个写点不得再 slice 截断墓碑数组,且必须保留 includes 去重守卫。

function readSrc(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

test('契约:workbench_write/task.js 写墓碑不截断(去重保留)', () => {
  const src = readSrc('services/workbench_write/task.js');
  const idx = src.indexOf('batch.deletedSourcePaths = tombstones');
  assert.ok(idx > 0, 'deleteTask 应写 batch.deletedSourcePaths = tombstones');
  const near = src.slice(idx - 700, idx + 120);
  assert.ok(!/deletedSourcePaths\s*=\s*tombstones\.slice\(/.test(near), 'L593:墓碑不得再 slice 截断(会逐出最旧墓碑→已删图复活)');
  assert.ok(/tombstones\.includes\(/.test(near), '必须保留 includes 去重守卫(无重复=去掉上界安全)');
});

test('契约:customer_batch_bridge_service.js 写墓碑不截断(去重保留)', () => {
  const src = readSrc('services/customer_batch_bridge_service.js');
  const idx = src.indexOf('batch.deletedSourcePaths = tombstones');
  assert.ok(idx > 0, 'cleanupStaleCustomerTasks 应写 batch.deletedSourcePaths = tombstones');
  const near = src.slice(idx - 700, idx + 120);
  assert.ok(!/deletedSourcePaths\s*=\s*tombstones\.slice\(/.test(near), 'L593:墓碑不得再 slice 截断');
  assert.ok(/tombstones\.includes\(/.test(near), '必须保留 includes 去重守卫');
});
