'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createWorkbenchApproveSettleService } = require('../services/workbench_approve_settle_service');
const { withWorkspaceTourMatchLock } = require('../lib/workspace_tour_match_lock');

function makeDeps() {
  const calls = [];
  let tourActive = 0;
  let tourPeak = 0;
  const deps = {
    calls,
    stats: () => ({ tourPeak }),
    groupApprovalService: {
      approveGroup: async ({ groupKey }) => {
        calls.push(`approve:${groupKey}`);
        return { approvedTaskIds: ['task_0001', 'task_0002'] };
      },
    },
    ledgerBridgeService: {
      syncApprovedGroup: async () => {
        calls.push('bridge');
        return { inserted: 2, skipped: 0, workspaceKey: '2026-07', affectedWorkspaces: ['2026-07'] };
      },
    },
    tourMatchService: {
      // 锁下沉(8模块审计 HIGH):串行锁现内联在真实 tourMatchService.run 内部,
      // approve_settle 不再外包。这里的 stub 照真实 run 的行为在体内自锁,
      // 才能如实模拟"同 ws 串行"的收口效果。
      run: ({ workspaceKey }) => withWorkspaceTourMatchLock(workspaceKey, async () => {
        calls.push(`tour:${workspaceKey}`);
        tourActive += 1;
        tourPeak = Math.max(tourPeak, tourActive);
        await new Promise((r) => setTimeout(r, 8));
        tourActive -= 1;
        return { workspaceKey, scanned: 2, matched: 1 };
      }),
    },
    dailyReceiptRepo: {
      // shop/purchaseDate 必须与真实 SQL 投影(queries.js listBySourceGroupStmt)对齐——
      // 复核HIGH#1教训:mock 缺列时契约测试绿着,生产 shop 恒 null,"同店"收窄形同虚设
      listBySourceGroup: () => ([
        { id: 1, receiptNo: '111', tourNo: '26107001', shop: '乐天', purchaseDate: '2026-07-10', modeRaw: '乐天SG', modeFolder: '乐天首尔', tourMatchStatus: 'matched', billMatchStatus: 'unmatched' },
        { id: 2, receiptNo: '222', tourNo: '88812', shop: '乐天', purchaseDate: '2026-07-11', modeRaw: null, modeFolder: null, tourMatchStatus: 'tour_not_found', billMatchStatus: 'unmatched' },
      ]),
      listWorkspaceKeysForSourceGroup: () => [],
      deleteMany: () => 0,
    },
  };
  return deps;
}

function build(deps) {
  return createWorkbenchApproveSettleService({
    groupApprovalService: deps.groupApprovalService,
    ledgerBridgeService: deps.ledgerBridgeService,
    tourMatchService: deps.tourMatchService,
    dailyReceiptRepo: deps.dailyReceiptRepo,
    logger: { error() {}, log() {} },
  });
}

const BATCH = {
  id: 'batch_x',
  monthlyWorkspaceKey: '2026-07',
  tasks: [
    { id: 'task_0000', sourceGroupKey: 'g1', docTypeFinal: 'passport' },
    { id: 'task_0001', sourceGroupKey: 'g1', docTypeFinal: 'receipt' },
    { id: 'task_0002', sourceGroupKey: 'g1', docTypeFinal: 'receipt' },
    { id: 'task_0003', sourceGroupKey: 'g2', docTypeFinal: 'passport' },
    { id: 'task_0004', sourceGroupKey: 'g2', docTypeFinal: 'receipt' },
  ],
};

test('链路顺序 approve→bridge→tour,返回按小票的渠道模式', async () => {
  const deps = makeDeps();
  const svc = build(deps);
  const out = await svc.approveAndSettleGroup({ batch: BATCH, groupKey: 'g1', operator: 'u1' });

  assert.equal(out.ok, true);
  assert.deepEqual(deps.calls, ['approve:g1', 'bridge', 'tour:2026-07'], '严格按 approve→bridge→tour 顺序');
  assert.equal(out.insertedRows, 2);
  assert.equal(out.settledReceipts.length, 2, '两张小票各一行');
  assert.equal(out.settledReceipts[0].modeRaw, '乐天SG');
  assert.equal(out.settledReceipts[0].tourMatchStatus, 'matched');
  assert.equal(out.settledReceipts[1].tourMatchStatus, 'tour_not_found', '未命中如实返回,供前端内联补救');
  assert.equal(out.settlementStatus, 'needs_remedy', '有未命中 → 客户组状态待补救');
  // P1 内联补救契约(2026-07-18):面板当场补救要 PATCH /ledger/:id/fields——
  // 行必须带台账 id + 行级 workspaceKey(跨月组按行取,别用 affectedWorkspaces[0])
  for (const r of out.settledReceipts) {
    assert.ok(Object.prototype.hasOwnProperty.call(r, 'id'), '行必须带台账 id(内联补救 PATCH 用)');
    assert.equal(r.workspaceKey, '2026-07', '行级 workspaceKey');
  }
  // shop/purchaseDate 有值透传("同模式应用"按同团号+同店收窄/日期类预填靠它,不许再丢)
  assert.equal(out.settledReceipts[0].shop, '乐天');
  assert.equal(out.settledReceipts[0].purchaseDate, '2026-07-10');
});

test('加固①:有重拍的客户组 → 结算被拦,approve/bridge/tour 都不跑', async () => {
  const deps = makeDeps();
  const batch = { id: 'b', monthlyWorkspaceKey: '2026-07', tasks: [
    { id: 'p', sourceGroupKey: 'g1', docTypeFinal: 'passport' },
    { id: 'r', sourceGroupKey: 'g1', docTypeFinal: 'receipt', rephotoRequested: true },
  ] };
  const out = await build(deps).approveAndSettleGroup({ batch, groupKey: 'g1' });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'rephoto_requested');
  assert.equal(out.settlementStatus, 'blocked');
  assert.deepEqual(out.details, { taskId: 'r' }, '带上重拍那张的 taskId,前端红条可定位');
  assert.deepEqual(deps.calls, [], '拦在最前,什么都没跑');
});

test('加固①:护照≠1本(0本/2本)→ 结算被拦', async () => {
  const zero = { id: 'b', tasks: [{ id: 'r', sourceGroupKey: 'g1', docTypeFinal: 'receipt' }] };
  const out0 = await build(makeDeps()).approveAndSettleGroup({ batch: zero, groupKey: 'g1' });
  assert.equal(out0.reason, 'invalid_passport_count');
  assert.deepEqual(out0.details, { taskId: 'r' }, '缺护照是组级问题→落到组内第一张可定位');

  const two = { id: 'b', tasks: [
    { id: 'p1', sourceGroupKey: 'g1', docTypeFinal: 'passport' },
    { id: 'p2', sourceGroupKey: 'g1', docTypeFinal: 'passport' },
    { id: 'r', sourceGroupKey: 'g1', docTypeFinal: 'receipt' },
  ] };
  const out2 = await build(makeDeps()).approveAndSettleGroup({ batch: two, groupKey: 'g1' });
  assert.equal(out2.reason, 'invalid_passport_count');
  assert.deepEqual(out2.details, { taskId: 'p2' }, '多本护照→第二本是嫌疑张');
});

test('加固③:日期预检失败→拦在 approve 之前,什么都没发生(2026-07-14 审计#9:防组定稿了台账0行)', async () => {
  const deps = makeDeps();
  deps.ledgerBridgeService.precheckPurchaseDates = () => ({
    ok: false, code: 'purchase_date_out_of_range',
    error: '客户组 g1 / task_0001 / purchaseDate 2023-01-01 超范围',
    details: { taskId: 'task_0001', reason: 'purchase_date_out_of_range' },
  });
  const out = await build(deps).approveAndSettleGroup({ batch: BATCH, groupKey: 'g1', operator: 'u1' });
  assert.equal(out.ok, false);
  assert.equal(out.stage, 'precheck');
  assert.equal(out.reason, 'purchase_date_out_of_range');
  assert.deepEqual(deps.calls, [], '预检失败必须发生在 approve/bridge/tour 之前——一个都不许调');
});

test('加固③:桥接 throw(非返回error)→转结构化失败返回,不漏进兜底500(2026-07-14 审计#9)', async () => {
  const deps = makeDeps();
  deps.ledgerBridgeService.syncApprovedGroup = async () => { throw new Error('磁盘写入失败'); };
  const out = await build(deps).approveAndSettleGroup({ batch: BATCH, groupKey: 'g1', operator: 'u1' });
  assert.equal(out.ok, false);
  assert.equal(out.stage, 'ledger');
  assert.match(String(out.error), /磁盘写入失败/);
  assert.deepEqual(out.approvedTaskIds, ['task_0001', 'task_0002'], 'approve 已发生的事实要透传给调用方');
});

// L180:删旧行不再由 service 直接 deleteMany,而是把待删 ids 交给桥接与写台账在同一事务原子执行;
// 测试改为捕获桥接入参 deleteIdsByWorkspace(即 computeDeletableIdsByWorkspace 的选行结果),
// removedOldRows 由桥接回传的 removed 计数体现。
function captureDeletesBridge(deps) {
  let captured = null;
  deps.ledgerBridgeService.syncApprovedGroup = async ({ deleteIdsByWorkspace }) => {
    captured = deleteIdsByWorkspace;
    const removed = (deleteIdsByWorkspace || []).reduce((n, d) => n + d.ids.length, 0);
    return { inserted: 0, skipped: 0, removed, workspaceKey: '2026-07', affectedWorkspaces: ['2026-07'] };
  };
  return () => captured;
}

test('加固②:重结算先清本组旧未匹配台账行,matched 的保护不删', async () => {
  const deps = makeDeps();
  deps.dailyReceiptRepo.listWorkspaceKeysForSourceGroup = () => ['2026-07'];
  deps.dailyReceiptRepo.listBySourceGroup = () => ([
    { id: 10, billMatchStatus: 'unmatched', tourMatchStatus: 'matched', modeRaw: '乐天SG' },
    { id: 11, billMatchStatus: 'matched', tourMatchStatus: 'matched', modeRaw: '新罗V团' },
  ]);
  const getDeletes = captureDeletesBridge(deps);
  const out = await build(deps).approveAndSettleGroup({ batch: BATCH, groupKey: 'g1' });
  assert.deepEqual(getDeletes(), [{ workspaceKey: '2026-07', ids: [10] }], '只清未账单匹配的旧行,已 matched 的保护');
  assert.equal(out.removedOldRows, 1);
});

// F6(2026-07-18 设计):重结算清旧行不许删「人工补救过」的行——补救 PATCH(manualRemedyConfirm)
// 会把 tour_match_status 锁进 manual_locked_fields,这个锁就是人工结论的标记。
// 修复前 cleanOldUnmatchedRows 只看 billMatchStatus=unmatched,人工补救行照删 → 补救白干翻回未命中。
test('F6:manual_locked_fields 含 tour_match_status 的人工补救行,重结算不删', async () => {
  const deps = makeDeps();
  deps.dailyReceiptRepo.listWorkspaceKeysForSourceGroup = () => ['2026-07'];
  deps.dailyReceiptRepo.listBySourceGroup = () => ([
    // 人工补救过:选模式 confirm → mode 三列 + tour_match_status 上锁(补救台/结算面板同款)
    { id: 10, billMatchStatus: 'unmatched', tourMatchStatus: 'matched', manualLockedFields: '["mode_folder","mode_normalized","mode_raw","tour_match_status"]' },
    // 普通未命中行:无锁,照删重建
    { id: 11, billMatchStatus: 'unmatched', tourMatchStatus: 'tour_not_found', manualLockedFields: null },
    // 只锁了字段没锁状态(F12 修后的无 confirm 手改形态):锁的是业务键 purchase_date,照删避双行
    { id: 12, billMatchStatus: 'unmatched', tourMatchStatus: 'date_out_of_window', manualLockedFields: '["purchase_date"]' },
  ]);
  const getDeletes = captureDeletesBridge(deps);
  const out = await build(deps).approveAndSettleGroup({ batch: BATCH, groupKey: 'g1' });
  assert.deepEqual(getDeletes(), [{ workspaceKey: '2026-07', ids: [11, 12] }], '锁了 tour_match_status 的行保护;其余未匹配行照删');
  assert.equal(out.removedOldRows, 2);
});

// 审计MEDIUM:扩 F6 保护面——普通手改(不点补救确认)只锁被改的**非业务键**列(护照/姓名/团号/代理),
// 这些行此前照删→重结算用任务旧值重建→手改静默翻回(复现:台账页改护照号后重结算翻回)。
// 改为:锁了非业务键列且没锁业务键的行一律保护;锁了业务键(购买日期)的行仍删,避免留双行(双计)。
test('审计MEDIUM:锁护照号/姓名等非业务键的手改行重结算不删;锁业务键(购买日期)仍删避双行', async () => {
  const deps = makeDeps();
  deps.dailyReceiptRepo.listWorkspaceKeysForSourceGroup = () => ['2026-07'];
  deps.dailyReceiptRepo.listBySourceGroup = () => ([
    { id: 20, billMatchStatus: 'unmatched', manualLockedFields: '["passport_no"]' },          // 改护照号(非业务键)→ 保护
    { id: 21, billMatchStatus: 'unmatched', manualLockedFields: '["name","tour_no"]' },        // 改姓名+团号(非业务键)→ 保护
    { id: 22, billMatchStatus: 'unmatched', manualLockedFields: null },                        // 无锁 → 照删
    { id: 23, billMatchStatus: 'unmatched', manualLockedFields: '["purchase_date"]' },         // 锁业务键 → 照删(避双行)
    { id: 24, billMatchStatus: 'unmatched', manualLockedFields: '["name","purchase_date"]' },  // 含业务键锁 → 照删
  ]);
  const getDeletes = captureDeletesBridge(deps);
  const out = await build(deps).approveAndSettleGroup({ batch: BATCH, groupKey: 'g1' });
  assert.deepEqual(getDeletes(), [{ workspaceKey: '2026-07', ids: [22, 23, 24] }], '非业务键手改行(护照/姓名/团号)保护;无锁/业务键锁行照删');
  assert.equal(out.removedOldRows, 3);
});

// L180:重结算「删旧 + 写新」已下沉到 repo.settleGroupAtomic 同一事务——写台账抛错=整事务回滚
// (删旧一并撤销、旧行不丢、级联删的 error_record/pending_review 也随之复原),不再需要 service 端
// "删了失败再补插"的内存快照(那套只补 daily_receipt_export、补不回级联,且进程崩溃就漏)。
// service 契约:把待删 ids 交给桥接;sync 抛错/返回 {error} → 结构化失败,且 service 自己绝不再
// deleteMany/insertMany(删与写全在桥接的原子事务内)。真事务回滚已在 settle_ledger_boundary #8 直测。
test('加固M5(L180):sync 抛错 → 结构化失败;service 不自行删/补插(原子回滚由事务承担)', async () => {
  const deps = makeDeps();
  deps.dailyReceiptRepo.listWorkspaceKeysForSourceGroup = () => ['2026-07'];
  deps.dailyReceiptRepo.listBySourceGroup = () => ([{ id: 10, billMatchStatus: 'unmatched' }]);
  let deleteCalled = false;
  let insertCalled = false;
  deps.dailyReceiptRepo.deleteMany = () => { deleteCalled = true; return 1; };
  deps.dailyReceiptRepo.insertMany = () => { insertCalled = true; return { inserted: 1 }; };
  let capturedDeletes = null;
  deps.ledgerBridgeService.syncApprovedGroup = async ({ deleteIdsByWorkspace }) => {
    capturedDeletes = deleteIdsByWorkspace;
    throw new Error('磁盘写入失败');
  };

  const out = await build(deps).approveAndSettleGroup({ batch: BATCH, groupKey: 'g1', operator: 'u1' });
  assert.equal(out.ok, false);
  assert.equal(out.stage, 'ledger');
  assert.match(String(out.error), /磁盘写入失败/);
  assert.deepEqual(capturedDeletes, [{ workspaceKey: '2026-07', ids: [10] }], '待删 id 交给桥接原子处理');
  assert.equal(out.restoredOldRows, undefined, 'L180:不再有 service 端补插回滚字段');
  assert.equal(deleteCalled, false, 'service 不再自行 deleteMany(删在桥接原子事务内)');
  assert.equal(insertCalled, false, 'service 不再自行 insertMany 补插(回滚由事务承担)');
});

test('加固M5(L180):sync 返回 {error} → 结构化失败;service 不自行删/补插', async () => {
  const deps = makeDeps();
  deps.dailyReceiptRepo.listWorkspaceKeysForSourceGroup = () => ['2026-07'];
  deps.dailyReceiptRepo.listBySourceGroup = () => ([{ id: 20, billMatchStatus: 'unmatched' }]);
  let insertCalled = false;
  deps.dailyReceiptRepo.insertMany = () => { insertCalled = true; return { inserted: 1 }; };
  deps.ledgerBridgeService.syncApprovedGroup = async () => ({ error: 'ensureWorkspace failed', inserted: 0, removed: 0, affectedWorkspaces: [] });

  const out = await build(deps).approveAndSettleGroup({ batch: BATCH, groupKey: 'g1', operator: 'u1' });
  assert.equal(out.ok, false);
  assert.equal(out.stage, 'ledger');
  assert.match(String(out.error), /ensureWorkspace failed/);
  assert.equal(out.restoredOldRows, undefined, 'L180:无补插回滚字段');
  assert.equal(insertCalled, false, 'service 不再自行 insertMany 补插');
});

test('加固M5(L180):sync 成功 → removedOldRows 来自原子 op 回传;service 不自行删/补插', async () => {
  const deps = makeDeps();
  deps.dailyReceiptRepo.listWorkspaceKeysForSourceGroup = () => ['2026-07'];
  deps.dailyReceiptRepo.listBySourceGroup = () => ([{ id: 30, billMatchStatus: 'unmatched' }]);
  let insertCalled = false;
  deps.dailyReceiptRepo.insertMany = () => { insertCalled = true; return { inserted: 1 }; };
  const getDeletes = captureDeletesBridge(deps); // 桥接回传 removed=待删数(模拟原子 op 提交)
  const out = await build(deps).approveAndSettleGroup({ batch: BATCH, groupKey: 'g1', operator: 'u1' });
  assert.equal(out.ok, true);
  assert.deepEqual(getDeletes(), [{ workspaceKey: '2026-07', ids: [30] }], '待删 id 交给桥接原子处理');
  assert.equal(out.removedOldRows, 1, 'removedOldRows 来自桥接原子 op 回传的 removed');
  assert.equal(insertCalled, false, 'service 不自行 insertMany(删与写全在桥接原子事务内)');
});

function makeRepo(initialRows) {
  let rows = initialRows.map((r) => ({ ...r }));
  return {
    listBySourceGroup: () => rows.map((r) => ({ ...r })),
    listWorkspaceKeysForSourceGroup: () => ['2026-07'],
    confirmModesByGroup: () => {
      // F1b:与真实 SQL 同口径——盖 matched / skipped_mode_not_required / 无团号(pending+tourNo空)。
      let changed = 0;
      rows = rows.map((r) => {
        const st = r.tourMatchStatus;
        const noTour = st === 'pending' && (r.tourNo == null || r.tourNo === '');
        const eligible = st === 'matched' || st === 'skipped_mode_not_required' || noTour;
        if (eligible && !r.modeConfirmedAt) {
          changed += 1;
          return { ...r, modeConfirmedAt: '2026-07-01T00:00:00Z' };
        }
        return r;
      });
      return changed;
    },
  };
}

function buildWithRepo(dailyReceiptRepo) {
  return createWorkbenchApproveSettleService({
    groupApprovalService: { approveGroup: async () => ({ approvedTaskIds: [] }) },
    ledgerBridgeService: { syncApprovedGroup: async () => ({ inserted: 0 }) },
    tourMatchService: { run: async () => ({}) },
    dailyReceiptRepo,
    logger: { error() {}, log() {} },
  });
}

test('confirmGroupModes:确认全部已命中小票 → 状态 settled,confirmed 计数对', async () => {
  const repo = makeRepo([
    { receiptNo: '1', tourMatchStatus: 'matched', modeRaw: '乐天SG', modeConfirmedAt: null },
    { receiptNo: '2', tourMatchStatus: 'matched', modeRaw: '新罗V团', modeConfirmedAt: null },
  ]);
  const svc = buildWithRepo(repo);
  const out = await svc.confirmGroupModes({ batch: BATCH, groupKey: 'g1', operator: 'u1' });
  assert.equal(out.confirmed, 2);
  assert.equal(out.settlementStatus, 'settled');
  assert.ok(out.settledReceipts.every((r) => r.modeConfirmedAt));
});

test('F1b confirmGroupModes:含 skipped/无团号的组确认后 settled(不再永卡 needs_confirm)', async () => {
  const repo = makeRepo([
    { receiptNo: '1', tourMatchStatus: 'skipped_mode_not_required', modeRaw: '乐天SG', modeConfirmedAt: null },
    { receiptNo: '2', tourMatchStatus: 'pending', tourNo: null, modeConfirmedAt: null }, // 无团号(tour_no NULL)
  ]);
  const svc = buildWithRepo(repo);
  // 修前:confirmed=0、状态永卡 needs_confirm;修后:两行都盖戳 → settled
  assert.equal(svc.getGroupSettlement({ batch: BATCH, groupKey: 'g1' }).settlementStatus, 'needs_confirm', '确认前=needs_confirm');
  const out = await svc.confirmGroupModes({ batch: BATCH, groupKey: 'g1', operator: 'u1' });
  assert.equal(out.confirmed, 2, 'skipped + 无团号 两行都盖戳');
  assert.equal(out.settlementStatus, 'settled');
});

test('getGroupSettlement 派生:未命中=needs_remedy / 已命中未确认=needs_confirm / 全确认=settled', () => {
  assert.equal(buildWithRepo(makeRepo([
    { receiptNo: '1', tourMatchStatus: 'tour_not_found' },
  ])).getGroupSettlement({ batch: BATCH, groupKey: 'g1' }).settlementStatus, 'needs_remedy');

  assert.equal(buildWithRepo(makeRepo([
    { receiptNo: '1', tourMatchStatus: 'matched', modeConfirmedAt: null },
  ])).getGroupSettlement({ batch: BATCH, groupKey: 'g1' }).settlementStatus, 'needs_confirm');

  assert.equal(buildWithRepo(makeRepo([
    { receiptNo: '1', tourMatchStatus: 'matched', modeConfirmedAt: '2026-07-01T00:00:00Z' },
  ])).getGroupSettlement({ batch: BATCH, groupKey: 'g1' }).settlementStatus, 'settled');

  assert.equal(buildWithRepo(makeRepo([]))
    .getGroupSettlement({ batch: BATCH, groupKey: 'g1' }).settlementStatus, 'no_receipts');
});

test('桥接失败 → ok:false 且不跑 tour_match(不静默丢数据)', async () => {
  const deps = makeDeps();
  deps.ledgerBridgeService.syncApprovedGroup = async () => {
    deps.calls.push('bridge');
    return { error: 'disk full', inserted: 0, affectedWorkspaces: [] };
  };
  const svc = build(deps);
  const out = await svc.approveAndSettleGroup({ batch: BATCH, groupKey: 'g1' });

  assert.equal(out.ok, false);
  assert.equal(out.stage, 'ledger');
  assert.match(out.error, /disk full/);
  assert.ok(!deps.calls.some((c) => c.startsWith('tour:')), '桥接失败不应再跑 tour_match');
  assert.deepEqual(out.settledReceipts, []);
});

test('一组小票跨月:每个 workspace 各跑一次 tour_match,回读合并', async () => {
  const deps = makeDeps();
  deps.ledgerBridgeService.syncApprovedGroup = async () => {
    deps.calls.push('bridge');
    return { inserted: 2, skipped: 0, affectedWorkspaces: ['2026-06', '2026-07'] };
  };
  deps.dailyReceiptRepo.listBySourceGroup = ({ workspaceKey }) => ([
    { receiptNo: workspaceKey === '2026-06' ? 'JUN' : 'JUL', tourMatchStatus: 'matched', modeRaw: '乐天SG' },
  ]);
  const svc = build(deps);
  const out = await svc.approveAndSettleGroup({ batch: BATCH, groupKey: 'g1' });

  assert.deepEqual(out.affectedWorkspaces, ['2026-06', '2026-07']);
  assert.ok(deps.calls.includes('tour:2026-06') && deps.calls.includes('tour:2026-07'));
  assert.equal(out.settledReceipts.length, 2, '两个月的行都回读到');
});

test('并发同 workspace 结算:tour_match 被串行(峰值并发=1;锁已下沉进 run,不再靠外层 wrap)', async () => {
  const deps = makeDeps();
  const svc = build(deps);
  await Promise.all([
    svc.approveAndSettleGroup({ batch: BATCH, groupKey: 'g1' }),
    svc.approveAndSettleGroup({ batch: BATCH, groupKey: 'g2' }),
  ]);
  assert.equal(deps.stats().tourPeak, 1, '同 workspace 的 tour_match 不并发(串行锁在 run 内部)');
});

test('缺参数抛错(batch / groupKey)', async () => {
  const svc = build(makeDeps());
  await assert.rejects(() => svc.approveAndSettleGroup({ groupKey: 'g1' }), /batch required/);
  await assert.rejects(() => svc.approveAndSettleGroup({ batch: BATCH, groupKey: '' }), /groupKey required/);
});

test('缺依赖时构造即抛(快速失败)', () => {
  assert.throws(() => createWorkbenchApproveSettleService({}), /groupApprovalService/);
});
