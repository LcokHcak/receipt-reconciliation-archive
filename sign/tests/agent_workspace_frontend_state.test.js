'use strict';

// V2 Task9:代理工作台前端纯逻辑(query 双向同步/竞态门/分页合并/默认月/60s 轻刷判定)。
// 前端无 Vitest——纯模块用 Node test 验;组件流程归 Task 12 Playwright。

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadModule() {
  return import(pathToFileURL(path.join(
    __dirname,
    '../frontend/src/lib/agentWorkspaceQuery.js'
  )).href);
}

test('filtersFromQuery/queryFromFilters 双向:空值省略、非法月丢弃、ownerUserId 只收数字', async () => {
  const { filtersFromQuery, queryFromFilters, sameFilters } = await loadModule();

  const filters = filtersFromQuery({
    month: '2026-07', agentKey: '永乐', mode: '', reviewStatus: 'tour_pending',
    ownerUserId: '15', extra: '无关键保留在外层',
  });
  assert.deepEqual(filters, {
    month: '2026-07', agentKey: '永乐', mode: '', reviewStatus: 'tour_pending', ownerUserId: '15',
    search: '', // 2026-07-16 P1:一键搜索入筛选
    day: '', // 2026-07-24:按日筛选入筛选
  });
  // day 校验:合法 YYYY-MM-DD 收下,非法丢弃
  assert.equal(filtersFromQuery({ day: '2026-07-05' }).day, '2026-07-05');
  assert.equal(filtersFromQuery({ day: '2026-7-5' }).day, '');
  assert.equal(filtersFromQuery({ day: '2026-13-40' }).day, '');

  // 非法月/非数字 owner 丢弃(让默认月接管;不给注入面)
  assert.equal(filtersFromQuery({ month: '260701-小票22' }).month, '');
  assert.equal(filtersFromQuery({ month: '2026-13' }).month, '');
  assert.equal(filtersFromQuery({ ownerUserId: '15 OR 1=1' }).ownerUserId, '');

  // 反向:空值不进 URL
  const query = queryFromFilters(filters);
  assert.deepEqual(query, { month: '2026-07', agentKey: '永乐', reviewStatus: 'tour_pending', ownerUserId: '15' });
  assert.ok(!('mode' in query));

  // 往返一致
  assert.ok(sameFilters(filters, filtersFromQuery(query)));
  assert.ok(!sameFilters(filters, { ...filters, agentKey: '贝拉' }));
});

test('pickDefaultMonth:取最近有数据月份;坏条目跳过;禁止从 workspaceKey 形态取值', async () => {
  const { pickDefaultMonth } = await loadModule();
  assert.equal(pickDefaultMonth([{ month: '2026-07', customers: 3 }, { month: '2026-06' }]), '2026-07');
  assert.equal(pickDefaultMonth([{ month: '260701-小票22' }, { month: '2026-06' }]), '2026-06');
  assert.equal(pickDefaultMonth([]), '');
});

test('createRaceGate:后发覆盖先发,旧响应整包丢弃;invalidate 作废在途请求', async () => {
  const { createRaceGate } = await loadModule();
  const gate = createRaceGate();
  const t1 = gate.next();
  const t2 = gate.next(); // 用户快速切了代理:第二个请求后发
  assert.equal(gate.isCurrent(t1), false); // 旧响应回来 → 丢
  assert.equal(gate.isCurrent(t2), true);  // 新响应 → 用
  gate.invalidate();
  assert.equal(gate.isCurrent(t2), false); // 主动作废(离开页面/重置)
});

test('mergeCustomersPage:append 去重(customerPk);reset 清空;不吞新客户', async () => {
  const { mergeCustomersPage } = await loadModule();
  const page1 = [{ customerPk: 'ws::A' }, { customerPk: 'ws::B' }];
  const page2 = [{ customerPk: 'ws::B' }, { customerPk: 'ws::C' }]; // 边界重叠(轻刷/重试)
  const merged = mergeCustomersPage(page1, page2);
  assert.deepEqual(merged.map((c) => c.customerPk), ['ws::A', 'ws::B', 'ws::C']);

  const resetTo = mergeCustomersPage(merged, [{ customerPk: 'ws::Z' }], { reset: true });
  assert.deepEqual(resetTo.map((c) => c.customerPk), ['ws::Z']);
});

test('canSoftRefreshCustomers:没翻页才允许整页替换(保滚动/选中)', async () => {
  const { canSoftRefreshCustomers } = await loadModule();
  assert.equal(canSoftRefreshCustomers({ loadedCount: 30, pageSize: 50, hasPaginated: false }), true);
  assert.equal(canSoftRefreshCustomers({ loadedCount: 80, pageSize: 50, hasPaginated: true }), false);
  assert.equal(canSoftRefreshCustomers({ loadedCount: 50, pageSize: 50, hasPaginated: true }), false);
});
