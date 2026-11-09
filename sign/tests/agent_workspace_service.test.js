'use strict';

// V2 Task8:代理工作台服务层——权限矩阵 + scope 收窄 + 契约校验 + 任务完成语义。
// 铁律:summary/agents/customers/tasks 共用 buildAgentWorkspaceScope;
// reviewer 传别人 ownerUserId 也不能扩大;finance 只读;409 code 明确。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { createAgentWorkspaceRepository } = require('../repositories/agent_workspace_repository');
const { createWorkflowTaskRepository } = require('../repositories/workflow_task_repository');
const { createAgentWorkspaceService } = require('../services/agent_workspace_service');

const ADMIN = { userId: 1, username: 'admin', role: 'admin' };
const FINANCE = { userId: 2, username: 'fin', role: 'finance' };
const REVIEWER_A = { userId: 15, username: '小票22', role: 'reviewer' };
const REVIEWER_B = { userId: 16, username: '小票13', role: 'reviewer' };

function anchor({ ws = 'ws1', id, agent = '永乐', owner = REVIEWER_A, month = '2026-07', status }) {
  return {
    customerPk: `${ws}::${id}`,
    calendarMonth: month,
    workspaceKey: ws,
    customerId: id,
    ownerUserId: owner.userId,
    ownerUsername: owner.username,
    agentKey: agent,
    agentName: agent,
    agentUnlabeled: false,
    customerName: id,
    activeBatchId: '',
    activeGroupKey: '',
    receivedAt: '2026-07-05T03:00:00.000Z',
    originalImageCount: 1,
    abnormalImageCount: 0,
    ...(status ? {} : {}),
  };
}

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ws-svc-'));
  const db = new DatabaseSync(path.join(dir, 'wb.sqlite'));
  t.after(() => { try { db.close(); } catch { /* closed */ } });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const agentRepo = createAgentWorkspaceRepository({ db });
  const taskRepo = createWorkflowTaskRepository({ db });
  const service = createAgentWorkspaceService({
    agentWorkspaceRepository: agentRepo,
    workflowTaskRepository: taskRepo,
    db,
    now: () => new Date('2026-07-12T04:00:00.000Z'),
  });

  // 数据:A 的两个客户(永乐/贝拉),B 的一个客户(永乐)
  agentRepo.upsertCustomerAnchor(anchor({ id: 'CL-A1', agent: '永乐', owner: REVIEWER_A }));
  agentRepo.upsertCustomerAnchor(anchor({ id: 'CL-A2', agent: '贝拉', owner: REVIEWER_A }));
  agentRepo.upsertCustomerAnchor(anchor({ id: 'CL-B1', agent: '永乐', owner: REVIEWER_B }));

  const mkTask = (customerId, key) => taskRepo.createExpected({
    taskKey: key,
    calendarMonth: '2026-07',
    workspaceKey: 'ws1',
    customerId,
    batchId: 'b1',
    groupKey: 'g1',
    agentKey: '永乐',
    taskType: 'send_upstream',
    subtype: 'send_17',
    createdAt: '2026-07-12T03:00:00.000Z',
  }).task;
  const taskA = mkTask('CL-A1', 'k-a');
  const taskB = mkTask('CL-B1', 'k-b');

  return { db, agentRepo, taskRepo, service, taskA, taskB };
}

test('scope 收窄:reviewer 只见自己;传别人 ownerUserId 不能扩大;admin 可全局/可收窄', (t) => {
  const { service } = setup(t);

  // summary
  assert.equal(service.getSummary(ADMIN, { month: '2026-07' }).visibleAll.totalCustomers, 3);
  assert.equal(service.getSummary(REVIEWER_A, { month: '2026-07' }).visibleAll.totalCustomers, 2);
  // reviewer 冒充查 B → 仍是自己的 2
  assert.equal(service.getSummary(REVIEWER_A, { month: '2026-07', ownerUserId: REVIEWER_B.userId }).visibleAll.totalCustomers, 2);
  // admin 主动收窄到 B → 1
  assert.equal(service.getSummary(ADMIN, { month: '2026-07', ownerUserId: REVIEWER_B.userId }).visibleAll.totalCustomers, 1);

  // agents / customers / tasks 同一个口径
  assert.equal(service.listAgents(REVIEWER_A, { month: '2026-07' }).agents.length, 2);
  assert.equal(service.listCustomers(REVIEWER_A, { month: '2026-07' }).customers.length, 2);
  assert.equal(service.listTasks(REVIEWER_A, { month: '2026-07' }).tasks.length, 1);
  assert.equal(service.listTasks(REVIEWER_A, { month: '2026-07', ownerUserId: REVIEWER_B.userId }).tasks.length, 1);
  assert.equal(service.listTasks(ADMIN, { month: '2026-07' }).tasks.length, 2);

  // selectedAgent 与 visibleAll 双组数字
  const s = service.getSummary(REVIEWER_A, { month: '2026-07', agentKey: '永乐' });
  assert.equal(s.selectedAgent.totalCustomers, 1);
  assert.equal(s.visibleAll.totalCustomers, 2);
});

test('契约校验:非法月 400 invalid_month;非法状态筛选 400;projectionLag/warnings 附带', (t) => {
  const { service } = setup(t);
  for (const bad of ['', '2026-13', '260701-小票22', '2026/07']) {
    assert.throws(() => service.getSummary(ADMIN, { month: bad }), (e) => e.code === 'invalid_month');
  }
  assert.throws(
    () => service.listCustomers(ADMIN, { month: '2026-07', reviewStatus: '随便' }),
    (e) => e.code === 'invalid_review_status'
  );
  assert.throws(
    () => service.listTasks(ADMIN, { month: '2026-07', status: 'weird' }),
    (e) => e.code === 'invalid_task_status'
  );
  const s = service.getSummary(ADMIN, { month: '2026-07' });
  assert.ok(s.projectionLagMs >= 0);
  assert.ok(s.warnings);
  // months 列表(前端默认月用;不从 workspaceKey 推导)
  assert.deepEqual(service.listMonths()[0], { month: '2026-07', customers: 3 });
});

test('completeTask 权限:finance 403 只读;reviewer 只能完成自己客户的任务', (t) => {
  const { service, taskA, taskB } = setup(t);
  assert.throws(() => service.completeTask(FINANCE, taskA.id, {}), (e) => e.status === 403 && e.code === 'workspace_read_only');
  assert.throws(() => service.completeTask(REVIEWER_A, taskB.id, {}), (e) => e.status === 403 && e.code === 'task_forbidden');

  const done = service.completeTask(REVIEWER_A, taskA.id, { note: '发完' });
  assert.equal(done.task.status, 'done');
  assert.equal(done.task.completedBy, '小票22');

  // admin 可完成任何
  const doneB = service.completeTask(ADMIN, taskB.id, {});
  assert.equal(doneB.task.status, 'done');
});

test('completeTask 语义:重复完成幂等;cancelled 409;版本冲突 409;不存在 404', (t) => {
  const { service, taskRepo, taskA } = setup(t);
  service.completeTask(ADMIN, taskA.id, {});
  const again = service.completeTask(ADMIN, taskA.id, {});
  assert.equal(again.idempotent, true);
  assert.equal(again.task.status, 'done');

  const c = taskRepo.createExpected({
    taskKey: 'k-c', calendarMonth: '2026-07', workspaceKey: 'ws1', customerId: 'CL-A1',
    taskType: 'send_upstream', createdAt: '2026-07-12T03:00:00.000Z',
  }).task;
  taskRepo.cancel(c.id, { reason: 'x' });
  assert.throws(() => service.completeTask(ADMIN, c.id, {}), (e) => e.status === 409 && e.code === 'task_cancelled');

  const d = taskRepo.createExpected({
    taskKey: 'k-d', calendarMonth: '2026-07', workspaceKey: 'ws1', customerId: 'CL-A1',
    taskType: 'send_upstream', createdAt: '2026-07-12T03:00:00.000Z',
  }).task;
  assert.throws(() => service.completeTask(ADMIN, d.id, { expectedVersion: 99 }), (e) => e.status === 409 && e.code === 'task_version_conflict');
  assert.throws(() => service.completeTask(ADMIN, 'no-such', {}), (e) => e.status === 404);
});

test('carryover:往月 pending 计入本月列表,done 不带过来;includeCarryover=false 关掉', (t) => {
  const { service, taskRepo } = setup(t);
  taskRepo.createExpected({
    taskKey: 'k-june-pending', calendarMonth: '2026-06', workspaceKey: 'ws1', customerId: 'CL-A1',
    taskType: 'send_upstream', createdAt: '2026-06-30T03:00:00.000Z',
  });
  const june = taskRepo.createExpected({
    taskKey: 'k-june-done', calendarMonth: '2026-06', workspaceKey: 'ws1', customerId: 'CL-A1',
    taskType: 'send_upstream', createdAt: '2026-06-29T03:00:00.000Z',
  }).task;
  taskRepo.complete(june.id, {});

  const withCarry = service.listTasks(ADMIN, { month: '2026-07' });
  assert.ok(withCarry.tasks.some((x) => x.taskKey === 'k-june-pending'));
  assert.ok(!withCarry.tasks.some((x) => x.taskKey === 'k-june-done'));

  const noCarry = service.listTasks(ADMIN, { month: '2026-07', includeCarryover: 'false' });
  assert.ok(!noCarry.tasks.some((x) => x.taskKey === 'k-june-pending'));
});

// ── 「下一步任务」空白格含义是反的(0731 核账 #16,已实机取证)──────────────
// 客户列表 ORDER BY received_at DESC(最新收票在前),任务列表 ORDER BY due_at ASC
// (最早到期在前)+ 硬顶 50,而前端 loadTasks() 一直不传 limit。
// 两个排序正好相反 → 当月 pending 超 50 时,客户列表第一页(最新收的)那批客户,
// 它们的任务恰好排在任务查询末尾、落在 50 之外 → 那一格渲染成空白。
// 而空白在界面语义上 = 「没有任务,不用管」——**含义正好相反**,
// 最新收进来的客户会被系统性忽略。
//
// 修法:任务查询支持按 customerIds 收窄,前端拿"这一页显示的客户"去要任务。

test('⭐按 customerIds 收窄任务查询(前端只需要屏幕上这批客户的任务)', (t) => {
  const { service } = setup(t);
  const all = service.listTasks(ADMIN, { month: '2026-07' }).tasks;
  assert.equal(all.length, 2, '不收窄时两条都在');

  const only = service.listTasks(ADMIN, { month: '2026-07', customerIds: ['CL-A1'] }).tasks;
  assert.equal(only.length, 1, 'customerIds 没生效');
  assert.equal(only[0].customerId, 'CL-A1');

  // 空数组要当"没指定"处理,不能变成"查不到任何东西"——
  // 否则客户还没加载完那一瞬间会把所有任务格刷成空(又是一次假空白)
  assert.equal(service.listTasks(ADMIN, { month: '2026-07', customerIds: [] }).tasks.length, 2);

  // 收窄仍受权限 scope 约束,不能借它越权看别人的
  assert.equal(
    service.listTasks(REVIEWER_A, { month: '2026-07', customerIds: ['CL-B1'] }).tasks.length,
    0,
    '收窄不能绕过 scope',
  );
});

test('⭐前端要按当前这页客户去取任务,而不是无脑取全月前 50 条', () => {
  const src = fs.readFileSync(path.join(__dirname, '../frontend/src/stores/agentWorkspace.js'), 'utf8');
  const i = src.indexOf('async loadTasks(');
  assert.notEqual(i, -1);
  const body = src.slice(i, src.indexOf('\n    },', i));
  assert.ok(body.includes('customerIds'), 'loadTasks 还是不带客户范围 —— 空白格的含义仍然是反的');

  // 而且必须在客户加载完之后才取任务,否则 customerIds 是空的
  const r = src.indexOf('async reloadAll(');
  const rbody = src.slice(r, src.indexOf('\n    },', r));
  assert.ok(!/loadCustomers\(\{ reset: true \}\),\s*\n\s*this\.loadTasks\(\)/.test(rbody),
    'reloadAll 里客户和任务还在并行 —— 取任务时拿不到客户列表');
});
