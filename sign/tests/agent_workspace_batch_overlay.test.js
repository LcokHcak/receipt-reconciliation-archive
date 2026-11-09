'use strict';

// 代理工作台 V2 Task4:批次同步 → 客户级审核覆盖层投影。
// 口径(票级两步流修订):tour_pending=组内存在未表态小票;候选/确认模式分开;
// 活动批次守卫=customer.review.lastBatchId(旧批次禁止覆盖新批次的行);
// 找不到客户行=orphan 只记日志不建行;批次删除→覆盖层回 ready_for_sync,客户行保留。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createWorkbenchSqliteRepository } = require('../repositories/workbench_sqlite_repository');
const { createAgentWorkspaceRepository } = require('../repositories/agent_workspace_repository');
const { createWorkbenchSqliteSyncService } = require('../services/workbench_sqlite_sync_service');
const { buildCustomerAnchor } = require('../lib/agent_workspace/customer_projection');
const { refreshChangedBatches } = require('../lib/agent_workspace/projection_refresh');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ws-overlay-'));
  const wsRepo = createWorkbenchSqliteRepository({ dbPath: path.join(dir, 'wb.sqlite') });
  const agentRepo = createAgentWorkspaceRepository({ db: wsRepo.db });
  const logs = [];
  // 与 lib/request_logger 同签名:(msg, fields)
  const logger = {
    warn(msg, fields = {}) { logs.push({ level: 'warn', event: msg, ...fields }); },
    info(msg, fields = {}) { logs.push({ level: 'info', event: msg, ...fields }); },
  };
  const sync = createWorkbenchSqliteSyncService({
    sqliteRepository: wsRepo,
    agentWorkspaceRepository: agentRepo,
    projectionLogger: logger,
  });
  t.after(() => wsRepo.close());
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return { agentRepo, sync, logs };
}

function seedCustomer(agentRepo, { workspaceKey, customerId, agentName = '永乐', activeBatchId = '' }) {
  const anchor = buildCustomerAnchor({
    customer: {
      customerId,
      agentName,
      createdAt: '2026-07-10T03:00:00.000Z',
      images: [{ imageId: 'a' }],
      review: activeBatchId ? { lastBatchId: activeBatchId } : undefined,
    },
    workspaceKey,
  });
  agentRepo.upsertCustomerAnchor(anchor);
  return anchor.customerPk;
}

function makeTask(overrides = {}) {
  return {
    id: overrides.id || 't1',
    machineState: 'completed',
    docTypeFinal: 'receipt',
    sourceOriginalPath: '260710-小票22/CL20260710-001/originals/a.jpg',
    sourceGroupKey: 'g1',
    ...overrides,
  };
}

function makeBatch({ id = 'batch-1', tasks = [], sourceGroups = [] } = {}) {
  return {
    id,
    name: id,
    createdAt: '2026-07-10T04:00:00.000Z',
    sourceGroups,
    tasks,
  };
}

test('批次同步投影覆盖层:未表态小票→tour_pending+候选模式;matched票→确认模式;店名去重', (t) => {
  const { agentRepo, sync } = setup(t);
  const pk = seedCustomer(agentRepo, {
    workspaceKey: '260710-小票22', customerId: 'CL20260710-001', activeBatchId: 'batch-1',
  });

  const batch = makeBatch({
    id: 'batch-1',
    sourceGroups: [{ key: 'g1', folderPath: 'g1', label: '组1' }],
    tasks: [
      makeTask({ id: 't1', groupNoFinal: '2600041', tourStance: '', modeRawPre: 'LOTTE_A' }),
      makeTask({ id: 't2', groupNoFinal: '2600041', tourStance: 'matched', modeRawPre: 'LOTTE_A', modeManualPick: 'LOTTE_S', receiptStoreFinal: 'LOTTE' }),
      makeTask({ id: 't3', docTypeFinal: 'passport' }),
    ],
  });
  sync.syncBatch(batch);

  const row = agentRepo.getCustomer(pk);
  assert.ok(row);
  assert.equal(row.batchId, 'batch-1');
  assert.equal(row.groupKey, 'g1');
  assert.equal(row.reviewStatus, 'tour_pending'); // t1 未表态
  assert.equal(row.nextAction, 'confirm_tour');
  assert.deepEqual(row.candidateModes, ['LOTTE_A']); // 未表态票的 modeRawPre
  assert.deepEqual(row.confirmedModes, ['LOTTE_S']); // matched 票 manualPick 优先
  assert.deepEqual(row.storeKeys, ['LOTTE']);
  // 禁止用客户库 workspaceKey 冒充台账自然月工作簿(未桥接=NULL)
  assert.equal(row.monthlyWorkspaceKey, null);
});

test('活动批次守卫:旧批次同步不得覆盖新批次盖上的行(stale),新批次可以', (t) => {
  const { agentRepo, sync, logs } = setup(t);
  const pk = seedCustomer(agentRepo, {
    workspaceKey: '260710-小票22', customerId: 'CL20260710-001', activeBatchId: 'batch-new',
  });

  // 旧批次(不是 customer.review.lastBatchId 指向的)同步 → 行保持原样
  sync.syncBatch(makeBatch({
    id: 'batch-old',
    tasks: [makeTask({ id: 't1', tourStance: '', modeRawPre: 'OLD_MODE' })],
  }));
  let row = agentRepo.getCustomer(pk);
  assert.equal(row.batchId, null); // 未被旧批次盖上(裸锚点缺省)
  assert.deepEqual(row.candidateModes, []);
  assert.ok(logs.some((l) => l.event === 'agent_workspace_overlay_summary' && l.stale === 1));

  // 活动批次同步 → 正常盖上
  sync.syncBatch(makeBatch({
    id: 'batch-new',
    tasks: [makeTask({ id: 't1', tourStance: '', modeRawPre: 'NEW_MODE' })],
  }));
  row = agentRepo.getCustomer(pk);
  assert.equal(row.batchId, 'batch-new');
  assert.deepEqual(row.candidateModes, ['NEW_MODE']);
});

test('找不到客户行=orphan:不建行、只记日志、不阻断批次主同步', (t) => {
  const { agentRepo, sync, logs } = setup(t);
  const batch = makeBatch({
    id: 'batch-x',
    tasks: [makeTask({ sourceOriginalPath: 'ws-x/CL-nobody/originals/a.jpg' })],
  });
  const projection = sync.syncBatch(batch); // 不抛
  assert.ok(projection);
  assert.equal(agentRepo.getCustomer('ws-x::CL-nobody'), null);
  assert.ok(logs.some((l) => l.event === 'agent_workspace_overlay_summary' && l.orphans === 1));
});

test('组内全部表态+审核完但未结算 → needs_confirm + awaiting_settlement;结算后 → passed', (t) => {
  const { agentRepo, sync } = setup(t);
  const pk = seedCustomer(agentRepo, {
    workspaceKey: '260710-小票22', customerId: 'CL20260710-001', activeBatchId: 'batch-1',
  });

  const doneTasks = [
    makeTask({ id: 't1', tourStance: 'matched', modeRawPre: 'LOTTE_A', reviewed: true, processResult: 'approved' }),
    makeTask({ id: 't2', docTypeFinal: 'passport', reviewed: true, processResult: 'approved' }),
  ];
  sync.syncBatch(makeBatch({ id: 'batch-1', sourceGroups: [{ key: 'g1', folderPath: 'g1' }], tasks: doneTasks }));
  let row = agentRepo.getCustomer(pk);
  assert.equal(row.reviewStatus, 'needs_confirm');
  assert.ok(row.reasonCodes.includes('awaiting_settlement'));

  sync.syncBatch(makeBatch({
    id: 'batch-1',
    sourceGroups: [{ key: 'g1', folderPath: 'g1', settlementStatus: 'settled', settledAt: '2026-07-10T05:00:00.000Z' }],
    tasks: doneTasks,
  }));
  row = agentRepo.getCustomer(pk);
  assert.equal(row.reviewStatus, 'passed');
  assert.equal(row.settlementStatus, 'settled');
});

test('幂等:同一批次重复 syncBatch 10 次,行数不增、覆盖层内容稳定', (t) => {
  const { agentRepo, sync } = setup(t);
  const pk = seedCustomer(agentRepo, {
    workspaceKey: '260710-小票22', customerId: 'CL20260710-001', activeBatchId: 'batch-1',
  });
  const batch = makeBatch({
    id: 'batch-1',
    sourceGroups: [{ key: 'g1', folderPath: 'g1' }],
    tasks: [makeTask({ id: 't1', tourStance: '', modeRawPre: 'LOTTE_A' })],
  });
  for (let i = 0; i < 10; i += 1) sync.syncBatch(batch);
  const { rows } = agentRepo.listCustomers({ month: '2026-07' }); // 查询强制带自然月作用域
  assert.equal(rows.length, 1);
  const row = agentRepo.getCustomer(pk);
  assert.equal(row.reviewStatus, 'tour_pending');
  assert.deepEqual(row.candidateModes, ['LOTTE_A']);
});

test('removeBatch:覆盖层回 ready_for_sync,客户行保留(锚点不丢)', (t) => {
  const { agentRepo, sync } = setup(t);
  const pk = seedCustomer(agentRepo, {
    workspaceKey: '260710-小票22', customerId: 'CL20260710-001', activeBatchId: 'batch-1',
  });
  sync.syncBatch(makeBatch({
    id: 'batch-1',
    sourceGroups: [{ key: 'g1', folderPath: 'g1' }],
    tasks: [makeTask({ id: 't1', tourStance: '', modeRawPre: 'LOTTE_A' })],
  }));
  assert.equal(agentRepo.getCustomer(pk).reviewStatus, 'tour_pending');

  sync.removeBatch('batch-1');
  const row = agentRepo.getCustomer(pk);
  assert.ok(row); // 客户仍在
  assert.equal(row.batchId, null);
  assert.equal(row.reviewStatus, 'ready_for_sync');
  assert.equal(row.agentName, '永乐'); // 锚点列未被清
  assert.deepEqual(row.candidateModes, []);
  // 活动批次守卫必须一并清空,否则守卫永远指向已删除批次,后续批次全被误判 stale(死锁)
  assert.equal(row.activeBatchId, '');
  sync.syncBatch(makeBatch({
    id: 'batch-2',
    tasks: [makeTask({ id: 't9', tourStance: '', modeRawPre: 'NEXT_MODE' })],
  }));
  assert.equal(agentRepo.getCustomer(pk).batchId, 'batch-2'); // 新批次能盖上
});

test('removeBatch:已结算客户不回退,只解除批次关联(状态/模式/店名保留)', (t) => {
  const { agentRepo, sync } = setup(t);
  const pk = seedCustomer(agentRepo, {
    workspaceKey: '260710-小票22', customerId: 'CL20260710-001', activeBatchId: 'batch-1',
  });
  const doneTasks = [
    makeTask({ id: 't1', tourStance: 'matched', modeRawPre: 'LOTTE_A', reviewed: true, processResult: 'approved', receiptStoreFinal: 'LOTTE' }),
  ];
  sync.syncBatch(makeBatch({
    id: 'batch-1',
    sourceGroups: [{ key: 'g1', folderPath: 'g1', settlementStatus: 'settled', settledAt: '2026-07-10T05:00:00.000Z' }],
    tasks: doneTasks,
  }));
  assert.equal(agentRepo.getCustomer(pk).reviewStatus, 'passed');

  sync.removeBatch('batch-1'); // 批次归档/清理
  const row = agentRepo.getCustomer(pk);
  assert.equal(row.reviewStatus, 'passed'); // 不回退
  assert.equal(row.settlementStatus, 'settled');
  assert.deepEqual(row.confirmedModes, ['LOTTE_A']); // 历史事实保留
  assert.deepEqual(row.storeKeys, ['LOTTE']);
  assert.equal(row.batchId, null); // 只解除批次关联
  assert.equal(row.activeBatchId, '');
});

test('未装配 agentWorkspaceRepository 时 syncBatch 行为不变(向后兼容)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ws-overlay-compat-'));
  const wsRepo = createWorkbenchSqliteRepository({ dbPath: path.join(dir, 'wb.sqlite') });
  t.after(() => wsRepo.close());
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const sync = createWorkbenchSqliteSyncService({ sqliteRepository: wsRepo });
  const projection = sync.syncBatch(makeBatch({ id: 'b1', tasks: [makeTask()] }));
  assert.ok(projection.batch);
});

// 止血(2026-07-24):投影只在启动/删批/手动 rebuild 时更新,审核动作本身不刷 → 数字冻在旧状态。
// 应用内增量刷新:改动过的批次经 refreshChangedBatches→真实 syncBatches 重新覆盖,状态跟上审核。
test('止血:审核改动批次后,增量刷新把投影状态刷新(不再冻在旧状态)', (t) => {
  const { agentRepo, sync } = setup(t);
  const pk = seedCustomer(agentRepo, {
    workspaceKey: '260710-小票22', customerId: 'CL20260710-001', activeBatchId: 'batch-1',
  });
  // 初次同步:有未表态小票 → tour_pending
  sync.syncBatch(makeBatch({
    id: 'batch-1',
    sourceGroups: [{ key: 'g1', folderPath: 'g1', label: '组1' }],
    tasks: [makeTask({ id: 't1', groupNoFinal: '2600041', tourStance: '', modeRawPre: 'LOTTE_A' })],
  }));
  assert.equal(agentRepo.getCustomer(pk).reviewStatus, 'tour_pending', '审核前:待表态(投影冻在此)');

  // 操作员审核后批次变了(小票已表态);审核动作本身不刷投影,此刻投影仍是旧状态。
  const after = makeBatch({
    id: 'batch-1',
    sourceGroups: [{ key: 'g1', folderPath: 'g1', label: '组1' }],
    tasks: [makeTask({ id: 't1', groupNoFinal: '2600041', tourStance: 'matched', modeRawPre: 'LOTTE_A', receiptStoreFinal: 'LOTTE' })],
  });
  // 增量刷新:refreshChangedBatches 走真实 sync.syncBatches 重新覆盖该批次
  const res = refreshChangedBatches({
    changedBatchIds: ['batch-1'],
    loadBatch: (id) => (id === 'batch-1' ? after : null),
    syncBatches: sync.syncBatches,
  });
  assert.equal(res.synced, 1, '改动批次被重新同步一次');
  assert.notEqual(agentRepo.getCustomer(pk).reviewStatus, 'tour_pending', '刷新后:状态跟上审核,不再冻在 tour_pending');
});

// P3 真票数(2026-07-24):overlay 已算的 receiptCount 落投影 receipt_count,summary/listAgents 聚合。
test('P3 真票数:overlay 填 receipt_count → summary receiptsByStatus/totalReceipts + 代理列 receiptCount', (t) => {
  const { agentRepo, sync } = setup(t);
  const pk = seedCustomer(agentRepo, { workspaceKey: '260710-小票22', customerId: 'CL20260710-001', activeBatchId: 'batch-1' });
  // 客户组:3 张小票(t2/t3 未表态→tour_pending)+ 1 护照 → receipt_count=3(护照不计)
  sync.syncBatch(makeBatch({
    id: 'batch-1',
    sourceGroups: [{ key: 'g1', folderPath: 'g1' }],
    tasks: [
      makeTask({ id: 't1', docTypeFinal: 'receipt', tourStance: 'matched', modeRawPre: 'LOTTE_A' }),
      makeTask({ id: 't2', docTypeFinal: 'receipt' }),
      makeTask({ id: 't3', docTypeFinal: 'receipt' }),
      makeTask({ id: 't4', docTypeFinal: 'passport' }),
    ],
  }));
  assert.equal(agentRepo.getCustomer(pk).receiptCount, 3, '护照不计,3 张小票');
  const sum = agentRepo.summary({ month: '2026-07' });
  assert.equal(sum.totalCustomers, 1);
  assert.equal(sum.totalReceipts, 3);
  const status = agentRepo.getCustomer(pk).reviewStatus;
  assert.equal(sum.receiptsByStatus[status], 3, '票数归其状态桶');
  // 互斥和:各态票数之和 = 总票数
  assert.equal(Object.values(sum.receiptsByStatus).reduce((a, b) => a + b, 0), sum.totalReceipts);
  // 代理列 receiptCount 聚合
  const agent = agentRepo.listAgents({ month: '2026-07' }).rows.find((a) => a.agentKey === '永乐');
  assert.equal(agent.receiptCount, 3);
});
