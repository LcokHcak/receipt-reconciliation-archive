'use strict';

// 8模块审计 HIGH:已结算组「同图补小票」后点确认被 settledGroupKeys 拦下,新票不入台账。
// 后端修法:createManualReceiptFromTask 给已结算组补票时 clearGroupSettlement 撤章,
// 返回 reopenedGroupKey 让前端同步清 settledGroupKeys。锁住:只在真已结算时撤+返回。

const assert = require('node:assert/strict');
const test = require('node:test');

const { createTaskOperations } = require('../services/workbench_write/task');
const { createManualReceiptTaskFromSource } = require('../lib/workbench_task_factory');

function buildOps(batch) {
  const common = {
    error: (status, body) => ({ status, body }),
    ok: (body) => ({ status: 200, body }),
    hasBatch: () => Boolean(batch),
    loadBatch: () => batch,
    removeProjectionSafely: () => {},
    saveBatchAsync: async () => {},
    summarizeBatch: (b) => b,
    withBatchWrite: (_batchId, action) => action(),
  };
  return createTaskOperations({
    common,
    createManualReceiptTaskFromSource,
    normalizeFieldValue: (v) => String(v == null ? '' : v).trim(),
    recalcTask: () => {},
  });
}

function makeBatch(groupOverrides) {
  return {
    id: 'b1',
    sourceGroups: [{ key: 'g1', label: '济州A团', ...groupOverrides }],
    tasks: [{
      id: 't1',
      sourceImagePath: 'ws/CL-001/01.jpg',
      sourceGroupKey: 'g1',
      sourceGroupLabel: '济州A团',
    }],
  };
}

test('已结算组补票:返回 reopenedGroupKey 但绝不撤章(settledAt 保留=删除守卫全程在岗,深度审计HIGH)', async () => {
  const batch = makeBatch({ settledAt: '2026-07-20T10:00:00.000Z', settlementStatus: 'settled' });
  const ops = buildOps(batch);

  const res = await ops.createManualReceiptFromTask({ batchId: 'b1', taskId: 't1' });

  assert.equal(res.status, 200);
  assert.equal(res.body.reopenedGroupKey, 'g1', '返回重开键,前端据此清 settledGroupKeys 放行重新结算');
  const g = batch.sourceGroups.find((x) => x.key === 'g1');
  // ⭐关键:绝不清 settledAt——否则 deleteTask/deleteBatch 的 B5 删除守卫在重开窗口被解除,
  //   组内已入台账票可被物理删+台账悬空(f9e368b 撤章引入的洞,本次回退)。
  assert.equal(g.settledAt, '2026-07-20T10:00:00.000Z', 'settledAt 保留=删除守卫仍在岗');
  assert.equal(g.settlementStatus, 'settled', 'settlementStatus 保留');
  assert.ok(!g.ledgerCorrections || g.ledgerCorrections.length === 0, '不撤章=不压订正史');
  // 删除守卫口径(settledAt || settlementStatus==='settled')仍锁本组
  assert.equal(Boolean(g.settledAt) || g.settlementStatus === 'settled', true, '补票后组仍受删除守卫保护');
  // 新票确实加进去了(在源票之后);re-settle 幂等会把它并入台账
  assert.equal(batch.tasks.length, 2);
  assert.equal(batch.tasks[1].sourceGroupKey, 'g1');
});

test('未结算组补票:不撤章、不压订正史、reopenedGroupKey 为空(避免每次补票压空订正)', async () => {
  const batch = makeBatch({ settlementStatus: '' });
  const ops = buildOps(batch);

  const res = await ops.createManualReceiptFromTask({ batchId: 'b1', taskId: 't1' });

  assert.equal(res.status, 200);
  assert.equal(res.body.reopenedGroupKey, '', '未结算不返回重开键');
  const g = batch.sourceGroups.find((x) => x.key === 'g1');
  assert.ok(!g.ledgerCorrections || g.ledgerCorrections.length === 0, '未结算组不压订正史');
  assert.equal(batch.tasks.length, 2, '票照常补上');
});

test('源票不存在 → 404,不动批次', async () => {
  const batch = makeBatch({ settlementStatus: 'settled' });
  const ops = buildOps(batch);
  const res = await ops.createManualReceiptFromTask({ batchId: 'b1', taskId: 'ghost' });
  assert.equal(res.status, 404);
  assert.equal(batch.tasks.length, 1, '票数不变');
});
