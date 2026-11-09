'use strict';

// V2 Task7:票级表态写路径 → 运营任务对账(修订④)。
// 只认转变沿:组从「有未表态」→「全部表态」才建 send_upstream(done 后随手改字段不得开新版本);
// 已表态→清表态 = 重开(pending 取消 / done 生成 correction);失败吞掉记 retry 不抛。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { createWorkflowTaskRepository } = require('../repositories/workflow_task_repository');
const { createWorkflowTaskService } = require('../services/workflow_task_service');
const { createWorkflowTaskCoordinator } = require('../services/workflow_task_coordinator');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-coord-'));
  const db = new DatabaseSync(path.join(dir, 'wb.sqlite'));
  t.after(() => { try { db.close(); } catch { /* closed */ } });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const repo = createWorkflowTaskRepository({ db });
  const service = createWorkflowTaskService({
    workflowTaskRepository: repo,
    now: () => new Date('2026-07-12T04:00:00.000Z'),
  });
  const coordinator = createWorkflowTaskCoordinator({ workflowTaskService: service });
  return { repo, coordinator };
}

const WS = '260710-小票22';
const CID = 'CL20260710-001';

function receipt(id, { tourStance = '', modeRawPre = '发17号', groupNo = '2600041', ...rest } = {}) {
  return {
    id,
    docTypeFinal: 'receipt',
    machineState: 'completed',
    sourceOriginalPath: `${WS}/${CID}/${id}.jpg`,
    sourceGroupKey: 'g1',
    customerAgentName: '永乐',
    tourStance,
    modeRawPre,
    groupNoFinal: groupNo,
    ...rest,
  };
}

function passport(id) {
  return {
    id, docTypeFinal: 'passport', machineState: 'completed',
    sourceOriginalPath: `${WS}/${CID}/${id}.jpg`, sourceGroupKey: 'g1', customerAgentName: '永乐',
  };
}

function batchOf(...tasks) {
  return { id: 'b1', sourceGroups: [{ key: 'g1' }], tasks };
}

test('组内最后一张小票表态 → 建 send_upstream(subtype 时效映射,agent/团号带上)', (t) => {
  const { repo, coordinator } = setup(t);
  const t1 = receipt('t1', { tourStance: 'matched' });
  const t2now = receipt('t2', { tourStance: 'matched' });
  const batch = batchOf(t1, t2now, passport('t3'));

  const r = coordinator.afterTaskWrite({
    batch,
    previousTask: receipt('t2', { tourStance: '' }), // 写之前 t2 未表态
    task: t2now,
    operator: '审核1',
  });
  assert.ok(r.sent?.created);
  const row = repo.list({ customerId: CID })[0];
  assert.equal(row.taskType, 'send_upstream');
  assert.equal(row.subtype, 'send_17');
  assert.equal(row.agentKey, '永乐');
  assert.equal(row.payload.tourNo, '2600041');
  assert.equal(row.createdBy, '审核1');
});

test('组内还有未表态小票 → 不建;非表态字段改动(无转变沿)→ 不建', (t) => {
  const { repo, coordinator } = setup(t);
  // t2 表态了但 t1 还没 → 不建
  const r1 = coordinator.afterTaskWrite({
    batch: batchOf(receipt('t1'), receipt('t2', { tourStance: 'matched' })),
    previousTask: receipt('t2'),
    task: receipt('t2', { tourStance: 'matched' }),
  });
  assert.equal(r1.sent, null);

  // 全表态状态下改无关字段(stance 前后一致)→ 不触发(防 done 后开新版本)
  const done = receipt('t2', { tourStance: 'matched' });
  const r2 = coordinator.afterTaskWrite({
    batch: batchOf(receipt('t1', { tourStance: 'matched' }), done),
    previousTask: done,
    task: done,
  });
  assert.equal(r2.sent, null);
  assert.equal(repo.list({}).length, 0);
});

test('豁免票不挡道:百货/无团号票未表态也算组完成;全豁免组不建任务', (t) => {
  const { repo, coordinator } = setup(t);
  // 一张正常票 + 一张百货票(豁免,无 stance)→ 正常票表态即完成
  const dept = receipt('td', { modeRawPre: '', groupNo: '', receiptStoreFinal: 'LOTTE_DEPT' });
  const r = coordinator.afterTaskWrite({
    batch: batchOf(receipt('t1', { tourStance: 'matched' }), dept),
    previousTask: receipt('t1'),
    task: receipt('t1', { tourStance: 'matched' }),
  });
  assert.ok(r.sent?.created);

  // 全豁免(全是百货)→ 组本来就无待表态,不会有转变沿;直接调用也会被 exempt_only 挡住
  assert.equal(repo.list({}).length, 1);
});

test('重开沿:清表态 → pending 取消;done 后重开 → correction', (t) => {
  const { repo, coordinator } = setup(t);
  const stanced = receipt('t1', { tourStance: 'matched' });
  coordinator.afterTaskWrite({
    batch: batchOf(stanced),
    previousTask: receipt('t1'),
    task: stanced,
  });
  assert.equal(repo.list({ status: 'pending' }).length, 1);

  // 「改」:清表态 → pending 取消
  const r = coordinator.afterTaskWrite({
    batch: batchOf(receipt('t1')),
    previousTask: stanced,
    task: receipt('t1'),
  });
  assert.equal(r.reopened.cancelled, 1);
  assert.equal(repo.list({ status: 'cancelled' }).length, 1);

  // 再表态 → v2;发完;再重开 → correction v3
  coordinator.afterTaskWrite({ batch: batchOf(stanced), previousTask: receipt('t1'), task: stanced });
  const v2 = repo.list({ status: 'pending' })[0];
  assert.match(v2.taskKey, /:v2$/);
  repo.complete(v2.id, { by: '收票员A' });
  const r2 = coordinator.afterTaskWrite({
    batch: batchOf(receipt('t1')),
    previousTask: stanced,
    task: receipt('t1'),
  });
  assert.equal(r2.reopened.correction.subtype, 'correction');
});

test('豁免转变沿(复审 MEDIUM):最后一张未表态票被改成百货豁免 → 同样触发 send_upstream', (t) => {
  const { repo, coordinator } = setup(t);
  // t1 已表态,t2 未表态挡着;本次写把 t2 店名改成百货(变豁免,tourStance 前后都空)
  const t2Before = receipt('t2', { modeRawPre: '' });
  const t2After = receipt('t2', { modeRawPre: '', receiptStoreFinal: 'LOTTE_DEPT' });
  const r = coordinator.afterTaskWrite({
    batch: batchOf(receipt('t1', { tourStance: 'matched' }), t2After),
    previousTask: t2Before,
    task: t2After,
  });
  assert.ok(r.sent?.created); // 组的待表态数 1→0,非表态字段路径也要触发
  assert.equal(repo.list({})[0].subtype, 'send_17'); // t1 matched 的模式
});

test('无客户引用(直传批次)→ 静默跳过;服务抛错 → 吞掉记 retry 不抛', (t) => {
  const { coordinator } = setup(t);
  const orphan = { id: 'x', docTypeFinal: 'receipt', sourceOriginalPath: 'x.jpg', tourStance: 'matched' };
  const r = coordinator.afterTaskWrite({
    batch: { id: 'b1', tasks: [orphan] },
    previousTask: { ...orphan, tourStance: '' },
    task: orphan,
  });
  assert.deepEqual(r, { sent: null, reopened: null });

  // 服务抛错:换一个坏 service
  const broken = createWorkflowTaskCoordinator({
    workflowTaskService: {
      ensureSendUpstream() { throw new Error('boom'); },
      onStanceReopened() { throw new Error('boom'); },
    },
  });
  const stanced = receipt('t1', { tourStance: 'matched' });
  const r2 = broken.afterTaskWrite({
    batch: batchOf(stanced),
    previousTask: receipt('t1'),
    task: stanced,
  });
  assert.equal(r2.failed, true);
  assert.equal(broken.getRetryItems().length, 1);
  assert.match(broken.getRetryItems()[0].message, /boom/);
});
