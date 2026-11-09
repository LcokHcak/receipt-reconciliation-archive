'use strict';

// V2 Task6:workflow_task 持久任务表。
// 核心契约:task_key 确定性幂等(并发/重试只有一行);审计字段不被覆写;终态不可再改。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { createWorkflowTaskRepository } = require('../repositories/workflow_task_repository');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-task-'));
  const db = new DatabaseSync(path.join(dir, 'wb.sqlite'));
  t.after(() => { try { db.close(); } catch { /* closed */ } });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return { db, repo: createWorkflowTaskRepository({ db }) };
}

const BASE = {
  taskKey: 'send_upstream:ws1:CL1:b1:g1:v1',
  calendarMonth: '2026-07',
  workspaceKey: 'ws1',
  customerId: 'CL1',
  batchId: 'b1',
  groupKey: 'g1',
  agentKey: '永乐',
  taskType: 'send_upstream',
  subtype: 'send_17',
  dueAt: '2026-07-12T08:00:00.000Z',
  payload: { mode: '发17号', tourNo: '2600041' },
  createdAt: '2026-07-12T04:00:00.000Z',
  createdBy: '审核1',
};

test('createExpected 幂等:同 task_key 重复创建只有一行,第二次 created=false 返回既有行', (t) => {
  const { repo } = setup(t);
  const first = repo.createExpected(BASE);
  assert.equal(first.created, true);
  assert.equal(first.task.status, 'pending');
  assert.equal(first.task.payload.tourNo, '2600041');

  const second = repo.createExpected({ ...BASE, payload: { mode: '不该覆盖' } });
  assert.equal(second.created, false);
  assert.equal(second.task.id, first.task.id);
  assert.equal(second.task.payload.tourNo, '2600041'); // 冲突不覆盖原 payload

  assert.equal(repo.list({ workspaceKey: 'ws1' }).length, 1);
});

test('complete/cancel 审计字段;终态不可再改(done 后 cancel 不生效)', (t) => {
  const { repo } = setup(t);
  const { task } = repo.createExpected(BASE);

  const done = repo.complete(task.id, { by: '收票员A', at: '2026-07-12T05:00:00.000Z', note: '已发群' });
  assert.equal(done.status, 'done');
  assert.equal(done.completedBy, '收票员A');
  assert.equal(done.completedAt, '2026-07-12T05:00:00.000Z');
  assert.equal(done.payload.note, '已发群');

  // done 后 cancel 幂等安全:返回原行,状态/审计不变
  const after = repo.cancel(task.id, { reason: '想撤销' });
  assert.equal(after.status, 'done');
  assert.equal(after.cancelledAt, null);

  // 再 complete 一次也不改审计
  const again = repo.complete(task.id, { by: '别人', note: 'x' });
  assert.equal(again.completedBy, '收票员A');
});

test('cancelPendingByScope 只取消范围内 pending;无过滤条件直接抛错', (t) => {
  const { repo } = setup(t);
  repo.createExpected(BASE);
  repo.createExpected({ ...BASE, taskKey: 'k2', customerId: 'CL2' });
  repo.createExpected({ ...BASE, taskKey: 'k3', batchId: 'b2' });
  const doneOne = repo.createExpected({ ...BASE, taskKey: 'k4', customerId: 'CL4' });
  repo.complete(doneOne.task.id, {});

  const n = repo.cancelPendingByScope({ workspaceKey: 'ws1', customerId: 'CL1', reason: '重开' });
  assert.equal(n, 2); // BASE + k3(b2 也属 CL1);CL2/CL4 不动
  assert.equal(repo.getByKey('k2').status, 'pending');
  assert.equal(repo.getByKey('k4').status, 'done');
  assert.equal(repo.getByKey(BASE.taskKey).cancelReason, '重开');

  assert.throws(() => repo.cancelPendingByScope({}), /scope filter/);
});

test('countByScope/findPendingByScope:版本推进的数据基础', (t) => {
  const { repo } = setup(t);
  const scope = { workspaceKey: 'ws1', customerId: 'CL1', batchId: 'b1', groupKey: 'g1', taskType: 'send_upstream' };
  assert.deepEqual(repo.countByScope(scope), { pending: 0, settled: 0, total: 0 });

  const v1 = repo.createExpected(BASE);
  assert.equal(repo.findPendingByScope(scope).id, v1.task.id);
  repo.complete(v1.task.id, {});
  assert.deepEqual(repo.countByScope(scope), { pending: 0, settled: 1, total: 1 });

  repo.createExpected({ ...BASE, taskKey: 'send_upstream:ws1:CL1:b1:g1:v2', subtype: 'correction' });
  assert.deepEqual(repo.countByScope(scope), { pending: 1, settled: 1, total: 2 });
  assert.equal(repo.findPendingByScope(scope).subtype, 'correction');
});

test('list 过滤(month/agent/type/subtype/status/group)+ limit 钳制', (t) => {
  const { repo } = setup(t);
  repo.createExpected(BASE);
  repo.createExpected({ ...BASE, taskKey: 'k-other-month', calendarMonth: '2026-06', subtype: 's_activity' });
  repo.createExpected({ ...BASE, taskKey: 'k-other-agent', agentKey: '贝拉' });

  assert.equal(repo.list({ calendarMonth: '2026-07' }).length, 2);
  assert.equal(repo.list({ agentKey: '贝拉' }).length, 1);
  assert.equal(repo.list({ subtype: 's_activity' })[0].calendarMonth, '2026-06');
  assert.equal(repo.list({ groupKey: 'g1' }).length, 3);
  assert.equal(repo.list({ status: 'pending', limit: 2 }).length, 2);
});

test('DDL 幂等:同一 db 上重复创建仓库不报错、不丢数据', (t) => {
  const { db, repo } = setup(t);
  repo.createExpected(BASE);
  const repo2 = createWorkflowTaskRepository({ db });
  assert.equal(repo2.getByKey(BASE.taskKey).taskKey, BASE.taskKey);
});
