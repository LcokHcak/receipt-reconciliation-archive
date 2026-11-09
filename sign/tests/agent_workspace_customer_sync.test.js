'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createWorkbenchSqliteRepository } = require('../repositories/workbench_sqlite_repository');
const { createAgentWorkspaceRepository } = require('../repositories/agent_workspace_repository');
const { createCustomerLibraryRepository } = require('../repositories/customer_library_repository');
const { createCustomerProjectionHooks } = require('../lib/agent_workspace/customer_sync');

function setup(t, { timeZone = 'Asia/Seoul', breakRepo = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ws-sync-'));
  const wsRepo = createWorkbenchSqliteRepository({ dbPath: path.join(dir, 'wb.sqlite') });
  const agentRepo = createAgentWorkspaceRepository({ db: wsRepo.db });
  const target = breakRepo
    ? { ...agentRepo, upsertCustomerAnchor() { throw new Error('boom'); } }
    : agentRepo;
  const hooks = createCustomerProjectionHooks({ agentWorkspaceRepository: target, timeZone });
  const customers = createCustomerLibraryRepository({
    defaultRoot: path.join(dir, 'library'),
    settingsPath: path.join(dir, 'settings.json'),
    projectionHooks: hooks,
  });
  t.after(() => wsRepo.close());
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return { agentRepo, hooks, customers };
}

test('建档即投影锚点:代理/owner/图片数/业务时区自然月(UTC边界=韩国月初00:30)', (t) => {
  const { agentRepo, customers } = setup(t);
  customers.createCustomerFolder({
    workspaceKey: '260701-小票22',
    customerId: 'CL20260701-001',
    agentName: '永乐',
    ownerUserId: 15,
    ownerUsername: '小票22',
    images: [{ imageId: 'i1' }, { imageId: 'i2' }],
  });
  // createCustomerRecord 会写 createdAt=now;直接覆盖保存一个跨月边界值验证月口径
  const saved = customers.loadCustomer('260701-小票22', 'CL20260701-001');
  customers.saveCustomer({ ...saved, createdAt: '2026-06-30T15:30:00.000Z' }); // 首尔 07-01 00:30
  const row = agentRepo.getCustomer('260701-小票22::CL20260701-001');
  assert.ok(row);
  assert.equal(row.agentKey, '永乐');
  assert.equal(row.ownerUserId, 15);
  assert.equal(row.originalImageCount, 2);
  assert.equal(row.calendarMonth, '2026-07'); // 业务时区推月,非 UTC 的 2026-06
});

test('改代理/改图片数会反映到读模型;软删墓碑保存=移除行;删除客户=移除行', (t) => {
  const { agentRepo, customers } = setup(t);
  const rec = customers.createCustomerFolder({
    workspaceKey: 'ws1', customerId: 'CL20260705-001', agentName: '永乐', images: [],
  });
  customers.saveCustomer({ ...rec, agentName: '贝拉', images: [{ imageId: 'a' }] });
  let row = agentRepo.getCustomer('ws1::CL20260705-001');
  assert.equal(row.agentKey, '贝拉');
  assert.equal(row.originalImageCount, 1);

  // 软删墓碑(带 deletedAt 的保存)→ 读模型移除(与 listCustomers 过滤同口径)
  customers.saveCustomer({ ...customers.loadCustomer('ws1', 'CL20260705-001'), deletedAt: '2026-07-05T00:00:00.000Z' });
  assert.equal(agentRepo.getCustomer('ws1::CL20260705-001'), null);

  // 重建后走 deleteCustomer 硬删
  const rec2 = customers.createCustomerFolder({ workspaceKey: 'ws1', customerId: 'CL20260705-002', agentName: 'x', images: [] });
  assert.ok(agentRepo.getCustomer('ws1::CL20260705-002'));
  customers.deleteCustomer('ws1', rec2.customerId, { hard: true });
  assert.equal(agentRepo.getCustomer('ws1::CL20260705-002'), null);
});

test('deleteWorkspace 整库删除:逐客户触发读模型移除,不留幽灵行', (t) => {
  const { agentRepo, customers } = setup(t);
  customers.createCustomerFolder({ workspaceKey: 'ws-gone', customerId: 'CL20260705-101', agentName: '永乐', images: [] });
  customers.createCustomerFolder({ workspaceKey: 'ws-gone', customerId: 'CL20260705-102', agentName: '贝拉', images: [] });
  customers.createCustomerFolder({ workspaceKey: 'ws-stay', customerId: 'CL20260705-201', agentName: '汉拿', images: [] });
  assert.ok(agentRepo.getCustomer('ws-gone::CL20260705-101'));
  assert.ok(agentRepo.getCustomer('ws-gone::CL20260705-102'));

  customers.deleteWorkspace('ws-gone', { force: true });
  assert.equal(agentRepo.getCustomer('ws-gone::CL20260705-101'), null);
  assert.equal(agentRepo.getCustomer('ws-gone::CL20260705-102'), null);
  // 别的工作区不受影响
  assert.ok(agentRepo.getCustomer('ws-stay::CL20260705-201'));
});

test('投影钩子抛错不回滚客户主写入,失败记为可检索 retry 项', (t) => {
  const { hooks, customers } = setup(t, { breakRepo: true });
  const rec = customers.createCustomerFolder({
    workspaceKey: 'ws1', customerId: 'CL20260705-009', agentName: '永乐', images: [],
  });
  // 主写入成功(客户 JSON 在)
  assert.ok(rec.customerId);
  assert.ok(customers.loadCustomer('ws1', 'CL20260705-009'));
  // 失败被记录
  const retries = hooks.getRetryItems();
  assert.ok(retries.length >= 1);
  assert.equal(retries[0].event, 'afterCustomerSaved');
  assert.match(retries[0].message, /boom/);
});
