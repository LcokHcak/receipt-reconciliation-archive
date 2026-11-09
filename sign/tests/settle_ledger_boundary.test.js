'use strict';

/**
 * settle_ledger_boundary — 域1(结算+台账桥)边界补测(docs/边界测试设计.md · 域1 高优先缺口)。
 *
 *   1. 跨月重结算 clean/restore:sync 失败后按各自原 workspaceKey 补插回滚(丢行风险最高)
 *   2. restore 部分失败:一 ws throw 一 ws 成功 → 部分 restored + logger 留痕 + 不上抛
 *   3. precheckPurchaseDates 非抛出契约(真函数):越界→{ok:false}不 throw / 空日期→{ok:true} /
 *      resolver 非日期错→原样 throw 不吞
 *   4. 护照-only 组端到端:no_receipt_tasks → ok:true + settlementStatus 'no_receipts'
 *   5. confirmGroupModes 跨多 workspace 累加(逐月循环不被单 ws mock 掩盖)
 *   6. insertMany 事务原子性(真 SQLite):中途抛 → 整批 ROLLBACK + 异常上抛
 *   7. updateTourMatch × F6 手动锁(真 SQLite):锁住 tour_match_status 的行增量匹配不覆盖
 *
 * mock 手法对齐 tests/workbench_approve_settle_service.test.js(makeDeps/makeRepo);
 * 真 SQLite 手法对齐 tests/daily_receipt_restore_roundtrip.test.js(mkdtemp + t.after 清理)。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createWorkbenchApproveSettleService } = require('../services/workbench_approve_settle_service');
const { createWorkbenchLedgerBridgeService } = require('../services/workbench_ledger_bridge_service');
const { openMonthlyDatabase } = require('../lib/storage/monthly_database');
const { createDailyReceiptRepository } = require('../repositories/daily_receipt_repository');

const SILENT = { error() {}, log() {} };

const BATCH = {
  id: 'batch_x',
  monthlyWorkspaceKey: '2026-07',
  tasks: [
    { id: 'task_0000', sourceGroupKey: 'g1', docTypeFinal: 'passport' },
    { id: 'task_0001', sourceGroupKey: 'g1', docTypeFinal: 'receipt' },
    { id: 'task_0002', sourceGroupKey: 'g1', docTypeFinal: 'receipt' },
  ],
};

// ── 跨月 mock repo:两个 workspace 各有 1 行可删的旧未匹配行(设计文档缺口[高]#1)──
function makeCrossMonthRepo() {
  const FULL = {
    601: {
      id: 601, workspaceKey: '2026-06', receiptNo: 'R-JUN', shop: '乐天免税店',
      purchaseDate: '2026-06-28', billMatchStatus: 'unmatched', tourMatchStatus: 'matched',
      rowHash: 'h-jun', sourceType: 'workbench',
    },
    701: {
      id: 701, workspaceKey: '2026-07', receiptNo: 'R-JUL', shop: '乐天免税店',
      purchaseDate: '2026-07-03', billMatchStatus: 'unmatched', tourMatchStatus: 'matched',
      rowHash: 'h-jul', sourceType: 'workbench',
    },
  };
  const insertCalls = [];
  const deleteCalls = [];
  const repo = {
    listWorkspaceKeysForSourceGroup: () => ['2026-06', '2026-07'],
    listBySourceGroup: ({ workspaceKey }) => (workspaceKey === '2026-06'
      ? [{ id: 601, billMatchStatus: 'unmatched', manualLockedFields: null }]
      : [{ id: 701, billMatchStatus: 'unmatched', manualLockedFields: null }]),
    // ws 不匹配返回 null:若服务用错 workspaceKey 取快照,restored 计数会掉,测试自然红
    _fetchFullById: ({ workspaceKey, id }) => {
      const row = FULL[id];
      return row && row.workspaceKey === workspaceKey ? { ...row } : null;
    },
    deleteMany: ({ workspaceKey, ids }) => { deleteCalls.push({ workspaceKey, ids }); return ids.length; },
    insertMany: (rows) => { insertCalls.push(rows.map((r) => ({ ...r }))); return { inserted: rows.length }; },
  };
  return { repo, insertCalls, deleteCalls };
}

function buildSettleService({ repo, bridge, logger = SILENT, tourCalls = [] }) {
  return createWorkbenchApproveSettleService({
    groupApprovalService: { approveGroup: async () => ({ approvedTaskIds: ['task_0001', 'task_0002'] }) },
    ledgerBridgeService: bridge,
    tourMatchService: { run: async ({ workspaceKey }) => { tourCalls.push(workspaceKey); return {}; } },
    dailyReceiptRepo: repo,
    logger,
  });
}

// 1. 跨月重结算(L180):service 逐 ws 算出各自的待删旧未匹配行,交桥接与写台账原子执行;
//    桥接抛错=整事务回滚(旧行不丢),service 不再自行删/补插——真事务回滚见 #8/#9 repo 级直测。
test('跨月重结算:service 逐 ws 算出待删旧行交桥接;桥接抛错→结构化失败,不自行回滚', async () => {
  const { repo, insertCalls, deleteCalls } = makeCrossMonthRepo();
  const tourCalls = [];
  let capturedDeletes = null;
  const svc = buildSettleService({
    repo,
    bridge: {
      syncApprovedGroup: async ({ deleteIdsByWorkspace }) => {
        capturedDeletes = deleteIdsByWorkspace;
        throw new Error('磁盘写入失败');
      },
    },
    tourCalls,
  });

  const out = await svc.approveAndSettleGroup({ batch: BATCH, groupKey: 'g1', operator: 'u1' });

  assert.equal(out.ok, false);
  assert.equal(out.stage, 'ledger');
  assert.match(String(out.error), /磁盘写入失败/);
  assert.deepEqual(out.approvedTaskIds, ['task_0001', 'task_0002'], 'approve 已发生的事实透传');
  // 待删行按 ws 分组,各算各的 id(跨月两个月各一行)交桥接原子处理
  assert.deepEqual(capturedDeletes, [
    { workspaceKey: '2026-06', ids: [601] },
    { workspaceKey: '2026-07', ids: [701] },
  ], '逐 ws 算出待删 id,交桥接原子处理');
  assert.equal(out.restoredOldRows, undefined, 'L180:不再有 service 端补插回滚字段');
  assert.deepEqual(deleteCalls, [], 'service 不再自行 deleteMany(删在桥接原子事务内)');
  assert.deepEqual(insertCalls, [], 'service 不再自行 insertMany 补插');
  assert.deepEqual(tourCalls, [], '桥接失败不跑 tour_match');
});

// 2. 跨月重结算:桥接返回 {error}(非抛出)→ 同样结构化失败,不自行删/补插(两个失败入口都覆盖)。
test('跨月重结算:桥接返回 {error} → 结构化失败,不自行回滚', async () => {
  const { repo, insertCalls, deleteCalls } = makeCrossMonthRepo();
  const tourCalls = [];
  let capturedDeletes = null;
  const svc = buildSettleService({
    repo,
    bridge: {
      syncApprovedGroup: async ({ deleteIdsByWorkspace }) => {
        capturedDeletes = deleteIdsByWorkspace;
        return { error: 'ensureWorkspace failed', inserted: 0, removed: 0, affectedWorkspaces: ['2026-06', '2026-07'] };
      },
    },
    tourCalls,
  });

  const out = await svc.approveAndSettleGroup({ batch: BATCH, groupKey: 'g1', operator: 'u1' });

  assert.equal(out.ok, false);
  assert.equal(out.stage, 'ledger');
  assert.match(String(out.error), /ensureWorkspace failed/);
  assert.deepEqual(capturedDeletes, [
    { workspaceKey: '2026-06', ids: [601] },
    { workspaceKey: '2026-07', ids: [701] },
  ], '逐 ws 待删 id 仍如实交桥接');
  assert.equal(out.restoredOldRows, undefined, 'L180:无补插回滚字段');
  assert.deepEqual(deleteCalls, [], 'service 不自行删');
  assert.deepEqual(insertCalls, [], 'service 不自行补插');
  assert.deepEqual(tourCalls, [], '桥接失败不跑 tour_match');
});

// ── 3. precheckPurchaseDates 非抛出契约(真函数,不 mock;设计文档缺口[高]#2)──
function buildRealBridge() {
  return createWorkbenchLedgerBridgeService({
    dailyReceiptRepo: { insertMany: () => ({ inserted: 0, skipped: 0 }) },
    logger: SILENT,
  });
}

test('precheck①:购买日期越界 → {ok:false,code,details.taskId} 且不 throw,首个越界短路', () => {
  const svc = buildRealBridge();
  // 同步调用正常返回本身就证明"不 throw";护照任务日期再离谱也不参与预检
  const res = svc.precheckPurchaseDates({
    groupTasks: [
      { id: 'task_pp', docTypeFinal: 'passport', purchaseDateFinal: '2030-01-01' },
      { id: 'task_bad1', docTypeFinal: 'receipt', purchaseDateFinal: '2030-01-01', sourceGroupKey: 'g1', sourceGroupLabel: '张三', fileName: 'r1.jpg' },
      { id: 'task_bad2', docTypeFinal: 'receipt', purchaseDateFinal: '2031-02-02' },
    ],
    workspaceKey: '2026-07',
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'purchase_date_out_of_range');
  assert.ok(res.details, '必须带结构化定位信息');
  assert.equal(res.details.taskId, 'task_bad1', '首个越界的小票短路返回(护照被过滤,task_bad2 不抢位)');
  assert.equal(res.details.reason, 'purchase_date_out_of_range');
  assert.equal(res.details.purchaseDate, '2030-01-01');
  assert.match(String(res.error), /task_bad1/, '人读文本可定位任务');
  assert.match(String(res.error), /2030-01-01/);
});

test('precheck②:空购买日期 → {ok:true}(不拦,留给 sync 落 date_missing)', () => {
  const res = buildRealBridge().precheckPurchaseDates({
    groupTasks: [
      { id: 'task_nd1', docTypeFinal: 'receipt', purchaseDateFinal: '', purchaseDateAuto: '' },
      { id: 'task_nd2', docTypeFinal: 'receipt', purchaseDateFinal: '', purchaseDateAuto: '   ' },
    ],
    workspaceKey: '2026-07',
  });
  assert.deepEqual(res, { ok: true });
});

test('precheck③:resolver 抛非日期错 → 原样 throw 不吞(不误贴"核对日期")', () => {
  // 构造触发:workspaceKey 传毒化对象,resolveTargetWorkspace→normalizeWorkspaceKey 的
  // String() 即抛非日期错——真函数路径,验证 wrapPurchaseDateError 的非日期分支原样透传。
  const poisoned = { toString() { throw new Error('workspace resolver 故障'); } };
  assert.throws(
    () => buildRealBridge().precheckPurchaseDates({
      groupTasks: [{ id: 'task_ok', docTypeFinal: 'receipt', purchaseDateFinal: '2026-07-10' }],
      workspaceKey: poisoned,
    }),
    (err) => err instanceof Error
      && /workspace resolver 故障/.test(err.message)
      && err.code === undefined, // 不许被包装成日期类 BadRequestError
    '非日期异常必须原样上抛,不得转成 {ok:false} 或贴日期错误码',
  );
});

// 4. 护照-only 组端到端(真 bridge;设计文档缺口[高]#3):no_receipt_tasks → no_receipts。
test('护照-only 组端到端:ok:true + insertedRows:0 + settlementStatus no_receipts + skippedReason 透传', async () => {
  const tourCalls = [];
  const repo = {
    listBySourceGroup: () => [],
    listWorkspaceKeysForSourceGroup: () => [],
    deleteMany: () => 0,
  };
  const svc = createWorkbenchApproveSettleService({
    groupApprovalService: { approveGroup: async () => ({ approvedTaskIds: ['task_p1'] }) },
    ledgerBridgeService: createWorkbenchLedgerBridgeService({ dailyReceiptRepo: repo, logger: SILENT }),
    tourMatchService: { run: async ({ workspaceKey }) => { tourCalls.push(workspaceKey); return {}; } },
    dailyReceiptRepo: repo,
    logger: SILENT,
  });
  const batch = {
    id: 'batch_p',
    monthlyWorkspaceKey: '2026-07',
    tasks: [{ id: 'task_p1', sourceGroupKey: 'g1', docTypeFinal: 'passport' }],
  };

  const out = await svc.approveAndSettleGroup({ batch, groupKey: 'g1', operator: 'op1' });

  assert.equal(out.ok, true, '护照-only 组是"无东西可结"不是错误');
  assert.deepEqual(out.approvedTaskIds, ['task_p1']);
  assert.equal(out.insertedRows, 0);
  assert.equal(out.skippedRows, 0);
  assert.equal(out.skippedReason, 'no_receipt_tasks', '非错误跳过原因透传给前端');
  assert.equal(out.settlementStatus, 'no_receipts');
  assert.deepEqual(out.settledReceipts, []);
  assert.deepEqual(out.affectedWorkspaces, []);
  assert.deepEqual(out.tourResults, []);
  assert.deepEqual(tourCalls, [], '没有受影响 workspace,不跑 tour_match');
});

// 5. confirmGroupModes 跨多 workspace 累加(设计文档缺口[中]:mock 硬编单 ws 掩盖逐月循环)。
test('confirmGroupModes:组跨两 ws 各 1 可盖行 → confirmed=2,逐 ws 传参正确', async () => {
  const confirmCalls = [];
  const confirmedWs = new Set();
  const repo = {
    listWorkspaceKeysForSourceGroup: () => ['2026-06', '2026-07'],
    confirmModesByGroup: ({ workspaceKey, sourceBatchId, sourceCustomerId, operator }) => {
      confirmCalls.push({ workspaceKey, sourceBatchId, sourceCustomerId, operator });
      confirmedWs.add(workspaceKey);
      return 1;
    },
    listBySourceGroup: ({ workspaceKey }) => [{
      id: workspaceKey === '2026-06' ? 61 : 71,
      receiptNo: workspaceKey === '2026-06' ? 'R6' : 'R7',
      tourMatchStatus: 'matched',
      modeRaw: '乐天SG',
      modeConfirmedAt: confirmedWs.has(workspaceKey) ? '2026-07-01T00:00:00Z' : null,
    }],
  };
  const svc = createWorkbenchApproveSettleService({
    groupApprovalService: { approveGroup: async () => ({ approvedTaskIds: [] }) },
    ledgerBridgeService: { syncApprovedGroup: async () => ({ inserted: 0 }) },
    tourMatchService: { run: async () => ({}) },
    dailyReceiptRepo: repo,
    logger: SILENT,
  });

  const out = await svc.confirmGroupModes({ batch: BATCH, groupKey: 'g1', operator: 'op9' });

  assert.equal(out.confirmed, 2, '两个月各盖 1 行,累加=2');
  assert.deepEqual(confirmCalls.map((c) => c.workspaceKey), ['2026-06', '2026-07'], '逐 ws 各调一次');
  for (const c of confirmCalls) {
    assert.equal(c.sourceBatchId, 'batch_x');
    assert.equal(c.sourceCustomerId, 'g1');
    assert.equal(c.operator, 'op9');
  }
  assert.equal(out.settlementStatus, 'settled');
  assert.equal(out.settledReceipts.length, 2, '两个月的行都回读到');
});

// ── 真 SQLite(手法同 daily_receipt_restore_roundtrip:临时目录 + t.after 清理)──
function openTmpRepo(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const db = openMonthlyDatabase({ dbPath: path.join(dir, 'monthly.sqlite') });
  const repo = createDailyReceiptRepository({ db });
  t.after(() => {
    try { db.close?.(); } catch { /* best-effort */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });
  return repo;
}

// 6. insertMany 事务原子性(设计文档缺口[中]:事务 ROLLBACK 无测)。
// 注:本表约束错(UNIQUE/NOT NULL)被 INSERT OR IGNORE 吞成 skipped 不抛(先固化这一语义);
// 事务中段真实可抛路径=行序列化/绑定失败,契约=整批 ROLLBACK 首行不残留 + 异常上抛。
test('insertMany 真SQLite:第二行中途抛错 → 整批 ROLLBACK 首行不残留 + 异常上抛', (t) => {
  const repo = openTmpRepo(t, 'dr-insert-rollback-');

  // 前置语义固化:UNIQUE(workspace_key,row_hash) 撞行 → OR IGNORE 计 skipped,不抛不回滚
  const dup = repo.insertMany([
    { workspaceKey: '2026-06', receiptNo: 'A', rowHash: 'h-dup', importedAt: 't' },
    { workspaceKey: '2026-06', receiptNo: 'B', rowHash: 'h-dup', importedAt: 't' },
  ]);
  assert.deepEqual(dup, { inserted: 1, skipped: 1 }, 'UNIQUE 撞行走 skip 语义,不是异常');

  // 第二行 rawPayload 循环引用 → buildInsertValues 的 JSON.stringify 在事务中段抛
  const circular = {};
  circular.self = circular;
  assert.throws(() => repo.insertMany([
    { workspaceKey: '2026-07', receiptNo: 'R1', rowHash: 'h-r1', importedAt: 't' },
    { workspaceKey: '2026-07', receiptNo: 'R2', rowHash: 'h-r2', importedAt: 't', rawPayload: circular },
  ]), /circular/i, '中途失败必须把异常上抛给调用方(settleGroupAtomic 靠它整批回滚)');

  assert.equal(repo._listAll({ workspaceKey: '2026-07' }).length, 0, '已插入的第一行必须随 ROLLBACK 消失,不残留半批');

  // 事务已干净回滚(BEGIN 未悬挂):同键重插成功
  const again = repo.insertMany([
    { workspaceKey: '2026-07', receiptNo: 'R1', rowHash: 'h-r1', importedAt: 't' },
  ]);
  assert.deepEqual(again, { inserted: 1, skipped: 0 });
});

// 7. updateTourMatch × F6 手动锁(设计文档缺口[中]:本域无直测)。
test('updateTourMatch 真SQLite:manual_locked_fields 锁 tour_match_status → skipped 报锁 + 状态不变', (t) => {
  const repo = openTmpRepo(t, 'dr-manual-lock-');
  const WS = '2026-07';
  repo.insertMany([{
    workspaceKey: WS, receiptNo: 'RL1', shop: '乐天免税店', purchaseDate: '2026-07-10',
    tourNo: '26107001', tourMatchStatus: 'tour_not_found', billMatchStatus: 'unmatched',
    rowHash: 'h-lock', importedAt: 't', sourceType: 'workbench',
    // F6:人工补救把 tour_match_status 锁进 manual_locked_fields(补救台/结算面板同款)
    manualLockedFields: '["tour_match_status"]',
  }]);
  const row = repo._listAll({ workspaceKey: WS }).find((r) => r.rowHash === 'h-lock');
  assert.ok(row, '种子行应插入成功');
  assert.equal(row.manualLockedFields, '["tour_match_status"]', '锁必须真落库(insertMany 带锁列)');

  const res = repo.updateTourMatch({
    id: row.id,
    workspaceKey: WS,
    modeFolder: '乐天首尔',
    modeRaw: '乐天SG',
    modeNormalized: '乐天SG',
    tourMatchStatus: 'matched',
  });

  assert.deepEqual(res.skippedDueToManualLock, ['tour_match_status'], '被锁列必须出现在 skipped 名单(可观测)');
  assert.ok(!('tour_match_status' in res.written), 'written 不得含被锁列');
  assert.equal(res.changes, 1, '未锁列仍然写入(锁是列级,不是行级)');

  const after = repo._fetchFullById({ workspaceKey: WS, id: row.id });
  assert.equal(after.tourMatchStatus, 'tour_not_found', '人工结论保住:增量匹配不覆盖被锁状态');
  assert.equal(after.modeFolder, '乐天首尔', '未锁的 mode 三列照常更新');
  assert.equal(after.modeRaw, '乐天SG');
  assert.equal(after.modeNormalized, '乐天SG');
  assert.equal(after.manualLockedFields, '["tour_match_status"]', '锁本身不被增量匹配抹掉');
});

// 8. settleGroupAtomic 原子性(L180 核心,真 SQLite):删旧+写新同一事务,写新中途抛 →
//    删旧一并回滚(旧行不丢),这是替代 M5 内存快照/补插的根本保证(且跨月删/插工作区不同也原子)。
test('settleGroupAtomic 真SQLite:写新中途抛 → 删旧回滚旧行不丢 + 无半批新行', (t) => {
  const repo = openTmpRepo(t, 'dr-settle-atomic-');
  // 种两个旧月的旧未匹配行(跨月:6 月 + 7 月各 1)
  repo.insertMany([
    { workspaceKey: '2026-06', receiptNo: 'OLD-JUN', shop: '乐天免税店', purchaseDate: '2026-06-28',
      billMatchStatus: 'unmatched', rowHash: 'h-old-jun', importedAt: 't', sourceType: 'workbench' },
    { workspaceKey: '2026-07', receiptNo: 'OLD-JUL', shop: '乐天免税店', purchaseDate: '2026-07-03',
      billMatchStatus: 'unmatched', rowHash: 'h-old-jul', importedAt: 't', sourceType: 'workbench' },
  ]);
  const junId = repo._listAll({ workspaceKey: '2026-06' }).find((r) => r.rowHash === 'h-old-jun').id;
  const julId = repo._listAll({ workspaceKey: '2026-07' }).find((r) => r.rowHash === 'h-old-jul').id;

  const circular = {}; circular.self = circular; // 第二条新行序列化必抛(事务中段真实可抛路径)
  assert.throws(() => repo.settleGroupAtomic({
    deletes: [
      { workspaceKey: '2026-06', ids: [junId] },
      { workspaceKey: '2026-07', ids: [julId] },
    ],
    insertBuckets: [{
      workspaceKey: '2026-07',
      rows: [
        { workspaceKey: '2026-07', receiptNo: 'NEW-1', shop: '乐天免税店', purchaseDate: '2026-07-10', rowHash: 'h-new-1', importedAt: 't', sourceType: 'workbench' },
        { workspaceKey: '2026-07', receiptNo: 'NEW-2', shop: '乐天免税店', purchaseDate: '2026-07-10', rowHash: 'h-new-2', importedAt: 't', sourceType: 'workbench', rawPayload: circular },
      ],
    }],
  }), /circular/i, '写新中途抛必须上抛给调用方');

  // 原子回滚:两个旧月的旧行都还在(删被回滚),没有任何新行残留
  const junRows = repo._listAll({ workspaceKey: '2026-06' });
  assert.equal(junRows.length, 1, '6 月旧行随回滚保住(删被撤销)');
  assert.equal(junRows[0].receiptNo, 'OLD-JUN');
  const julRows = repo._listAll({ workspaceKey: '2026-07' });
  assert.equal(julRows.length, 1, '7 月只剩旧行,半批新行不残留');
  assert.equal(julRows[0].receiptNo, 'OLD-JUL', '7 月旧行还在(删被回滚)');

  // 事务干净收尾(未悬挂):后续正常操作可用
  const again = repo.insertMany([
    { workspaceKey: '2026-07', receiptNo: 'AFTER', shop: '乐天免税店', purchaseDate: '2026-07-11', rowHash: 'h-after', importedAt: 't', sourceType: 'workbench' },
  ]);
  assert.deepEqual(again, { inserted: 1, skipped: 0 });
});

// 9. settleGroupAtomic 成功路径(真 SQLite):删旧 + 写新一起提交,跨月删(7 月)/插(8 月)工作区不同也对。
test('settleGroupAtomic 真SQLite:成功路径删旧+写新一起提交(跨月删7插8)', (t) => {
  const repo = openTmpRepo(t, 'dr-settle-atomic-ok-');
  repo.insertMany([
    { workspaceKey: '2026-07', receiptNo: 'OLD-A', shop: '乐天免税店', purchaseDate: '2026-07-03',
      billMatchStatus: 'unmatched', rowHash: 'h-old-a', importedAt: 't', sourceType: 'workbench' },
  ]);
  const oldId = repo._listAll({ workspaceKey: '2026-07' })[0].id;

  const res = repo.settleGroupAtomic({
    deletes: [{ workspaceKey: '2026-07', ids: [oldId] }],
    insertBuckets: [{
      workspaceKey: '2026-08',
      rows: [
        { workspaceKey: '2026-08', receiptNo: 'NEW-A', shop: '乐天免税店', purchaseDate: '2026-08-01', rowHash: 'h-new-a', importedAt: 't', sourceType: 'workbench' },
      ],
    }],
  });

  assert.deepEqual(res, { removed: 1, inserted: 1, skipped: 0 }, '删1插1一起提交');
  assert.equal(repo._listAll({ workspaceKey: '2026-07' }).length, 0, '旧月旧行已删');
  const augRows = repo._listAll({ workspaceKey: '2026-08' });
  assert.equal(augRows.length, 1, '新月新行已入');
  assert.equal(augRows[0].receiptNo, 'NEW-A');
});

// 10. settleGroupAtomic 空入参 = no-op,不炸(结算幂等:整组护照无小票时 deletes/insertBuckets 皆空)。
test('settleGroupAtomic 真SQLite:空 deletes/insertBuckets → {removed:0,inserted:0,skipped:0} 不炸', (t) => {
  const repo = openTmpRepo(t, 'dr-settle-atomic-empty-');
  assert.deepEqual(repo.settleGroupAtomic({}), { removed: 0, inserted: 0, skipped: 0 });
  assert.deepEqual(repo.settleGroupAtomic({ deletes: [], insertBuckets: [] }), { removed: 0, inserted: 0, skipped: 0 });
});
