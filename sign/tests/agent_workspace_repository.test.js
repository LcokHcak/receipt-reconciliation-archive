'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createWorkbenchSqliteRepository } = require('../repositories/workbench_sqlite_repository');
const { createAgentWorkspaceRepository } = require('../repositories/agent_workspace_repository');

function makeRepos(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ws-repo-'));
  const wsRepo = createWorkbenchSqliteRepository({ dbPath: path.join(dir, 'workbench.sqlite') });
  const repo = createAgentWorkspaceRepository({ db: wsRepo.db });
  // after 钩子按注册顺序执行:先 close 再删目录(Windows 上 WAL 未关会 EPERM)。
  t.after(() => wsRepo.close());
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return repo;
}

function anchorOf(pk, over = {}) {
  const [workspaceKey, customerId] = pk.split('::');
  return {
    customerPk: pk,
    calendarMonth: '2026-07',
    workspaceKey,
    customerId,
    ownerUserId: 15,
    ownerUsername: '小票22',
    agentKey: '永乐',
    agentName: '永乐',
    customerName: 'ZHANG SAN',
    receivedAt: '2026-07-05T02:00:00.000Z',
    originalImageCount: 3,
    abnormalImageCount: 0,
    ...over,
  };
}

test('建表/索引幂等:重复构造不炸,schema 可升级', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ws-idem-'));
  const wsRepo = createWorkbenchSqliteRepository({ dbPath: path.join(dir, 'wb.sqlite') });
  createAgentWorkspaceRepository({ db: wsRepo.db });
  createAgentWorkspaceRepository({ db: wsRepo.db }); // 二次构造=幂等
  wsRepo.close();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
});

test('anchor upsert 不清 overlay;overlay upsert 不动 anchor;孤儿 overlay 返回 orphan', (t) => {
  const repo = makeRepos(t);
  repo.upsertCustomerAnchor(anchorOf('ws1::CL1'));
  // 先盖 overlay
  const r1 = repo.upsertReviewOverlay({
    customerPk: 'ws1::CL1',
    batchId: 'b1',
    groupKey: 'g1',
    reviewStatus: 'tour_pending',
    nextAction: 'confirm_tour',
    reasonCodes: ['tour_pending'],
    candidateModes: ['乐天SG-本司'],
    confirmedModes: [],
    storeKeys: ['LOTTE'],
    settlementStatus: '',
  });
  assert.equal(r1.orphan, false);
  // anchor 再次 upsert(客户改代理名)→ overlay 字段必须保留
  repo.upsertCustomerAnchor(anchorOf('ws1::CL1', { agentKey: '贝拉', agentName: '贝拉' }));
  const row = repo.getCustomer('ws1::CL1');
  assert.equal(row.agentKey, '贝拉');
  assert.equal(row.reviewStatus, 'tour_pending');
  assert.equal(row.batchId, 'b1');
  // overlay 再次 upsert → anchor 的代理/owner/receivedAt 不被覆盖
  repo.upsertReviewOverlay({
    customerPk: 'ws1::CL1', batchId: 'b1', groupKey: 'g1',
    reviewStatus: 'review_pending', nextAction: 'review_fields', reasonCodes: [],
    candidateModes: [], confirmedModes: ['乐天SG-本司'], storeKeys: ['LOTTE'], settlementStatus: '',
  });
  const row2 = repo.getCustomer('ws1::CL1');
  assert.equal(row2.agentKey, '贝拉');
  assert.equal(row2.receivedAt, '2026-07-05T02:00:00.000Z');
  assert.equal(row2.reviewStatus, 'review_pending');
  assert.deepEqual(row2.confirmedModes, ['乐天SG-本司']);
  // 孤儿:读模型没有该客户 → orphan=true 不写
  const r3 = repo.upsertReviewOverlay({ customerPk: 'ws1::NOPE', reviewStatus: 'passed', nextAction: 'view_record' });
  assert.equal(r3.orphan, true);
});

test('删除客户移除读模型行', (t) => {
  const repo = makeRepos(t);
  repo.upsertCustomerAnchor(anchorOf('ws1::CL1'));
  repo.deleteCustomer('ws1::CL1');
  assert.equal(repo.getCustomer('ws1::CL1'), null);
});

test('客户游标分页:received_at DESC, customer_pk DESC 稳定;同时刻靠 pk 破平', (t) => {
  const repo = makeRepos(t);
  const T = '2026-07-05T02:00:00.000Z';
  repo.upsertCustomerAnchor(anchorOf('ws1::CL1', { receivedAt: T }));
  repo.upsertCustomerAnchor(anchorOf('ws1::CL2', { receivedAt: T }));
  repo.upsertCustomerAnchor(anchorOf('ws1::CL3', { receivedAt: '2026-07-06T02:00:00.000Z' }));
  const page1 = repo.listCustomers({ month: '2026-07', limit: 2 });
  assert.deepEqual(page1.rows.map((r) => r.customerId), ['CL3', 'CL2']);
  assert.ok(page1.nextCursor);
  const page2 = repo.listCustomers({ month: '2026-07', limit: 2, cursor: page1.nextCursor });
  assert.deepEqual(page2.rows.map((r) => r.customerId), ['CL1']);
  assert.equal(page2.nextCursor, null);
  // limit 钳制到 100
  const clamped = repo.listCustomers({ month: '2026-07', limit: 9999 });
  assert.ok(clamped.rows.length <= 100);
});

test('模式筛选任一命中(候选或确认),reviewStatus 筛选,owner 收窄', (t) => {
  const repo = makeRepos(t);
  repo.upsertCustomerAnchor(anchorOf('ws1::CL1'));
  repo.upsertReviewOverlay({
    customerPk: 'ws1::CL1', batchId: 'b1', groupKey: 'g1',
    reviewStatus: 'tour_pending', nextAction: 'confirm_tour', reasonCodes: [],
    candidateModes: ['乐天SG-本司'], confirmedModes: [], storeKeys: [], settlementStatus: '',
  });
  repo.upsertCustomerAnchor(anchorOf('ws1::CL2', { ownerUserId: 99, ownerUsername: '别人' }));
  repo.upsertReviewOverlay({
    customerPk: 'ws1::CL2', batchId: 'b1', groupKey: 'g2',
    reviewStatus: 'passed', nextAction: 'view_record', reasonCodes: [],
    candidateModes: [], confirmedModes: ['现代-JEOCU'], storeKeys: [], settlementStatus: 'settled',
  });
  // 候选命中
  assert.deepEqual(
    repo.listCustomers({ month: '2026-07', mode: '乐天SG-本司' }).rows.map((r) => r.customerId),
    ['CL1'],
  );
  // 确认命中
  assert.deepEqual(
    repo.listCustomers({ month: '2026-07', mode: '现代-JEOCU' }).rows.map((r) => r.customerId),
    ['CL2'],
  );
  assert.deepEqual(
    repo.listCustomers({ month: '2026-07', reviewStatus: 'passed' }).rows.map((r) => r.customerId),
    ['CL2'],
  );
  assert.deepEqual(
    repo.listCustomers({ month: '2026-07', ownerUserId: 15 }).rows.map((r) => r.customerId),
    ['CL1'],
  );
});

test('代理列表:聚合计数+搜索转义 %/_', (t) => {
  const repo = makeRepos(t);
  repo.upsertCustomerAnchor(anchorOf('ws1::CL1', { agentKey: '永乐', agentName: '永乐' }));
  repo.upsertCustomerAnchor(anchorOf('ws1::CL2', { agentKey: '永乐', agentName: '永乐' }));
  repo.upsertCustomerAnchor(anchorOf('ws1::CL3', { agentKey: '100%旅行', agentName: '100%旅行' }));
  const agents = repo.listAgents({ month: '2026-07' });
  const yl = agents.rows.find((a) => a.agentKey === '永乐');
  assert.equal(yl.customerCount, 2);
  // LIKE 特殊字符按字面匹配
  const pct = repo.listAgents({ month: '2026-07', search: '100%' });
  assert.deepEqual(pct.rows.map((a) => a.agentKey), ['100%旅行']);
  const none = repo.listAgents({ month: '2026-07', search: '100_' });
  assert.equal(none.rows.length, 0);
});

test('summary 按同一 scope 出总数与状态分布', (t) => {
  const repo = makeRepos(t);
  repo.upsertCustomerAnchor(anchorOf('ws1::CL1'));
  repo.upsertCustomerAnchor(anchorOf('ws1::CL2'));
  repo.upsertReviewOverlay({
    customerPk: 'ws1::CL2', batchId: 'b', groupKey: 'g',
    reviewStatus: 'passed', nextAction: 'view_record', reasonCodes: [],
    candidateModes: [], confirmedModes: [], storeKeys: [], settlementStatus: 'settled',
  });
  const sum = repo.summary({ month: '2026-07' });
  assert.equal(sum.totalCustomers, 2);
  assert.equal(sum.byStatus.passed, 1);
  assert.equal(sum.byStatus.ready_for_sync, 1); // 未盖 overlay 的锚点缺省态
  assert.equal(sum.totalImages, 6); // 2 客户 × originalImageCount 3(卡片改版辅读数)
});

test('summary 今日新增:received_at >= todayStartIso 计数;不传该参则为 0', (t) => {
  const repo = makeRepos(t);
  // 三个客户:两个"今日"(>= 边界),一个昨天
  repo.upsertCustomerAnchor(anchorOf('ws1::T1', { receivedAt: '2026-07-13T01:00:00.000Z' }));
  repo.upsertCustomerAnchor(anchorOf('ws1::T2', { receivedAt: '2026-07-13T23:00:00.000Z' }));
  repo.upsertCustomerAnchor(anchorOf('ws1::Y1', { receivedAt: '2026-07-12T20:00:00.000Z' }));
  const todayStartIso = '2026-07-13T00:00:00.000Z';
  const sum = repo.summary({ month: '2026-07', todayStartIso });
  assert.equal(sum.totalCustomers, 3);
  assert.equal(sum.todayCount, 2); // T1+T2
  // 不传边界 → todayCount 0(旧调用零回归)
  assert.equal(repo.summary({ month: '2026-07' }).todayCount, 0);
});

// 2026-07-16 代理视图P1:一键搜索——投影列(姓名/客户号)直查 + service注入的台账反查ID并集
test('listCustomers search:姓名/客户号 LIKE 命中;searchExtraIds 并集;无关词不出', (t) => {
  const repo = makeRepos(t);
  repo.upsertCustomerAnchor(anchorOf('2607::CL20260716-001', { customerName: 'ZHANG SAN' }));
  repo.upsertCustomerAnchor(anchorOf('2607::CL20260716-002', { customerName: 'LI SI' }));
  repo.upsertCustomerAnchor(anchorOf('2607::CL20260716-003', { customerName: 'WANG WU' }));

  // 姓名模糊
  const byName = repo.listCustomers({ month: '2026-07', search: 'ZHANG' });
  assert.deepEqual(byName.rows.map((r) => r.customerId), ['CL20260716-001']);
  // 客户号
  const byId = repo.listCustomers({ month: '2026-07', search: '0716-002' });
  assert.deepEqual(byId.rows.map((r) => r.customerId), ['CL20260716-002']);
  // 台账反查ID并集(模拟 service 注入:护照号命中了 003)
  const byExtra = repo.listCustomers({ month: '2026-07', search: 'E9999999', searchExtraIds: ['CL20260716-003'] });
  assert.deepEqual(byExtra.rows.map((r) => r.customerId), ['CL20260716-003']);
  // 无关词=空
  assert.equal(repo.listCustomers({ month: '2026-07', search: '不存在的词' }).rows.length, 0);
  // LIKE 通配符转义(%不当通配用)
  assert.equal(repo.listCustomers({ month: '2026-07', search: '%' }).rows.length, 0);
});

test('listCustomers search:searchExtraGroupKeys 命中 active_group_key(未结算客户也能全量搜)', (t) => {
  const repo = makeRepos(t);
  repo.upsertCustomerAnchor(anchorOf('2607::CL20260716-001', { customerName: 'ZHANG SAN', activeGroupKey: 'CL20260716-001' }));
  repo.upsertCustomerAnchor(anchorOf('2607::CL20260716-004', { customerName: 'ZHAO LIU', activeGroupKey: 'CL20260716-004' }));
  // 模拟 service 注入:护照/票号在工作台镜像命中未结算客户 004 的 group key(台账里还没有)
  const byGroup = repo.listCustomers({ month: '2026-07', search: 'H23144139', searchExtraGroupKeys: ['CL20260716-004'] });
  assert.deepEqual(byGroup.rows.map((r) => r.customerId), ['CL20260716-004']);
  // 台账ID(已结算)+ 镜像groupKey(未结算)两路并集
  const both = repo.listCustomers({ month: '2026-07', search: 'zzz', searchExtraIds: ['CL20260716-001'], searchExtraGroupKeys: ['CL20260716-004'] });
  assert.deepEqual(both.rows.map((r) => r.customerId).sort(), ['CL20260716-001', 'CL20260716-004']);
  // 无任何反查注入=护照号搜不到(不误命中)
  assert.equal(repo.listCustomers({ month: '2026-07', search: 'H23144139' }).rows.length, 0);
});

test('listCustomers 按日筛选:received_at ∈ [起, 止) 才出(收票/建档日)', (t) => {
  const repo = makeRepos(t);
  repo.upsertCustomerAnchor(anchorOf('2607::CL20260705-001', { receivedAt: '2026-07-05T02:00:00.000Z' })); // KST 07-05 11:00
  repo.upsertCustomerAnchor(anchorOf('2607::CL20260706-001', { receivedAt: '2026-07-05T20:00:00.000Z' })); // KST 07-06 05:00
  // KST 07-05 = [2026-07-04T15:00Z, 2026-07-05T15:00Z)
  const day5 = repo.listCustomers({ month: '2026-07', receivedFromIso: '2026-07-04T15:00:00.000Z', receivedToIso: '2026-07-05T15:00:00.000Z' });
  assert.deepEqual(day5.rows.map((r) => r.customerId), ['CL20260705-001'], '只出 KST 07-05 收的那位');
  // 不传范围=不按日过滤,全出
  assert.equal(repo.listCustomers({ month: '2026-07' }).rows.length, 2);
});

test('summary 按日筛选(2026-07-27 需求E②):卡片计数与 listCustomers 同一窗口,当日新增有上界', (t) => {
  const repo = makeRepos(t);
  // KST 07-05 收 2 位(1 已通过 / 1 待补救),KST 07-06 收 1 位
  repo.upsertCustomerAnchor(anchorOf('2607::CL20260705-001', { receivedAt: '2026-07-05T02:00:00.000Z' }));
  repo.upsertCustomerAnchor(anchorOf('2607::CL20260705-002', { receivedAt: '2026-07-05T03:00:00.000Z' }));
  repo.upsertCustomerAnchor(anchorOf('2607::CL20260706-001', { receivedAt: '2026-07-05T20:00:00.000Z' }));
  repo.upsertReviewOverlay({ customerPk: '2607::CL20260705-001', reviewStatus: 'passed' });
  repo.upsertReviewOverlay({ customerPk: '2607::CL20260705-002', reviewStatus: 'needs_remedy' });
  repo.upsertReviewOverlay({ customerPk: '2607::CL20260706-001', reviewStatus: 'passed' });

  const from = '2026-07-04T15:00:00.000Z';
  const to = '2026-07-05T15:00:00.000Z'; // KST 07-05
  const day5 = repo.summary({ month: '2026-07', receivedFromIso: from, receivedToIso: to });
  assert.equal(day5.totalCustomers, 2, '总数只算那天');
  assert.equal(day5.byStatus.passed, 1);
  assert.equal(day5.byStatus.needs_remedy, 1);
  // ⭐与列表同源:summary 总数必须等于同窗口 listCustomers 的行数,否则上下对不上
  assert.equal(
    repo.listCustomers({ month: '2026-07', receivedFromIso: from, receivedToIso: to }).rows.length,
    day5.totalCustomers,
  );

  // 「当日新增」带上界:选过去某天时,不能把那天之后收的也算进来
  const withEnd = repo.summary({ month: '2026-07', receivedFromIso: from, receivedToIso: to, todayStartIso: from, todayEndIso: to });
  assert.equal(withEnd.todayCount, 2);
  // 不传范围 = 不按日过滤(旧调用零回归)
  const all = repo.summary({ month: '2026-07' });
  assert.equal(all.totalCustomers, 3);
  assert.equal(all.todayCount, 0, '不传 todayStartIso 仍为 0');
});

test('summary 选历史日:「当日已审」返回 null 而不是假的 0(projected_at 不是审核时间)', (t) => {
  const repo = makeRepos(t);
  repo.upsertCustomerAnchor(anchorOf('2607::CL20260705-001', { receivedAt: '2026-07-05T02:00:00.000Z' }));
  repo.upsertReviewOverlay({ customerPk: '2607::CL20260705-001', reviewStatus: 'passed' });
  const from = '2026-07-04T15:00:00.000Z';
  const to = '2026-07-05T15:00:00.000Z';
  // 投影每 2 分钟刷一次、重启还全量刷 → 历史行的 projected_at 必然晚于那天,
  // 这条口径恒为 0。显示「当日已审 0 批」会被读成"那天没人干活",比不显示更糟。
  const day = repo.summary({ month: '2026-07', receivedFromIso: from, receivedToIso: to, todayStartIso: from, todayEndIso: to });
  assert.equal(day.todayReviewedBatches, null, '不适用就明说不适用,不给假 0');
  assert.equal(day.todayCount, 1, '「当日新增」照常给(received_at 是真的收票时刻)');
  // 看今天(无上界)仍是数字,零回归
  const today = repo.summary({ month: '2026-07', todayStartIso: '2026-07-05T00:00:00.000Z' });
  assert.equal(typeof today.todayReviewedBatches, 'number');
});
