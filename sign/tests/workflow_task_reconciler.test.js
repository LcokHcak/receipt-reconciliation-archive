'use strict';

// 2026-07-12 架构体检风险#1:workflow_task 不可丢却 advisory 写——reconciler 补建对账。
// 语义:漏建(全表态+域内零任务行)→ 补;有任何行(pending/done/cancelled)→ 不碰;
// 读模型滞后(批次真相说没全表态)→ 不补不缓存;豁免/无小票/批次已删 → 负缓存不再重查。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { createAgentWorkspaceRepository } = require('../repositories/agent_workspace_repository');
const { createWorkflowTaskRepository } = require('../repositories/workflow_task_repository');
const { createWorkflowTaskService } = require('../services/workflow_task_service');
const { createWorkflowTaskReconciler } = require('../services/workflow_task_reconciler');

const WS = '260712-rec';

function seedCustomerRow(agentRepo, { customerId, batchId, reviewStatus }) {
  agentRepo.upsertCustomerAnchor({
    customerPk: `${WS}::${customerId}`, calendarMonth: '2026-07', workspaceKey: WS, customerId,
    ownerUserId: 15, ownerUsername: 'u', agentKey: '永乐', agentName: '永乐', agentUnlabeled: false,
    customerName: customerId, activeBatchId: batchId, activeGroupKey: customerId,
    receivedAt: '2026-07-10T03:00:00.000Z', originalImageCount: 2, abnormalImageCount: 0,
  });
  agentRepo.upsertReviewOverlay({
    customerPk: `${WS}::${customerId}`, batchId, groupKey: customerId, monthlyWorkspaceKey: null,
    storeKeys: ['LOTTE'], candidateModes: [], confirmedModes: ['发17号'],
    reviewStatus, nextAction: 'review', reasonCodes: [], settlementStatus: '',
  });
}

function receiptTask(customerId, id, over = {}) {
  return {
    id, machineState: 'completed', docTypeFinal: 'receipt',
    sourceOriginalPath: `${WS}/${customerId}/${id}.jpg`, sourceGroupKey: customerId,
    customerAgentName: '永乐', tourStance: 'matched', modeRawPre: '发17号', groupNoFinal: '2600041',
    ...over,
  };
}

function setup(t, batches) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-reconcile-'));
  const db = new DatabaseSync(path.join(dir, 'wb.sqlite'));
  t.after(() => { try { db.close(); } catch { /* closed */ } });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const agentRepo = createAgentWorkspaceRepository({ db });
  const taskRepo = createWorkflowTaskRepository({ db });
  const service = createWorkflowTaskService({
    workflowTaskRepository: taskRepo,
    now: () => new Date('2026-07-12T04:00:00.000Z'),
  });
  const loads = [];
  const batchRepository = {
    hasBatch: (id) => Object.prototype.hasOwnProperty.call(batches, id),
    loadBatch: (id) => { loads.push(id); return JSON.parse(JSON.stringify(batches[id])); },
  };
  const reconciler = createWorkflowTaskReconciler({
    db, batchRepository, workflowTaskService: service, intervalMs: 0,
  });
  return { agentRepo, taskRepo, reconciler, loads };
}

test('漏建补齐:全表态+域内零任务 → 补 send_upstream;第二 tick 不重复', async (t) => {
  const batches = {
    b1: { id: 'b1', sourceGroups: [{ key: 'CL-A' }], tasks: [receiptTask('CL-A', 't1')] },
  };
  const { agentRepo, taskRepo, reconciler } = setup(t, batches);
  seedCustomerRow(agentRepo, { customerId: 'CL-A', batchId: 'b1', reviewStatus: 'review_pending' });

  const r1 = await reconciler.tick();
  assert.equal(r1.created, 1);
  const rows = taskRepo.list({ customerId: 'CL-A' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].subtype, 'send_17');
  assert.equal(rows[0].agentKey, '永乐');
  assert.equal(rows[0].createdBy, 'reconciler');

  const r2 = await reconciler.tick();
  assert.equal(r2.created, 0);
  assert.equal(taskRepo.list({ customerId: 'CL-A' }).length, 1); // LEFT JOIN 已排除
});

test('已有任务行(done/cancelled)不算漏建;tour_pending 不是候选', async (t) => {
  const batches = {
    b1: { id: 'b1', sourceGroups: [{ key: 'CL-B' }, { key: 'CL-C' }], tasks: [receiptTask('CL-B', 't1'), receiptTask('CL-C', 't2')] },
  };
  const { agentRepo, taskRepo, reconciler } = setup(t, batches);
  seedCustomerRow(agentRepo, { customerId: 'CL-B', batchId: 'b1', reviewStatus: 'passed' });
  seedCustomerRow(agentRepo, { customerId: 'CL-C', batchId: 'b1', reviewStatus: 'tour_pending' });

  // CL-B 已有 cancelled 行(经历过重开)→ 不补
  const made = taskRepo.createExpected({
    taskKey: 'k-b', calendarMonth: '2026-07', workspaceKey: WS, customerId: 'CL-B',
    batchId: 'b1', groupKey: 'CL-B', taskType: 'send_upstream', createdAt: '2026-07-11T00:00:00.000Z',
  }).task;
  taskRepo.cancel(made.id, { reason: 'x' });

  const r = await reconciler.tick();
  assert.equal(r.created, 0);
  assert.equal(taskRepo.list({ customerId: 'CL-B' }).length, 1); // 还是那条 cancelled
  assert.equal(taskRepo.list({ customerId: 'CL-C' }).length, 0); // tour_pending 不候选
});

test('读模型滞后:批次真相未全表态 → 不补不缓存;下次表态完成由协调器接手', async (t) => {
  const batches = {
    b1: { id: 'b1', sourceGroups: [{ key: 'CL-D' }], tasks: [receiptTask('CL-D', 't1', { tourStance: '' })] },
  };
  const { agentRepo, taskRepo, reconciler } = setup(t, batches);
  // 读模型错标了 review_pending(滞后),批次真相 t1 未表态
  seedCustomerRow(agentRepo, { customerId: 'CL-D', batchId: 'b1', reviewStatus: 'review_pending' });

  const r = await reconciler.tick();
  assert.equal(r.created, 0);
  assert.equal(r.staleReadModel, 1);
  assert.equal(taskRepo.list({}).length, 0);
});

test('豁免/无小票 → 负缓存,第二 tick 不再加载批次;批次已删同理', async (t) => {
  const batches = {
    b1: {
      id: 'b1',
      sourceGroups: [{ key: 'CL-E' }],
      tasks: [receiptTask('CL-E', 't1', { modeRawPre: '', groupNoFinal: '', receiptStoreFinal: 'LOTTE_DEPT', tourStance: '' })],
    },
  };
  const { agentRepo, reconciler, loads } = setup(t, batches);
  seedCustomerRow(agentRepo, { customerId: 'CL-E', batchId: 'b1', reviewStatus: 'review_pending' }); // 全豁免客户
  seedCustomerRow(agentRepo, { customerId: 'CL-F', batchId: 'b-gone', reviewStatus: 'passed' }); // 批次已删

  const r1 = await reconciler.tick();
  assert.equal(r1.created, 0);
  assert.equal(r1.skipped, 1);
  const loadsAfterFirst = loads.length;

  const r2 = await reconciler.tick();
  assert.equal(loads.length, loadsAfterFirst, '负缓存后不得再加载批次');
  assert.equal(r2.created, 0);
});

test('换批次:旧批次的负缓存不得挡住新批次的补建评估(复核 HIGH 回归)', async (t) => {
  const batches = {
    bOld: {
      id: 'bOld', sourceGroups: [{ key: 'CL-G' }],
      tasks: [receiptTask('CL-G', 't1', { modeRawPre: '', groupNoFinal: '', receiptStoreFinal: 'LOTTE_DEPT', tourStance: '' })], // 旧批次全豁免
    },
    bNew: {
      id: 'bNew', sourceGroups: [{ key: 'CL-G' }],
      tasks: [receiptTask('CL-G', 't2')], // 新批次是真小票且已表态
    },
  };
  const { agentRepo, taskRepo, reconciler } = setup(t, batches);

  seedCustomerRow(agentRepo, { customerId: 'CL-G', batchId: 'bOld', reviewStatus: 'review_pending' });
  const r1 = await reconciler.tick();
  assert.equal(r1.skipped, 1); // 豁免 → 负缓存(键含 bOld)

  // 客户挪到新批次(锚点+覆盖层都指 bNew)
  seedCustomerRow(agentRepo, { customerId: 'CL-G', batchId: 'bNew', reviewStatus: 'review_pending' });
  const r2 = await reconciler.tick();
  assert.equal(r2.created, 1, '旧批次的负缓存不得挡住新批次');
  assert.equal(taskRepo.list({ customerId: 'CL-G' })[0].batchId, 'bNew');
});

// ── 0801:负缓存必须在 LIMIT **之前**生效,否则永久候选会把真漏建的饿死 ──────────
//
// 病理:findCandidates 原来是 SQL LIMIT 200 → 回到 JS 再按负缓存过滤。
// 「无小票/全豁免」的客户**永远**满足 wt.id IS NULL(协调器根本不给他们建任务),
// 于是他们永久占住那 200 个名额:跑几轮后全进负缓存,每个 tick 都是
// 「取回 200 条 → 过滤剩 0 条 → 提前 return」,排在第 201 位、真正漏建的那个永远轮不到。
// 这张网本来就是给"任务永久缺失"兜底的,规模一到它自己先静默失效。
test('⭐饥饿回归:201 个"永远不需要任务"的客户在前,真漏建的那个仍要被补上', async (t) => {
  const NOISE = 201; // > MAX_CANDIDATES_PER_TICK(200)
  // 噪声客户:批次里只有护照、没有小票 → overlay.receiptCount=0 → 永久负缓存,且永远是 SQL 候选
  const noiseGroups = [];
  const noiseTasks = [];
  for (let i = 0; i < NOISE; i += 1) {
    const cid = `CL-NOISE-${String(i).padStart(4, '0')}`;
    noiseGroups.push({ key: cid });
    noiseTasks.push({
      id: `p${i}`, machineState: 'completed', docTypeFinal: 'passport',
      sourceOriginalPath: `${WS}/${cid}/p.jpg`, sourceGroupKey: cid, customerAgentName: '永乐',
    });
  }
  // 真漏建的那个:customer_pk 排在噪声之后(ORDER BY customer_pk,ZZZ 排最后)
  const REAL = 'CL-ZZZ-REAL';
  const batches = {
    b1: {
      id: 'b1',
      sourceGroups: [...noiseGroups, { key: REAL }],
      tasks: [...noiseTasks, receiptTask(REAL, 'tReal')],
    },
  };
  const { agentRepo, taskRepo, reconciler } = setup(t, batches);
  for (const g of noiseGroups) {
    seedCustomerRow(agentRepo, { customerId: g.key, batchId: 'b1', reviewStatus: 'review_pending' });
  }
  seedCustomerRow(agentRepo, { customerId: REAL, batchId: 'b1', reviewStatus: 'review_pending' });

  // 多跑几轮:让噪声客户全部沉进负缓存(每 tick 只加载有限批次,这里同批次一次就够)
  let created = 0;
  for (let i = 0; i < 5; i += 1) created += (await reconciler.tick()).created;

  assert.equal(created, 1, '真漏建的那个必须被补上(改动前:永远补不上,created 恒为 0)');
  const rows = taskRepo.list({ customerId: REAL });
  assert.equal(rows.length, 1, `${REAL} 应有 send_upstream 任务`);
  assert.equal(rows[0].createdBy, 'reconciler');
  // 噪声客户一个任务都不该建(他们本来就不需要)
  assert.equal(taskRepo.list({ customerId: 'CL-NOISE-0000' }).length, 0);
});

test('分页扫描要报出扫描量,撞到上界不静默', async (t) => {
  const batches = { b1: { id: 'b1', sourceGroups: [{ key: 'CL-S' }], tasks: [receiptTask('CL-S', 't1')] } };
  const { agentRepo, reconciler } = setup(t, batches);
  seedCustomerRow(agentRepo, { customerId: 'CL-S', batchId: 'b1', reviewStatus: 'review_pending' });
  const r = await reconciler.tick();
  assert.equal(typeof r.scanned, 'number', 'tick 结果要带扫描量,便于观测饥饿');
  assert.ok(r.scanned >= 1);
  assert.ok(!r.scanExhausted, '正常规模下不该撞上界');
});
