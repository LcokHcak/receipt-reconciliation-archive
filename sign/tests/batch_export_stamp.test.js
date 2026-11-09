'use strict';

// 导出留痕(P1,2026-07-18):markBatchExported 盖章写服务单测。
// 锁住:必须经 withBatchWrite(并发互吞铁律)/三字段落值/updatedAt 跟走/404 兜底。

const assert = require('node:assert/strict');
const test = require('node:test');

const { createBatchOperations } = require('../services/workbench_write/batch');

function makeOps({ batch = null } = {}) {
  const calls = { withBatchWrite: [], saved: [] };
  const common = {
    error: (status, body) => ({ status, body }),
    ok: (body) => ({ status: 200, body }),
    hasBatch: () => Boolean(batch),
    loadBatch: () => batch,
    // 保真 mock:生产 saveBatchAsync 落盘时无条件盖新 updatedAt(repository 行为)
    saveBatchAsync: async (b) => { b.updatedAt = new Date().toISOString(); calls.saved.push(b); },
    summarizeBatch: (b) => b,
    withBatchWrite: (batchId, action, options) => {
      calls.withBatchWrite.push({ batchId, label: options?.label });
      return action();
    },
  };
  const ops = createBatchOperations({
    common,
    clearActiveBatch: () => {},
    removeBatchDirectory: () => {},
    workbenchGroupApprovalService: {},
  });
  return { ops, calls };
}

test('markBatchExported:锁内盖章三字段 + updatedAt 跟走', async () => {
  const batch = { id: 'b1', updatedAt: '2026-07-01T00:00:00.000Z', tasks: [] };
  const { ops, calls } = makeOps({ batch });

  const result = await ops.markBatchExported({
    batchId: 'b1',
    kind: 'mode',
    operator: { username: ' admin ' },
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.exportKind, 'mode');
  assert.equal(calls.withBatchWrite.length, 1, '必须经 withBatchWrite(并发互吞铁律)');
  assert.equal(calls.withBatchWrite[0].batchId, 'b1');
  assert.equal(calls.withBatchWrite[0].label, 'markBatchExported');
  assert.equal(calls.saved.length, 1, '锁内 saveBatchAsync 落盘');
  assert.equal(batch.exportKind, 'mode');
  assert.equal(batch.exportedBy, 'admin', '用户名去空格');
  assert.ok(batch.exportedAt, '盖了导出时间');
  // updatedAt 由 saveBatchAsync 落盘时统一盖(导出算一次动作,超时判定复位)
  assert.ok(batch.updatedAt >= batch.exportedAt, '落盘后 updatedAt 不早于盖章时间');
});

test('markBatchExported:批次不存在给 404,不落盘', async () => {
  const { ops, calls } = makeOps({ batch: null });
  const result = await ops.markBatchExported({ batchId: 'ghost', kind: 'workbook' });
  assert.equal(result.status, 404);
  assert.equal(calls.saved.length, 0);
});

test('markBatchExported:无操作员时 exportedBy 为 null(定时/脚本导出场景)', async () => {
  const batch = { id: 'b2', tasks: [] };
  const { ops } = makeOps({ batch });
  await ops.markBatchExported({ batchId: 'b2', kind: 'workbook' });
  assert.equal(batch.exportedBy, null);
});

// 导出失败留痕(2026-07-26 待管理事项·导出失败):失败盖戳、成功清戳。
test('markBatchExportFailed:锁内盖失败戳(kind/原因截断/操作人),走批次写锁', async () => {
  const batch = { id: 'b1', updatedAt: '2026-07-01T00:00:00.000Z', tasks: [] };
  const { ops, calls } = makeOps({ batch });

  const result = await ops.markBatchExportFailed({
    batchId: 'b1',
    kind: 'lotte_dept',
    reason: 'x'.repeat(500),
    operator: { username: ' admin ' },
  });

  assert.equal(result.status, 200);
  assert.ok(batch.exportFailedAt, '盖了失败时间戳');
  assert.equal(batch.exportFailedKind, 'lotte_dept');
  assert.equal(batch.exportFailedError.length, 300, '原因截断 300 防 batch.json 膨胀');
  assert.equal(batch.exportFailedBy, 'admin');
  assert.equal(calls.withBatchWrite[0]?.label, 'markBatchExportFailed', '必须走批次写锁');
  assert.equal(calls.saved.length, 1);
});

test('markBatchExported:成功后清掉失败戳(重试成功不再挂待办)', async () => {
  const batch = {
    id: 'b1',
    updatedAt: '2026-07-01T00:00:00.000Z',
    tasks: [],
    exportFailedAt: '2026-07-25T00:00:00.000Z',
    exportFailedKind: 'lotte_dept',
    exportFailedError: '打包失败',
    exportFailedBy: 'someone',
  };
  const { ops } = makeOps({ batch });

  await ops.markBatchExported({ batchId: 'b1', kind: 'lotte_dept', operator: { username: 'admin' } });

  assert.ok(batch.exportedAt, '成功戳在');
  assert.equal(batch.exportFailedAt, '', '失败戳已清');
  assert.equal(batch.exportFailedKind, '');
  assert.equal(batch.exportFailedError, '');
  assert.equal(batch.exportFailedBy, null, '失败四字段一起清,不留"谁失败过"的孤儿值');
});

test('markBatchExportFailed:批次不存在给 404', async () => {
  const { ops } = makeOps({ batch: null });
  const result = await ops.markBatchExportFailed({ batchId: 'nope', kind: 'mode' });
  assert.equal(result.status, 404);
});
