'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { withWorkspaceShared, withWorkspaceExclusive, _activeKeyCount } = require('../lib/customer_workspace_lock');

const WS = 'ws-A';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 观测器:记录任意时刻 shared/exclusive 并发峰值,验证不变量。
function makeProbe() {
  const p = { shared: 0, sharedPeak: 0, exclusive: 0, exclusivePeak: 0, order: [] };
  return {
    p,
    enterShared() { p.shared += 1; p.sharedPeak = Math.max(p.sharedPeak, p.shared); p.order.push('s+'); },
    exitShared() { p.shared -= 1; p.order.push('s-'); },
    enterExclusive() { p.exclusive += 1; p.exclusivePeak = Math.max(p.exclusivePeak, p.exclusive); p.order.push('x+'); },
    exitExclusive() { p.exclusive -= 1; p.order.push('x-'); },
  };
}

test('L631 原语:多 shared 真并发(峰值>1),无 exclusive 时不串行化', async () => {
  const probe = makeProbe();
  const one = async () => withWorkspaceShared(WS, async () => {
    probe.enterShared();
    await sleep(20);
    probe.exitShared();
  });
  await Promise.all([one(), one(), one(), one()]);
  assert.equal(probe.p.sharedPeak, 4, '4 个 shared 应真并发(峰值=4,证明无串行化)');
  assert.equal(_activeKeyCount(), 0, '全释放后无泄漏');
});

test('L631 原语:exclusive 独占——运行时无任何 shared/其它 exclusive 交叠', async () => {
  const probe = makeProbe();
  let exclusiveSawShared = false;
  const reader = () => withWorkspaceShared(WS, async () => {
    probe.enterShared();
    await sleep(15);
    probe.exitShared();
  });
  const writer = () => withWorkspaceExclusive(WS, async () => {
    probe.enterExclusive();
    if (probe.p.shared > 0) exclusiveSawShared = true; // exclusive 期间绝不能有 shared 在跑
    await sleep(15);
    if (probe.p.shared > 0) exclusiveSawShared = true;
    probe.exitExclusive();
  });
  // 混合并发:读、写、读交错发起
  await Promise.all([reader(), writer(), reader(), writer(), reader()]);
  assert.equal(exclusiveSawShared, false, 'exclusive 运行期间不得有 shared 交叠');
  assert.equal(probe.p.exclusivePeak, 1, '同时至多一个 exclusive');
  assert.equal(_activeKeyCount(), 0, '无泄漏');
});

test('L631 原语:写者优先——exclusive 在等时,后到的 shared 排它后面(drain 后独占)', async () => {
  const order = [];
  // 先起一个长 shared 占住
  const s1 = withWorkspaceShared(WS, async () => { order.push('s1-start'); await sleep(40); order.push('s1-end'); });
  await sleep(5); // 确保 s1 已入
  // exclusive 到达(要等 s1 drain)
  const x1 = withWorkspaceExclusive(WS, async () => { order.push('x1-run'); await sleep(10); order.push('x1-end'); });
  await sleep(5); // 确保 x1 已在等
  // 后到的 shared:写者优先 → 必须等 x1 跑完才 run
  const s2 = withWorkspaceShared(WS, async () => { order.push('s2-run'); });
  await Promise.all([s1, x1, s2]);
  // 期望顺序:s1 全程 → x1 → s2(s2 不得插到 x1 前)
  assert.deepEqual(order, ['s1-start', 's1-end', 'x1-run', 'x1-end', 's2-run'],
    '写者优先:s2 排在 x1 之后,x1 等 s1 drain 后独占');
  assert.equal(_activeKeyCount(), 0);
});

test('L631 原语:exclusive 之间 FIFO', async () => {
  const order = [];
  const x = (tag) => withWorkspaceExclusive(WS, async () => { order.push(tag); await sleep(8); });
  const a = x('x1'); await sleep(2);
  const b = x('x2'); await sleep(2);
  const c = x('x3');
  await Promise.all([a, b, c]);
  assert.deepEqual(order, ['x1', 'x2', 'x3'], 'exclusive 按到达顺序 FIFO,不交叠');
  assert.equal(_activeKeyCount(), 0);
});

test('L631 原语:fn 抛错不 wedge 链(finally 释放),后续可正常获取', async () => {
  await assert.rejects(
    () => withWorkspaceShared(WS, async () => { throw new Error('boom-shared'); }),
    /boom-shared/,
  );
  await assert.rejects(
    () => withWorkspaceExclusive(WS, async () => { throw new Error('boom-excl'); }),
    /boom-excl/,
  );
  // 出错后锁必须干净——新的获取立即成功
  let ran = false;
  await withWorkspaceExclusive(WS, async () => { ran = true; });
  assert.equal(ran, true, '错误释放后 exclusive 仍可获取(未卡链)');
  assert.equal(_activeKeyCount(), 0, '错误路径也不泄漏');
});

test('L631 原语:不同 workspaceKey 互不影响(A 的 exclusive 不挡 B 的 shared)', async () => {
  const order = [];
  const xa = withWorkspaceExclusive('ws-A', async () => { order.push('A-x-start'); await sleep(30); order.push('A-x-end'); });
  await sleep(5);
  // B 的 shared 应立即跑,不被 A 的 exclusive 挡
  const sb = withWorkspaceShared('ws-B', async () => { order.push('B-s-run'); });
  await sb; // B 应在 A 结束前就跑完
  assert.ok(order.includes('B-s-run') && !order.includes('A-x-end'), 'B 的 shared 不等 A 的 exclusive');
  await xa;
  assert.equal(_activeKeyCount(), 0);
});

test('L631 原语:无饿死——写者放行后,等待的读者随即被唤醒', async () => {
  const order = [];
  const x1 = withWorkspaceExclusive(WS, async () => { order.push('x'); await sleep(15); });
  await sleep(3);
  const s1 = withWorkspaceShared(WS, async () => { order.push('s1'); });
  const s2 = withWorkspaceShared(WS, async () => { order.push('s2'); });
  await Promise.all([x1, s1, s2]);
  assert.equal(order[0], 'x', 'exclusive 先跑');
  assert.deepEqual(order.slice(1).sort(), ['s1', 's2'], '两个等待读者在 exclusive 后都被唤醒并发跑');
  assert.equal(_activeKeyCount(), 0);
});
