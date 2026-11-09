'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openMonthlyDatabase } = require('../../lib/storage/monthly_database');
const {
  computeFingerprint,
  fingerprintFromPayload,
} = require('../../lib/monthly/conflict_fingerprint');
const { createBillMatchLogRepository } = require('../../repositories/bill_match_log_repository');
const { createDailyReceiptRepository } = require('../../repositories/daily_receipt_repository');
const { createMonthlyDataRepository } = require('../../repositories/monthly_data_repository');
const { createPendingReviewRepository } = require('../../repositories/pending_review_repository');
const { createStoreBillRepository } = require('../../repositories/store_bill_repository');
const { createBillMatchService } = require('../../services/monthly/bill_match_service');
const {
  createPendingReviewResolutionService,
} = require('../../services/monthly/pending_review_resolution_service');
const { createStageLogService } = require('../../services/monthly/stage_log_service');

const WS = 'demo-2026-01';

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b4-replay-'));
  const db = openMonthlyDatabase({ dbPath: path.join(dir, 'monthly.sqlite') });
  const storeBillRepo = createStoreBillRepository({ db });
  const dailyReceiptRepo = createDailyReceiptRepository({ db });
  const billMatchLogRepo = createBillMatchLogRepository({ db });
  const pendingReviewRepo = createPendingReviewRepository({ db });
  const monthlyDataRepo = createMonthlyDataRepository({ db });
  const stageLogService = createStageLogService({ exportRoot: dir });
  const billMatchService = createBillMatchService({
    db,
    storeBillRepo,
    dailyReceiptRepo,
    billMatchLogRepo,
    pendingReviewRepo,
  });
  const resolutionService = createPendingReviewResolutionService({
    dailyReceiptRepo,
    storeBillRepo,
    billMatchLogRepo,
    pendingReviewRepo,
    monthlyDataRepo,
  });
  t.after(() => {
    try { db.close?.(); } catch {
      // intentional: best-effort cleanup
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    db,
    dir,
    storeBillRepo,
    dailyReceiptRepo,
    billMatchLogRepo,
    pendingReviewRepo,
    billMatchService,
    resolutionService,
    stageLogService,
  };
}

test('B4 t1: resolved pending is not regenerated on bill_match rerun', async (t) => {
  const ctx = setup(t);
  seedFieldConflict(ctx);

  await ctx.billMatchService.run({ workspaceKey: WS });
  const pending = onlyPending(ctx);
  resolvePending(ctx, pending);

  const rerun = await ctx.billMatchService.run({ workspaceKey: WS });

  assert.equal(ctx.pendingReviewRepo.list({ workspaceKey: WS, limit: 100 }).length, 1);
  assert.equal(rerun.skipped_due_to_resolved_or_rejected, 1);
});

test('B4 t2: open pending is not duplicated on bill_match rerun', async (t) => {
  const ctx = setup(t);
  seedFieldConflict(ctx);

  await ctx.billMatchService.run({ workspaceKey: WS });
  const rerun = await ctx.billMatchService.run({ workspaceKey: WS });

  assert.equal(ctx.pendingReviewRepo.countOpen(WS), 1);
  assert.equal(rerun.skipped_due_to_existing_open, 1);
});

test('B4 t2b: rerun replaces current bill_match logs instead of appending', async (t) => {
  const ctx = setup(t);
  seedExactMatch(ctx);

  await ctx.billMatchService.run({ workspaceKey: WS });
  assert.equal(ctx.billMatchLogRepo.countByWorkspace(WS), 1);

  await ctx.billMatchService.run({ workspaceKey: WS });

  assert.equal(ctx.billMatchLogRepo.countByWorkspace(WS), 1);
  const byStatus = ctx.billMatchLogRepo.countByStatus(WS);
  assert.equal(byStatus.find((row) => row.status === 'matched')?.n, 1);
});

test('B4 t3: changed daily conflict value creates a new pending after prior resolution', async (t) => {
  const ctx = setup(t);
  const { daily } = seedFieldConflict(ctx);

  await ctx.billMatchService.run({ workspaceKey: WS });
  const pending = onlyPending(ctx);
  resolvePending(ctx, pending);
  ctx.dailyReceiptRepo.applyFieldUpdates({
    id: daily.id,
    workspaceKey: WS,
    updates: { name: 'CHANGED DAILY' },
  });

  const rerun = await ctx.billMatchService.run({ workspaceKey: WS });

  assert.equal(ctx.pendingReviewRepo.list({ workspaceKey: WS, limit: 100 }).length, 2);
  assert.ok(rerun.newly_inserted >= 1);
});

test('B4 t4: changed store bill receipt number creates a new pending after prior resolution', async (t) => {
  const ctx = setup(t);
  const { bill } = seedFieldConflict(ctx);

  await ctx.billMatchService.run({ workspaceKey: WS });
  const pending = onlyPending(ctx);
  resolvePending(ctx, pending);
  ctx.db.prepare(`
    UPDATE store_bill
    SET receipt_no = 'R-CHANGED'
    WHERE workspace_key = ? AND id = ?
  `).run(WS, bill.id);

  const rerun = await ctx.billMatchService.run({ workspaceKey: WS });

  assert.equal(ctx.pendingReviewRepo.list({ workspaceKey: WS, limit: 100 }).length, 2);
  assert.ok(rerun.newly_inserted >= 1);
});

test('B4 t5: resolved field_conflict does not reappear', async (t) => {
  const ctx = setup(t);
  seedFieldConflict(ctx);

  await ctx.billMatchService.run({ workspaceKey: WS });
  const pending = onlyPending(ctx);
  await ctx.resolutionService.resolve({
    id: pending.id,
    workspaceKey: WS,
    status: 'resolved',
    resolvedBy: 'tester',
    decision: { fieldOverrides: { name: 'use_daily' } },
  });

  const rerun = await ctx.billMatchService.run({ workspaceKey: WS });

  assert.equal(ctx.pendingReviewRepo.list({ workspaceKey: WS, limit: 100 }).length, 1);
  // A1(2026-07-16)后语义升级:带 decision 的人工解决会锁 billMatchStatus → 该账单整个受保护
  // 不再重匹配(比"重匹配后靠指纹去重拦"更强)。不重现的结论不变,计数从去重口径挪到保护口径。
  assert.equal(rerun.protected_manual_matches.bills, 1, '人工解决的账单受保护不重匹配');
  assert.equal(rerun.skipped_due_to_resolved_or_rejected, 0);
});

test('B4 t6: stage log result contains replay-protection counters', async (t) => {
  const ctx = setup(t);
  seedFieldConflict(ctx);

  await ctx.billMatchService.run({ workspaceKey: WS });
  await ctx.billMatchService.run({ workspaceKey: WS, stageLogService: ctx.stageLogService });

  const logs = fs.readdirSync(path.join(ctx.dir, WS, 'logs')).filter((name) => name.endsWith('.log'));
  assert.equal(logs.length, 1);
  const body = fs.readFileSync(path.join(ctx.dir, WS, 'logs', logs[0]), 'utf8');
  assert.match(body, /skipped_due_to_existing_open/);
  assert.match(body, /skipped_due_to_resolved_or_rejected/);
  assert.match(body, /newly_inserted/);
});

test('B4 t7: resolving historical pending without fingerprint backfills fingerprint', async (t) => {
  const ctx = setup(t);
  const { bill, daily } = seedFieldConflict(ctx);
  insertHistoricalPending(ctx, { bill, daily, status: 'open' });
  const pending = onlyPending(ctx);

  await ctx.resolutionService.resolve({
    id: pending.id,
    workspaceKey: WS,
    status: 'resolved',
    resolvedBy: 'tester',
    decision: { fieldOverrides: { name: 'use_daily' } },
  });

  const row = ctx.pendingReviewRepo.findById({ id: pending.id, workspaceKey: WS });
  assert.match(row.conflictFingerprint, /^[a-f0-9]{64}$/);
});

test('B4 t8: historical resolved pending without fingerprint does not suppress new bill_match pending', async (t) => {
  const ctx = setup(t);
  const { bill, daily } = seedFieldConflict(ctx);
  insertHistoricalPending(ctx, { bill, daily, status: 'resolved' });

  await ctx.billMatchService.run({ workspaceKey: WS });

  assert.equal(ctx.pendingReviewRepo.list({ workspaceKey: WS, limit: 100 }).length, 2);
  assert.equal(ctx.pendingReviewRepo.countOpen(WS), 1);
});

test('B4 t10: 冲突消失后重跑,孤儿 open 待审被清扫(superseded_by_rerun)', async (t) => {
  // 2026-06-12 孤儿自愈:此前重跑只重置 conflict_fields/日志,从不关旧 open 待审 →
  // 数据修复后首页/交付仍报阻塞、账单核对各 tab 却是 0。改:标记-清扫。
  const ctx = setup(t);
  const { daily } = seedFieldConflict(ctx);

  await ctx.billMatchService.run({ workspaceKey: WS });
  assert.equal(ctx.pendingReviewRepo.countOpen(WS), 1);

  // 修台账姓名 = 与账单一致 → 冲突消失
  ctx.dailyReceiptRepo.applyFieldUpdates({
    id: daily.id,
    workspaceKey: WS,
    updates: { name: 'BILL NAME' },
  });
  const rerun = await ctx.billMatchService.run({ workspaceKey: WS });

  assert.equal(ctx.pendingReviewRepo.countOpen(WS), 0, '孤儿 open 行被清扫');
  assert.equal(rerun.superseded_pending_reviews, 1);
  const swept = ctx.pendingReviewRepo.list({ workspaceKey: WS, status: 'resolved', limit: 10 })[0];
  assert.equal(swept.resolution, 'superseded_by_rerun');
});

test('B4 t11: 被清扫的冲突再次出现时重新立 open 行(superseded 不参与去重)', async (t) => {
  const ctx = setup(t);
  const { daily } = seedFieldConflict(ctx);

  await ctx.billMatchService.run({ workspaceKey: WS });
  // 冲突消失 → 清扫
  ctx.dailyReceiptRepo.applyFieldUpdates({
    id: daily.id, workspaceKey: WS, updates: { name: 'BILL NAME' },
  });
  await ctx.billMatchService.run({ workspaceKey: WS });
  assert.equal(ctx.pendingReviewRepo.countOpen(WS), 0);

  // 冲突回来(同指纹) → superseded 行不该挡住新 open 行
  ctx.dailyReceiptRepo.applyFieldUpdates({
    id: daily.id, workspaceKey: WS, updates: { name: 'DAILY NAME' },
  });
  const rerun = await ctx.billMatchService.run({ workspaceKey: WS });

  assert.equal(ctx.pendingReviewRepo.countOpen(WS), 1, '同指纹冲突重新出现要重新立 open');
  assert.ok(rerun.newly_inserted >= 1);
});

test('B4 t12: 持续存在的冲突重跑保持同一条 open 行,不被清扫', async (t) => {
  const ctx = setup(t);
  seedFieldConflict(ctx);

  await ctx.billMatchService.run({ workspaceKey: WS });
  const before = ctx.pendingReviewRepo.list({ workspaceKey: WS, status: 'open', limit: 10 })[0];
  const rerun = await ctx.billMatchService.run({ workspaceKey: WS });
  const after = ctx.pendingReviewRepo.list({ workspaceKey: WS, status: 'open', limit: 10 })[0];

  assert.equal(ctx.pendingReviewRepo.countOpen(WS), 1);
  assert.equal(after.id, before.id, '同一条 open 行(身份不变,人工处理上下文不丢)');
  assert.equal(rerun.superseded_pending_reviews, 0);
  assert.equal(rerun.skipped_due_to_existing_open, 1);
});

test('B4 t13: 字段冲突在核对tab被解决时,挂在台账行上的 open 待审同步关闭', async (t) => {
  // resolve-conflict 路由清 conflict_fields 后必须同步关 pending_review,
  // 否则 tab 归零、首页/交付仍报阻塞(2026-06-12 运营截图的"2 个阻塞"成因)。
  const ctx = setup(t);
  const { daily } = seedFieldConflict(ctx);

  await ctx.billMatchService.run({ workspaceKey: WS });
  assert.equal(ctx.pendingReviewRepo.countOpen(WS), 1);

  const closed = ctx.pendingReviewRepo.closeFieldConflictByDailyReceiptId({
    workspaceKey: WS,
    dailyReceiptId: daily.id,
    operator: 'tester',
  });

  assert.equal(closed, 1);
  assert.equal(ctx.pendingReviewRepo.countOpen(WS), 0, '首页/交付阻塞同步归零');
  const row = ctx.pendingReviewRepo.list({ workspaceKey: WS, status: 'resolved', limit: 10 })[0];
  assert.equal(row.resolution, 'resolved_in_conflict_tab');
});

test('B4 t9: fingerprint is stable for candidate and conflict ordering', () => {
  const base = {
    sourceTable: 'store_bill',
    sourceId: 10,
    reasonType: 'ambiguous_match',
    detail: { priority: 1, matchKey: 'R1', candidateIds: [3, 1, 2] },
  };
  assert.equal(
    fingerprintFromPayload(base),
    fingerprintFromPayload({
      ...base,
      detail: { priority: 1, matchKey: 'R1', candidateIds: [2, 3, 1] },
    })
  );

  const conflictA = {
    sourceTable: 'store_bill',
    sourceId: 11,
    reasonType: 'field_conflict',
    detail: {
      priority: 1,
      matchKey: 'R2',
      dailyReceiptId: 22,
      conflicts: [
        { field: 'name', dailyValue: 'A', billValue: 'B' },
        { field: 'purchaseDate', dailyValue: '2026-01-01', billValue: '2026-01-02' },
      ],
    },
  };
  const conflictB = {
    ...conflictA,
    detail: {
      ...conflictA.detail,
      conflicts: conflictA.detail.conflicts.slice().reverse(),
    },
  };
  assert.equal(fingerprintFromPayload(conflictA), fingerprintFromPayload(conflictB));
  assert.equal(computeFingerprint({ ...conflictA, detail: JSON.stringify(conflictA.detail) }), fingerprintFromPayload(conflictA));
});

function seedFieldConflict(ctx) {
  ctx.dailyReceiptRepo.insertMany([dailyRow({ rowHash: `daily-${Date.now()}-${Math.random()}` })]);
  ctx.storeBillRepo.insertMany([billRow({ rowHash: `bill-${Date.now()}-${Math.random()}` })]);
  return {
    daily: ctx.dailyReceiptRepo._listAll({ workspaceKey: WS })[0],
    bill: ctx.storeBillRepo.iterateDetail(WS)[0],
  };
}

function seedExactMatch(ctx) {
  ctx.dailyReceiptRepo.insertMany([dailyRow({
    name: 'SAME NAME',
    rowHash: `daily-exact-${Date.now()}-${Math.random()}`,
  })]);
  ctx.storeBillRepo.insertMany([billRow({
    name: 'SAME NAME',
    rowHash: `bill-exact-${Date.now()}-${Math.random()}`,
  })]);
}

function dailyRow(overrides = {}) {
  return {
    workspaceKey: WS,
    receiptNo: 'R100',
    tourNo: 'T001',
    name: 'DAILY NAME',
    passportNo: 'P1234567',
    shop: 'THE SHILLA',
    purchaseDate: '2026-01-10',
    departureDate: '2026-01-12',
    rowHash: 'daily-base',
    importedAt: '2026-01-01T00:00:00.000Z',
    // 账单匹配候选前提:已过团号匹配(posted + matched)
    ledgerStatus: 'posted',
    tourMatchStatus: 'matched',
    ...overrides,
  };
}

function billRow(overrides = {}) {
  return {
    workspaceKey: WS,
    storeFamily: 'THE SHILLA',
    receiptNo: 'R100',
    tourNo: 'T001',
    name: 'BILL NAME',
    passportNo: 'P1234567',
    purchaseDate: '2026-01-10',
    departureDate: '2026-01-12',
    isDetailSheet: true,
    rowHash: 'bill-base',
    importedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function onlyPending(ctx) {
  const rows = ctx.pendingReviewRepo.list({ workspaceKey: WS, limit: 100 });
  assert.equal(rows.length, 1);
  return rows[0];
}

function resolvePending(ctx, pending) {
  ctx.pendingReviewRepo.resolve({
    id: pending.id,
    workspaceKey: WS,
    status: 'resolved',
    resolution: 'checked',
    resolvedBy: 'tester',
    resolvedAt: '2026-01-02T00:00:00.000Z',
  });
}

function insertHistoricalPending(ctx, { bill, daily, status }) {
  ctx.db.prepare(`
    INSERT INTO pending_review (
      workspace_key, source_table, source_id,
      reason_type, detail, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    WS,
    'store_bill',
    bill.id,
    'field_conflict',
    JSON.stringify({
      priority: 1,
      matchKey: 'R100',
      dailyReceiptId: daily.id,
      conflicts: [{ field: 'name', dailyValue: daily.name, billValue: bill.name }],
      autoFillable: [],
    }),
    status,
    '2026-01-01T00:00:00.000Z'
  );
}

// A1(2026-07-16 同步一致性审计):人工 resolve 的匹配结论必须抗 bill_match 重跑——
// 此前 clearCurrentMatchOutputs 裸重置锁定行+删其 matched 日志,人工白干且月度行丢失。
test('A1: 人工 resolve 锁定的 matched 抗重跑(不重置/日志保留/账单不重匹配)', async (t) => {
  const ctx = setup(t);
  seedFieldConflict(ctx);

  await ctx.billMatchService.run({ workspaceKey: WS });
  const pending = onlyPending(ctx);
  // 人工解决(manualLock 锁 billMatchStatus=matched + 写 matched 日志)
  await ctx.resolutionService.resolve({
    id: pending.id, workspaceKey: WS, status: 'resolved', resolvedBy: 'op1',
    decision: { fieldOverrides: { tourNo: 'use_bill' } },
  });
  const daily = ctx.dailyReceiptRepo._listAll({ workspaceKey: WS })[0];
  assert.equal(daily.billMatchStatus, 'matched', '前置:人工解决后行已 matched');
  const logsBefore = ctx.billMatchLogRepo.findByDaily({ workspaceKey: WS, dailyReceiptId: daily.id })
    .filter((l) => l.matchStatus === 'matched');
  assert.equal(logsBefore.length, 1, '前置:有一条 matched 日志');

  // 重跑账单匹配(生产里每次导账单/重跑都会发生)
  const rerun = await ctx.billMatchService.run({ workspaceKey: WS });

  const after = ctx.dailyReceiptRepo._fetchFullById({ workspaceKey: WS, id: daily.id });
  assert.equal(after.billMatchStatus, 'matched', '人工锁定的 matched 不得被重跑打回');
  const logsAfter = ctx.billMatchLogRepo.findByDaily({ workspaceKey: WS, dailyReceiptId: daily.id })
    .filter((l) => l.matchStatus === 'matched');
  assert.equal(logsAfter.length, 1, 'matched 日志必须保留且不重复(merge 靠它建月度行)');
  assert.equal(rerun.protected_manual_matches.dailyRows, 1, '统计里点名保护了几行');
  assert.ok(rerun.protected_manual_matches.bills >= 1);
  // 不因保护堆出新的 open 待审
  assert.equal(ctx.pendingReviewRepo.countOpen(WS), 0);
});
