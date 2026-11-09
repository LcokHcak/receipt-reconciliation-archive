'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { withWorkspaceTourMatchLock } = require('../lib/workspace_tour_match_lock');

test('同一 workspace 串行(峰值并发=1,按入队顺序)', async () => {
  let active = 0;
  let peak = 0;
  const order = [];
  const task = (tag) => withWorkspaceTourMatchLock('2026-07', async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 8));
    order.push(tag);
    active -= 1;
    return tag;
  });
  const results = await Promise.all([task('a'), task('b'), task('c')]);
  assert.equal(peak, 1, '同 workspace 不允许并发');
  assert.deepEqual(order, ['a', 'b', 'c'], '按入队顺序串行');
  assert.deepEqual(results, ['a', 'b', 'c']);
});

test('不同 workspace 并行(峰值并发>1)', async () => {
  let active = 0;
  let peak = 0;
  const task = (ws) => withWorkspaceTourMatchLock(ws, async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 8));
    active -= 1;
  });
  await Promise.all([task('2026-06'), task('2026-07'), task('2026-08')]);
  assert.equal(peak, 3, '不同 workspace 应并行');
});

test('一个任务抛错不拖累同 workspace 后续任务', async () => {
  await assert.rejects(
    withWorkspaceTourMatchLock('2026-09', async () => { throw new Error('boom'); }),
    /boom/,
  );
  const ok = await withWorkspaceTourMatchLock('2026-09', async () => 'recovered');
  assert.equal(ok, 'recovered', '前一个失败后,链仍能继续');
});

// 契约(8模块审计 HIGH:锁下沉进 tourMatchService.run):锁是 promise 链,不可重入。
// 同 key 双取会死锁——run 内联锁后,调用方(approve_settle 原来的外层 wrap)必须移除,
// 否则同 workspace 双取永不解。这条测试把该不变量钉死,防以后有人再外包。
test('契约:同 key 双取会死锁(所以 run 内联锁后调用方不得再外包同一把锁)', async () => {
  const TIMEOUT = Symbol('timeout');
  const withTimeout = (p, ms) => Promise.race([
    p,
    new Promise((r) => setTimeout(() => r(TIMEOUT), ms)),
  ]);

  // 同 key 嵌套:外层占住链尾,内层等外层→外层等内层 fn 完成,互等=死锁
  const nestedSameKey = withWorkspaceTourMatchLock('DL', () =>
    withWorkspaceTourMatchLock('DL', async () => 'inner'));
  assert.equal(await withTimeout(nestedSameKey, 50), TIMEOUT, '同 key 双取应死锁(永不解)');

  // 不同 key 嵌套:两条独立链,不互等 → 正常解
  const nestedDiffKey = withWorkspaceTourMatchLock('DK-A', () =>
    withWorkspaceTourMatchLock('DK-B', async () => 'ok'));
  assert.equal(await withTimeout(nestedDiffKey, 50), 'ok', '不同 key 嵌套不死锁');
});
