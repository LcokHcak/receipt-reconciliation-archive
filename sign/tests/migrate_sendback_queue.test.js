'use strict';

// V2 Task6:旧回发队列 JSON → workflow_task 迁移 + sendback adapter 兼容层。
// 语义:dry-run 只计数不写;apply 保留时间/操作人/note/payload;重跑幂等;
// adapter 模式下旧 API(enqueue/markDone/cancelByGroup/list)形状不变,读写新表。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { createWorkflowTaskRepository } = require('../repositories/workflow_task_repository');
const { createSendbackQueueRepository } = require('../repositories/sendback_queue_repository');
const { migrateSendbackQueue } = require('../scripts/migrate_sendback_queue');

const LEGACY_ITEMS = [
  {
    id: 'sb_aaa11111',
    batchId: 'b1', groupKey: 'g1', workspaceKey: '260710-小票22',
    action: 'send_17', mode: '发17号', tourNo: '2600041',
    status: 'pending', createdAt: '2026-07-10T02:00:00.000Z', createdBy: '审核1',
    dueAt: '2026-07-10T06:00:00.000Z', sentBy: '', sentAt: '', note: '',
  },
  {
    id: 'sb_bbb22222',
    batchId: 'b1', groupKey: 'g2', workspaceKey: '260710-小票22',
    action: 's_activity', mode: 'S活动', tourNo: '',
    status: 'done', createdAt: '2026-07-09T02:00:00.000Z', createdBy: '审核2',
    dueAt: '2026-07-09T06:00:00.000Z', sentBy: '收票员A', sentAt: '2026-07-09T03:00:00.000Z', note: '已发群',
  },
  {
    id: 'sb_ccc33333',
    batchId: 'b2', groupKey: 'g1', workspaceKey: '260709-小票13',
    action: 'send_12', mode: '发12号', tourNo: '2600099',
    status: 'cancelled', createdAt: '2026-07-08T02:00:00.000Z', createdBy: '审核1',
    dueAt: '2026-07-08T06:00:00.000Z', sentBy: '', sentAt: '', note: '撤销确认',
  },
];

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-sendback-'));
  const db = new DatabaseSync(path.join(dir, 'wb.sqlite'));
  t.after(() => { try { db.close(); } catch { /* closed */ } });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const filePath = path.join(dir, 'sendback_queue.json');
  fs.writeFileSync(filePath, JSON.stringify(LEGACY_ITEMS), 'utf8');
  return { dir, db, filePath };
}

test('dry-run 只计数不写库;apply 全量迁移保留时间/操作人/note;重跑幂等', (t) => {
  const { db, filePath } = setup(t);

  const dry = migrateSendbackQueue({ db, filePath, apply: false });
  assert.equal(dry.totalItems, 3);
  assert.deepEqual(dry.byStatus, { pending: 1, done: 1, cancelled: 1, other: 0 });
  assert.equal(dry.migrated, 3);
  const repo = createWorkflowTaskRepository({ db });
  assert.equal(repo.list({}).length, 0); // dry-run 未写

  const applied = migrateSendbackQueue({ db, filePath, apply: true });
  assert.equal(applied.migrated, 3);
  const rows = repo.list({});
  assert.equal(rows.length, 3);

  const done = repo.getByKey('legacy_sendback:sb_bbb22222');
  assert.equal(done.status, 'done');
  assert.equal(done.completedBy, '收票员A');
  assert.equal(done.completedAt, '2026-07-09T03:00:00.000Z');
  assert.equal(done.payload.note, '已发群');
  assert.equal(done.subtype, 's_activity');
  assert.equal(done.calendarMonth, '2026-07');
  assert.equal(done.customerId, ''); // 组级触发无客户

  const cancelled = repo.getByKey('legacy_sendback:sb_ccc33333');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.cancelReason, '撤销确认');

  const pending = repo.getByKey('legacy_sendback:sb_aaa11111');
  assert.equal(pending.status, 'pending');
  assert.equal(pending.dueAt, '2026-07-10T06:00:00.000Z'); // 原超时线保留

  // 重跑幂等
  const again = migrateSendbackQueue({ db, filePath, apply: true });
  assert.equal(again.alreadyMigrated, 3);
  assert.equal(again.migrated, 0);
  assert.equal(repo.list({}).length, 3);
});

test('adapter 模式:旧 API 形状不变,读写 workflow_task 表;JSON 文件不再被写', async (t) => {
  const { dir, db, filePath } = setup(t);
  migrateSendbackQueue({ db, filePath, apply: true });
  const before = fs.readFileSync(filePath, 'utf8');

  const workflowTaskRepository = createWorkflowTaskRepository({ db });
  const adapter = createSendbackQueueRepository({
    storageRoot: dir,
    workflowTaskRepository,
    now: () => new Date('2026-07-12T04:00:00.000Z'),
  });

  // list:迁移过来的 3 条都可见,形状=旧条目(action/mode/tourNo/sentBy...)
  const all = await adapter.list({});
  assert.equal(all.length, 3);
  const doneItem = all.find((it) => it.status === 'done');
  assert.equal(doneItem.action, 's_activity');
  assert.equal(doneItem.sentBy, '收票员A');
  assert.equal(doneItem.workspaceKey, '260710-小票22');
  // 迁移来的 pending(due 2026-07-10)在 now=07-12 已超时
  assert.equal(all.find((it) => it.status === 'pending').overdue, true);

  // enqueue:确认即入队(幂等:同批同组同动作复用)
  const item = await adapter.enqueue({
    batchId: 'b9', groupKey: 'g9', workspaceKey: '260712-小票22',
    action: 'send_18', mode: '发18号', tourNo: '2600555', createdBy: '审核3',
  });
  assert.equal(item.status, 'pending');
  assert.equal(item.dueAt, '2026-07-12T08:00:00.000Z'); // +4h
  const dup = await adapter.enqueue({ batchId: 'b9', groupKey: 'g9', action: 'send_18' });
  assert.equal(dup.id, item.id);

  // markDone → 审计
  const marked = await adapter.markDone(item.id, { operator: '收票员B', note: '发完' });
  assert.equal(marked.status, 'done');
  assert.equal(marked.sentBy, '收票员B');
  assert.equal(marked.note, '发完');

  // cancelByGroup 只动 pending
  await adapter.enqueue({ batchId: 'b9', groupKey: 'g9', action: 's_activity' });
  const n = await adapter.cancelByGroup('b9', 'g9', { note: '组撤销' });
  assert.equal(n, 1);

  // 复审 HIGH-1:done/cancelled 之后同批同组同动作要能再次入队(撤销确认→重新确认)
  const again = await adapter.enqueue({ batchId: 'b9', groupKey: 'g9', action: 'send_18' });
  assert.equal(again.status, 'pending');
  assert.notEqual(again.id, item.id); // 不是那条 done 的旧行
  const yetAgain = await adapter.enqueue({ batchId: 'b9', groupKey: 'g9', action: 'send_18' });
  assert.equal(yetAgain.id, again.id); // pending 在场仍去重

  // workspaceKey 过滤(迁移条目走 payload.legacyWorkspaceKey / 新条目走 workspace_key)
  const wsList = await adapter.list({ workspaceKey: '260710-小票22' });
  assert.equal(wsList.length, 2);

  // JSON 文件从头到尾没被写
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);
});

test('双路径隔离:回发看板只见组级行;组级撤销不动客户级 pending', async (t) => {
  const { dir, db } = setup(t);
  const workflowTaskRepository = createWorkflowTaskRepository({ db });
  const adapter = createSendbackQueueRepository({
    storageRoot: dir,
    workflowTaskRepository,
    now: () => new Date('2026-07-12T04:00:00.000Z'),
  });

  // 同批同组:一条组级(adapter 入队) + 一条客户级(票级协调器产物)
  await adapter.enqueue({ batchId: 'bx', groupKey: 'gx', action: 'send_17', workspaceKey: 'wsx' });
  workflowTaskRepository.createExpected({
    taskKey: 'send_upstream:wsx:CL-1:bx:gx:v1',
    calendarMonth: '2026-07', workspaceKey: 'wsx', customerId: 'CL-1',
    batchId: 'bx', groupKey: 'gx', taskType: 'send_upstream', subtype: 'send_17',
    createdAt: '2026-07-12T03:00:00.000Z',
  });

  // 看板只显示组级行(客户级归代理工作台 tasks 面板)
  const items = await adapter.list({});
  assert.equal(items.length, 1);
  assert.equal(items[0].workspaceKey, 'wsx');

  // 组级撤销只动组级行,客户级 pending 保留
  const n = await adapter.cancelByGroup('bx', 'gx', { note: '撤销确认' });
  assert.equal(n, 1);
  const customerTask = workflowTaskRepository.getByKey('send_upstream:wsx:CL-1:bx:gx:v1');
  assert.equal(customerTask.status, 'pending');
});

test('旧模式(不注入 workflowTaskRepository)行为不变:JSON 读写', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-sendback-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const legacy = createSendbackQueueRepository({ storageRoot: dir });
  const item = await legacy.enqueue({ batchId: 'b1', groupKey: 'g1', action: 'send_17' });
  assert.equal(item.status, 'pending');
  assert.ok(fs.existsSync(path.join(dir, 'sendback_queue.json')));
  const items = await legacy.list({});
  assert.equal(items.length, 1);
});
