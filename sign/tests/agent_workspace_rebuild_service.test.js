'use strict';

// 代理工作台 V2 Task5:读模型全量重建 + parity。
// fixtures 覆盖:多 workspace / 跨 ws 重复 customerId / 缺 createdAt / 缺 batch /
// 多活动 batch(stale 拦截)/ orphan group / 墓碑 / 坏 JSON。
// 语义:dry-run 不写主库;apply 影子库原子切换;中断重跑幂等。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { createAgentWorkspaceRepository } = require('../repositories/agent_workspace_repository');
const { createAgentWorkspaceRebuildService } = require('../services/agent_workspace_rebuild_service');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function makeCustomer({ customerId, agentName = '永乐', createdAt = '2026-07-05T03:00:00.000Z', review, deletedAt }) {
  return {
    customerId,
    agentName,
    createdAt,
    images: [{ imageId: 'i1' }],
    ...(review ? { review } : {}),
    ...(deletedAt ? { deletedAt } : {}),
  };
}

function makeReceiptTask({ ws, customerId, id, tourStance = '', modeRawPre = 'LOTTE_A', groupKey = 'g1' }) {
  return {
    id,
    machineState: 'completed',
    docTypeFinal: 'receipt',
    sourceOriginalPath: `${ws}/${customerId}/originals/${id}.jpg`,
    sourceGroupKey: groupKey,
    tourStance,
    modeRawPre,
  };
}

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ws-rebuild-'));
  const libraryRoot = path.join(dir, 'customer_library');
  const batchesRoot = path.join(dir, 'batches');
  fs.mkdirSync(libraryRoot, { recursive: true });
  fs.mkdirSync(batchesRoot, { recursive: true });
  const dbPath = path.join(dir, 'workbench.sqlite');
  const db = new DatabaseSync(dbPath);
  t.after(() => { try { db.close(); } catch { /* closed */ } });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const service = createAgentWorkspaceRebuildService({ db, libraryRoot, batchesRoot });
  const shadowDbPath = path.join(dir, 'shadow.sqlite');
  return { dir, libraryRoot, batchesRoot, db, dbPath, service, shadowDbPath };
}

function seedFixtures({ libraryRoot, batchesRoot }) {
  // ws1:正常客户(活动批次 b-new)+ 缺 createdAt 客户 + 墓碑
  writeJson(path.join(libraryRoot, 'ws1', 'CL20260705-001', 'customer.json'), makeCustomer({
    customerId: 'CL20260705-001', review: { lastBatchId: 'b-new' },
  }));
  writeJson(path.join(libraryRoot, 'ws1', 'CL20260701-002', 'customer.json'), makeCustomer({
    customerId: 'CL20260701-002', createdAt: '', agentName: '贝拉',
  }));
  writeJson(path.join(libraryRoot, 'ws1', 'CL20260705-009', 'customer.json'), makeCustomer({
    customerId: 'CL20260705-009', deletedAt: '2026-07-06T00:00:00.000Z',
  }));
  // ws2:跨 workspace 重复 customerId(与 ws1 各一行)+ 无批次客户
  writeJson(path.join(libraryRoot, 'ws2', 'CL20260705-001', 'customer.json'), makeCustomer({
    customerId: 'CL20260705-001', agentName: '汉拿',
  }));
  writeJson(path.join(libraryRoot, 'ws2', 'CL20260705-003', 'customer.json'), makeCustomer({
    customerId: 'CL20260705-003', agentName: '汉拿',
  }));
  // 坏 JSON
  fs.mkdirSync(path.join(libraryRoot, 'ws2', 'CL-bad'), { recursive: true });
  fs.writeFileSync(path.join(libraryRoot, 'ws2', 'CL-bad', 'customer.json'), '{oops', 'utf8');

  // 批次:旧批次 b-old(应被活动批次守卫拦下)先写,新批次 b-new 后写(mtime 升序)
  writeJson(path.join(batchesRoot, 'b-old', 'batch.json'), {
    id: 'b-old',
    sourceGroups: [{ key: 'g1' }],
    tasks: [makeReceiptTask({ ws: 'ws1', customerId: 'CL20260705-001', id: 't-old', modeRawPre: 'OLD' })],
  });
  writeJson(path.join(batchesRoot, 'b-new', 'batch.json'), {
    id: 'b-new',
    sourceGroups: [{ key: 'g1' }],
    tasks: [
      makeReceiptTask({ ws: 'ws1', customerId: 'CL20260705-001', id: 't1' }),
      // orphan group:指向不存在的客户
      makeReceiptTask({ ws: 'ws-ghost', customerId: 'CL-nobody', id: 't2' }),
    ],
  });
}

test('dry-run:全量重建报告正确,不写主库(表都不建)', (t) => {
  const ctx = setup(t);
  seedFixtures(ctx);

  const report = ctx.service.rebuild({ apply: false, shadowDbPath: ctx.shadowDbPath });

  assert.equal(report.mode, 'dry-run');
  assert.equal(report.fsCustomerFiles, 6); // 5 有效 + 1 坏 JSON(墓碑也算文件)
  assert.equal(report.tombstones, 1);
  assert.equal(report.rebuiltTotal, 4); // 001×2ws + 002 + 003(墓碑/坏JSON不进)
  assert.equal(report.batchesScanned, 2);
  // 覆盖层:b-old 对 001 是陈旧批次 → stale;b-new 盖上 → projected;ghost → orphan
  assert.equal(report.overlay.stale, 1);
  assert.equal(report.overlay.orphans, 1);
  assert.ok(report.overlay.projected >= 1);
  // 警告:坏 JSON + 缺 createdAt(CL 兜底)
  assert.equal(report.warnings.bad_customer_json, 1);
  assert.ok(report.warnings.created_at_missing >= 1);
  // 缺 createdAt 的客户从 customerId 回推月份
  assert.equal(report.rebuiltByMonth['2026-07'], 4);
  // 状态分布:001@ws1 有未表态票 → tour_pending;其余无批次 → ready_for_sync
  assert.equal(report.statusDistribution.tour_pending, 1);
  assert.equal(report.statusDistribution.ready_for_sync, 3);
  // 主库未被碰:读模型表不存在
  const row = ctx.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_workspace_customer'").get();
  assert.equal(row, undefined);
  assert.equal(report.parity.liveTableMissing, true);
  // 影子库文件已清理
  assert.equal(fs.existsSync(ctx.shadowDbPath), false);
});

test('apply:影子库原子切换进主库;重跑幂等;增量投影漂移被纠正', (t) => {
  const ctx = setup(t);
  seedFixtures(ctx);

  // 先造一个"漂移"的主库投影(模拟增量钩子出过错:少一行+代理错)
  const mainRepo = createAgentWorkspaceRepository({ db: ctx.db });
  mainRepo.upsertCustomerAnchor({
    customerPk: 'ws1::CL20260705-001', calendarMonth: '2026-07', workspaceKey: 'ws1',
    customerId: 'CL20260705-001', agentKey: '错代理', agentName: '错代理', agentUnlabeled: false,
    customerName: '', activeBatchId: '', activeGroupKey: '', receivedAt: '2026-07-05T03:00:00.000Z',
    originalImageCount: 0, abnormalImageCount: 0, ownerUserId: null, ownerUsername: null,
  });

  // dry-run 能看出 parity 不一致(主库 1 行 vs 重建 4 行)
  const dry = ctx.service.rebuild({ apply: false, shadowDbPath: ctx.shadowDbPath });
  assert.equal(dry.parity.liveTotal, 1);
  assert.equal(dry.parity.mismatches.length, 1);
  assert.equal(dry.parity.mismatches[0].delta, 3);

  // apply 切换
  const applied = ctx.service.rebuild({ apply: true, shadowDbPath: ctx.shadowDbPath });
  assert.equal(applied.applied, true);
  assert.equal(applied.appliedRows, 4);

  // 主库内容被纠正:代理名来自 customer.json,而非漂移值
  const fixedRow = mainRepo.getCustomer('ws1::CL20260705-001');
  assert.equal(fixedRow.agentName, '永乐');
  assert.equal(fixedRow.reviewStatus, 'tour_pending');
  assert.equal(fixedRow.batchId, 'b-new'); // 活动批次守卫:b-old 没盖上
  assert.deepEqual(fixedRow.candidateModes, ['LOTTE_A']);
  // 跨 ws 重复 customerId 各自一行
  assert.ok(mainRepo.getCustomer('ws2::CL20260705-001'));
  assert.equal(mainRepo.getCustomer('ws2::CL20260705-001').agentName, '汉拿');
  // 墓碑不进
  assert.equal(mainRepo.getCustomer('ws1::CL20260705-009'), null);

  // 重跑幂等:再 apply 一次,行数不变,parity 一致
  const again = ctx.service.rebuild({ apply: true, shadowDbPath: ctx.shadowDbPath });
  assert.equal(again.appliedRows, 4);
  assert.equal(again.parity.mismatches.length, 0);
  assert.equal(again.parity.liveTotal, 4);
});

test('apply 失败(影子库 schema 不一致)不破坏主库旧投影', (t) => {
  const ctx = setup(t);
  seedFixtures(ctx);
  const mainRepo = createAgentWorkspaceRepository({ db: ctx.db });
  mainRepo.upsertCustomerAnchor({
    customerPk: 'ws1::keep', calendarMonth: '2026-07', workspaceKey: 'ws1', customerId: 'keep',
    agentKey: 'k', agentName: 'k', agentUnlabeled: false, customerName: '',
    activeBatchId: '', activeGroupKey: '', receivedAt: '2026-07-01T00:00:00.000Z',
    originalImageCount: 0, abnormalImageCount: 0, ownerUserId: null, ownerUsername: null,
  });

  // 给主库表加一列制造 schema 漂移 → swap 必须中止且回滚
  ctx.db.exec('ALTER TABLE agent_workspace_customer ADD COLUMN extra_col TEXT');
  assert.throws(
    () => ctx.service.rebuild({ apply: true, shadowDbPath: ctx.shadowDbPath }),
    /schema mismatch/
  );
  // 旧投影仍在
  assert.ok(mainRepo.getCustomer('ws1::keep'));
  // 失败路径也不遗留影子文件(finally 清理)
  assert.equal(fs.existsSync(ctx.shadowDbPath), false);
});

test('代理/owner/月分布进报告;fsCustomersByMonth 与重建行月分布一致', (t) => {
  const ctx = setup(t);
  seedFixtures(ctx);
  const report = ctx.service.rebuild({ apply: false, shadowDbPath: ctx.shadowDbPath });
  assert.equal(report.agentDistribution['永乐'], 1);
  assert.equal(report.agentDistribution['汉拿'], 2);
  assert.equal(report.agentDistribution['贝拉'], 1);
  assert.deepEqual(report.fsCustomersByMonth, { '2026-07': 4 });
  assert.ok(report.ownerDistribution['(无owner)'] >= 1);
  assert.ok(report.elapsedMs >= 0);
});
