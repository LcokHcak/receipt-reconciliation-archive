'use strict';

// 2026-07-21 全链路病类排查修复回归:
//   B6 团号表 parsing/awaiting_upload 重启永卡 → 开机恢复扫描标 failed
//   B8 签字 queued/generating 重启死锁 → 开机复位 ''
//   P0 副本漂移:月度导入 mapper 团号「无/无团号」落库成字符串 → 收口为空串(insert 落 NULL)

const test = require('node:test');
const assert = require('node:assert/strict');

const { mapDailyReceiptRow } = require('../lib/monthly_pipeline/daily_receipt_mapper');
const { createCustomerBatchBridgeService } = require('../services/customer_batch_bridge_service');
const { createSignatureJobService } = require('../services/signature_job_service');

// ── P0 副本漂移:mapper 无团号哨兵收口 ─────────────────────────────
test('P0 mapper:团号「无/无团号」→ 空串(对齐台账桥 NULL 口径),真团号不动', () => {
  const row = (tour) => mapDailyReceiptRow({
    asObject: { 团号: tour, 姓名: '张三', 护照号: 'E12345678', 小票号: '123', 购买日期: '2026-06-01' },
    workspaceKey: '2026-06', sourceSheet: 's', sourceRow: 1, sourceFile: 'f', importedAt: 't',
  });
  assert.equal(row('无').tourNo, '', '「无」收口为空串');
  assert.equal(row('无团号').tourNo, '', '「无团号」收口为空串');
  assert.equal(row('26107001').tourNo, '26107001', '真团号原样');
  assert.equal(row('  无  ').tourNo, '', 'trim 后仍命中哨兵');
});

// ── B6 团号表中断恢复 ────────────────────────────────────────────
function makeBridgeWithBatches(batches) {
  const store = new Map(Object.entries(batches).map(([id, b]) => [id, JSON.parse(JSON.stringify(b))]));
  const batchRepository = {
    listBatchIds: () => [...store.keys()],
    hasBatch: (id) => store.has(id),
    loadBatch: (id) => { if (!store.has(id)) throw new Error('missing'); return store.get(id); },
    saveBatchAsync: async () => {},
    withBatchWrite: async (_id, run) => run(),
    batchSubdirs: () => ({}),
  };
  const svc = createCustomerBatchBridgeService({
    batchRepository,
    customerLibraryRepository: { customerDir: () => '', listCustomers: () => [] },
    batchGroupCodeImportService: { importFile: async () => ({}) },
  });
  return { svc, store };
}

test('B6 recoverInterruptedGroupCodeImports:parsing/awaiting_upload → failed 带人话原因;ready/failed/none 不动', async () => {
  const { svc, store } = makeBridgeWithBatches({
    b_parsing: { id: 'b_parsing', groupCodeImport: { status: 'parsing', sourceFile: 'a.xlsx' }, tasks: [] },
    b_await: { id: 'b_await', groupCodeImport: { status: 'awaiting_upload' }, tasks: [] },
    b_ready: { id: 'b_ready', groupCodeImport: { status: 'ready' }, tasks: [] },
    b_failed: { id: 'b_failed', groupCodeImport: { status: 'failed', error: '旧原因' }, tasks: [] },
    b_none: { id: 'b_none', tasks: [] },
  });
  const recovered = await svc.recoverInterruptedGroupCodeImports();
  assert.equal(recovered, 2, '恰好恢复 parsing + awaiting_upload 两个');
  assert.equal(store.get('b_parsing').groupCodeImport.status, 'failed');
  assert.match(store.get('b_parsing').groupCodeImport.error, /重启中断.*解析/);
  assert.equal(store.get('b_parsing').groupCodeImport.sourceFile, 'a.xlsx', '其余字段保留');
  assert.equal(store.get('b_await').groupCodeImport.status, 'failed');
  assert.match(store.get('b_await').groupCodeImport.error, /重启中断.*上传/);
  assert.equal(store.get('b_ready').groupCodeImport.status, 'ready', 'ready 不动');
  assert.equal(store.get('b_failed').groupCodeImport.error, '旧原因', '已 failed 不覆盖');
  assert.equal(store.get('b_none').groupCodeImport, undefined, '无表批次不动');
});

test('B6 竞态:锁内状态已被别人改 → 尊重不覆盖', async () => {
  const { svc, store } = makeBridgeWithBatches({
    b1: { id: 'b1', groupCodeImport: { status: 'parsing' }, tasks: [] },
  });
  // 模拟锁内重读时状态已变 ready(别的路径抢先完成)
  const origWithWrite = store.get('b1');
  origWithWrite.groupCodeImport.status = 'ready';
  const recovered = await svc.recoverInterruptedGroupCodeImports();
  assert.equal(recovered, 0, '锁内复查发现已 ready → 不动');
  assert.equal(store.get('b1').groupCodeImport.status, 'ready');
});

// ── B8 签字中断恢复 ──────────────────────────────────────────────
test('B8 recoverInterruptedSignatureJobs:queued/generating 复位 ""+留原因;done/failed/pending_name 不动', async () => {
  const batch = {
    id: 'b1',
    tasks: [
      { id: 't_q', signatureJobStatus: 'queued' },
      { id: 't_g', signatureJobStatus: 'generating' },
      { id: 't_done', signatureJobStatus: 'done' },
      { id: 't_failed', signatureJobStatus: 'failed', signatureJobError: '旧错' },
      { id: 't_pn', signatureJobStatus: 'pending_name' },
    ],
  };
  let saved = 0;
  const svc = createSignatureJobService({
    batchJsonPath: () => '', batchSubdirs: () => ({}), resolveBatchRelativePath: () => '',
    removeFileIfExists: () => {},
    loadBatch: () => batch,
    saveBatchAsync: async () => { saved += 1; },
    withBatchWrite: async (_id, run) => run(),
    resolveTask: (b, id) => b.tasks.find((t) => t.id === id),
    recalcTask: () => {},
    touchTask: () => {},
    isEligibleForWebsiteGeneration: () => true,
    ocrOwnedSignatureSources: new Set(),
    getSignatureSiteWorker: () => null,
  });
  const recovered = await svc.recoverInterruptedSignatureJobs({ listBatchIds: () => ['b1'] });
  assert.equal(recovered, 2, '恰好复位 queued + generating');
  assert.equal(saved, 1, '有复位才落盘一次');
  assert.equal(batch.tasks.find((t) => t.id === 't_q').signatureJobStatus, '');
  assert.equal(batch.tasks.find((t) => t.id === 't_g').signatureJobStatus, '');
  assert.match(batch.tasks.find((t) => t.id === 't_g').signatureJobError, /重启中断/);
  assert.equal(batch.tasks.find((t) => t.id === 't_done').signatureJobStatus, 'done', 'done 不动');
  assert.equal(batch.tasks.find((t) => t.id === 't_failed').signatureJobError, '旧错', 'failed 不覆盖');
  assert.equal(batch.tasks.find((t) => t.id === 't_pn').signatureJobStatus, 'pending_name', 'pending_name 派生态不动');
});

test('B8 无陈旧任务的批次:零写盘', async () => {
  let saved = 0;
  const svc = createSignatureJobService({
    batchJsonPath: () => '', batchSubdirs: () => ({}), resolveBatchRelativePath: () => '',
    removeFileIfExists: () => {},
    loadBatch: () => ({ id: 'b2', tasks: [{ id: 't1', signatureJobStatus: 'done' }] }),
    saveBatchAsync: async () => { saved += 1; },
    withBatchWrite: async () => { throw new Error('不应进锁'); },
    resolveTask: () => null, recalcTask: () => {}, touchTask: () => {},
    isEligibleForWebsiteGeneration: () => true, ocrOwnedSignatureSources: new Set(),
    getSignatureSiteWorker: () => null,
  });
  const recovered = await svc.recoverInterruptedSignatureJobs({ listBatchIds: () => ['b2'] });
  assert.equal(recovered, 0);
  assert.equal(saved, 0, '干净批次不进锁不落盘');
});
