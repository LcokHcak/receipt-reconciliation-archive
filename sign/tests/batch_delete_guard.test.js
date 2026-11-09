'use strict';

// 8模块审计 HIGH:deleteBatch 无「已结算」守卫也无批次写锁——B5 防线在批次级整体失守。
// 锁住:整批删必须进 withBatchWrite;含已结算组即 409 delete_blocked_settled(与票级/组级同码);
// 无结算组正常删(clearActive+removeProjection+removeDir 全走);批次不存在 404。

const assert = require('node:assert/strict');
const test = require('node:test');

const { createBatchOperations } = require('../services/workbench_write/batch');

function makeOps({ batch = null } = {}) {
  const calls = { withBatchWrite: [], cleared: [], removedProjection: [], removedDir: [] };
  const common = {
    error: (status, body) => ({ status, body }),
    ok: (body) => ({ status: 200, body }),
    hasBatch: () => Boolean(batch),
    loadBatch: () => batch,
    removeProjectionSafely: (id) => { calls.removedProjection.push(id); },
    saveBatchAsync: async () => {},
    summarizeBatch: (b) => b,
    withBatchWrite: (batchId, action, options) => {
      calls.withBatchWrite.push({ batchId, label: options?.label });
      return action();
    },
  };
  const ops = createBatchOperations({
    common,
    clearActiveBatch: (id) => { calls.cleared.push(id); },
    removeBatchDirectory: (id) => { calls.removedDir.push(id); },
    workbenchGroupApprovalService: {},
  });
  return { ops, calls };
}

test('deleteBatch:无结算组正常删,且全程经 withBatchWrite', async () => {
  const batch = { id: 'b1', sourceGroups: [{ key: 'g1', settlementStatus: '' }, { key: 'g2' }] };
  const { ops, calls } = makeOps({ batch });

  const result = await ops.deleteBatch({ batchId: 'b1' });

  assert.equal(result.status, 200);
  assert.equal(result.body.batchDeleted, true);
  assert.equal(calls.withBatchWrite.length, 1, '整批删必须进批次写锁(并发互吞铁律)');
  assert.equal(calls.withBatchWrite[0].label, 'deleteBatch');
  assert.deepEqual(calls.cleared, ['b1']);
  assert.deepEqual(calls.removedProjection, ['b1']);
  assert.deepEqual(calls.removedDir, ['b1']);
});

test('deleteBatch:含已结算组(settledAt)→ 409 delete_blocked_settled,不删任何东西', async () => {
  const batch = {
    id: 'b2',
    sourceGroups: [
      { key: 'g1', settlementStatus: '' },
      { key: 'g2', label: '济州A团', settledAt: '2026-07-20T10:00:00.000Z' },
    ],
  };
  const { ops, calls } = makeOps({ batch });

  const result = await ops.deleteBatch({ batchId: 'b2' });

  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'delete_blocked_settled');
  assert.equal(result.body.details.groupKey, 'g2', '定位到被拦的已结算组');
  assert.equal(result.body.details.groupLabel, '济州A团');
  // 关键:一个删除动作都不能发生
  assert.equal(calls.cleared.length, 0, '未清 active');
  assert.equal(calls.removedProjection.length, 0, '未删投影');
  assert.equal(calls.removedDir.length, 0, '未物理删目录(台账证据图保住)');
  // 但仍进了锁(在锁内校验,消除 TOCTOU)
  assert.equal(calls.withBatchWrite.length, 1);
});

test('deleteBatch:settlementStatus=settled 同样拦(两种盖章形态都认)', async () => {
  const batch = { id: 'b3', sourceGroups: [{ key: 'g1', settlementStatus: 'settled' }] };
  const { ops, calls } = makeOps({ batch });
  const result = await ops.deleteBatch({ batchId: 'b3' });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'delete_blocked_settled');
  assert.equal(calls.removedDir.length, 0);
});

test('deleteBatch:批次不存在 → 404(锁内兜底)', async () => {
  const { ops, calls } = makeOps({ batch: null });
  const result = await ops.deleteBatch({ batchId: 'ghost' });
  assert.equal(result.status, 404);
  assert.equal(calls.removedDir.length, 0);
});

test('deleteBatch:无 sourceGroups 的历史批次照常删(不误拦)', async () => {
  const batch = { id: 'b4' };
  const { ops, calls } = makeOps({ batch });
  const result = await ops.deleteBatch({ batchId: 'b4' });
  assert.equal(result.status, 200);
  assert.deepEqual(calls.removedDir, ['b4']);
});
