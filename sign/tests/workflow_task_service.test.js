'use strict';

// V2 Task6:workflow_task 业务规则(票级修订③⑥)。
// send_upstream 在「组内小票全部表态」时建;未全表态/无小票/全豁免不建;
// subtype=时效动作映射(send_12/17/18/s_activity),非时效=standard;
// 撤销(票级「改」):pending 取消,done 保留并生成 correction。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { createWorkflowTaskRepository } = require('../repositories/workflow_task_repository');
const { createWorkflowTaskService } = require('../services/workflow_task_service');

function setup(t, { nowIso = '2026-07-12T04:00:00.000Z' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-svc-'));
  const db = new DatabaseSync(path.join(dir, 'wb.sqlite'));
  t.after(() => { try { db.close(); } catch { /* closed */ } });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const repo = createWorkflowTaskRepository({ db });
  const service = createWorkflowTaskService({
    workflowTaskRepository: repo,
    now: () => new Date(nowIso),
  });
  return { repo, service };
}

const CTX = {
  workspaceKey: '260710-小票22',
  customerId: 'CL20260710-001',
  batchId: 'b1',
  groupKey: 'g1',
  agentName: '永乐',
  mode: '发17号',
  tourNo: '2600041',
  receiptCount: 2,
  exemptOnly: false,
  allStanced: true,
  createdBy: '审核1',
  receivedAt: '2026-07-10T03:00:00.000Z',
};

test('全部表态+非豁免+有小票 → 建 send_upstream,subtype 按时效动作映射,重复触发幂等', (t) => {
  const { repo, service } = setup(t);
  const r1 = service.ensureSendUpstream(CTX);
  assert.equal(r1.created, true);
  assert.equal(r1.task.taskType, 'send_upstream');
  assert.equal(r1.task.subtype, 'send_17');
  assert.equal(r1.task.agentKey, '永乐');
  assert.equal(r1.task.calendarMonth, '2026-07'); // 从收票时间(业务时区)推月
  assert.equal(r1.task.payload.tourNo, '2600041');
  assert.equal(r1.task.dueAt, '2026-07-12T08:00:00.000Z'); // now+4h

  // 批次重复保存/重试 → 复用 pending,不开新版本
  const r2 = service.ensureSendUpstream(CTX);
  assert.equal(r2.created, false);
  assert.equal(r2.reason, 'pending_exists');
  assert.equal(repo.list({ customerId: CTX.customerId }).length, 1);
});

test('门槛:未全表态/无小票/全豁免/缺客户引用 → 不建任务', (t) => {
  const { repo, service } = setup(t);
  assert.equal(service.ensureSendUpstream({ ...CTX, allStanced: false }).reason, 'not_all_stanced');
  assert.equal(service.ensureSendUpstream({ ...CTX, receiptCount: 0 }).reason, 'no_receipts');
  assert.equal(service.ensureSendUpstream({ ...CTX, exemptOnly: true }).reason, 'exempt_only');
  assert.equal(service.ensureSendUpstream({ ...CTX, customerId: '' }).reason, 'missing_customer_ref');
  assert.equal(repo.list({}).length, 0);
});

test('subtype 映射:S活动/发12/发18/非时效模式', (t) => {
  const { service } = setup(t);
  const sub = (mode, customerId) => service.ensureSendUpstream({ ...CTX, mode, customerId }).task.subtype;
  assert.equal(sub('S活动查团号', 'C1'), 's_activity');
  assert.equal(sub('发12号', 'C2'), 'send_12');
  assert.equal(sub('发18号', 'C3'), 'send_18');
  assert.equal(sub('乐天正常', 'C4'), 'standard');
});

test('撤销(票级「改」):pending → 取消;不留 correction', (t) => {
  const { repo, service } = setup(t);
  service.ensureSendUpstream(CTX);
  const r = service.onStanceReopened({ ...CTX, reason: '团号看错了' });
  assert.equal(r.cancelled, 1);
  assert.equal(r.correction, null);
  const rows = repo.list({ customerId: CTX.customerId });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'cancelled');
  assert.equal(rows[0].cancelReason, '团号看错了');
});

test('撤销:已 done → 审计保留 + 生成 correction 新任务;重开后再全表态开 v3', (t) => {
  const { repo, service } = setup(t);
  const { task } = service.ensureSendUpstream(CTX);
  repo.complete(task.id, { by: '收票员A', at: '2026-07-12T05:00:00.000Z' });

  const r = service.onStanceReopened({ ...CTX, reason: '模式改判' });
  assert.equal(r.cancelled, 0);
  assert.ok(r.correction);
  assert.equal(r.correction.subtype, 'correction');
  assert.equal(r.correction.payload.reason, '模式改判');

  const done = repo.list({ customerId: CTX.customerId, status: 'done' });
  assert.equal(done.length, 1); // 原 done 审计不动
  assert.equal(done[0].completedBy, '收票员A');

  // correction 撤了再全表态 → 复用 correction pending(不重复建)
  const again = service.ensureSendUpstream(CTX);
  assert.equal(again.reason, 'pending_exists');
  assert.equal(again.task.id, r.correction.id);

  // correction 也发完了,再重开 → 重开时刻即生成 v3 correction(有 done 在场就要通知更正);
  // 之后全表态复用该 pending,不重复建
  repo.complete(r.correction.id, { by: 'B' });
  const r2 = service.onStanceReopened(CTX);
  assert.ok(r2.correction);
  assert.match(r2.correction.taskKey, /:v3$/);
  const v3 = service.ensureSendUpstream(CTX);
  assert.equal(v3.created, false);
  assert.equal(v3.task.id, r2.correction.id);
  assert.equal(repo.list({ customerId: CTX.customerId }).length, 3);
});

test('onCustomerDeleted:未完成任务全取消,done 不动', (t) => {
  const { repo, service } = setup(t);
  const a = service.ensureSendUpstream({ ...CTX, customerId: 'CL-A' });
  repo.complete(a.task.id, {});
  service.onStanceReopened({ ...CTX, customerId: 'CL-A' }); // 生成 correction pending
  const n = service.onCustomerDeleted({ workspaceKey: CTX.workspaceKey, customerId: 'CL-A' });
  assert.equal(n, 1);
  assert.equal(repo.list({ customerId: 'CL-A', status: 'done' }).length, 1);
  assert.equal(repo.list({ customerId: 'CL-A', status: 'cancelled' })[0].cancelReason, 'customer_deleted');
});
