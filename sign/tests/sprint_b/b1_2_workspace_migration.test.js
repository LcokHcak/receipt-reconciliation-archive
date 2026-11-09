'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

const { computeDailyRowHash } = require('../../lib/monthly/daily_row_hash');
const { openMonthlyDatabase } = require('../../lib/storage/monthly_database');
const { createAuditLogRepository } = require('../../repositories/audit_log_repository');
const { createBillMatchLogRepository } = require('../../repositories/bill_match_log_repository');
const { createDailyReceiptRepository } = require('../../repositories/daily_receipt_repository');
const { createMatchBadcaseRepository } = require('../../repositories/match_badcase_repository');
const { createMonthlyDataRepository } = require('../../repositories/monthly_data_repository');
const { createMonthlyWorkspaceRepository } = require('../../repositories/monthly_workspace_repository');
const { createPendingReviewRepository } = require('../../repositories/pending_review_repository');
const { createErrorRecordRepository } = require('../../repositories/error_record_repository');
const { createDailyWorkspaceMigrationService } = require('../../services/monthly/daily_workspace_migration_service');
const { createMonthlyWorkspaceService } = require('../../services/monthly/workspace_service');
const { createMonthlyRoutes } = require('../../routes/monthly_routes');

const WS = 'demo-2026-05';
const TWS = 'demo-2026-04';

function setup(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b1-2-migration-'));
  const db = openMonthlyDatabase({ dbPath: path.join(dir, 'monthly.sqlite') });
  const workspaceRepo = createMonthlyWorkspaceRepository({ db });
  const workspaceService = createMonthlyWorkspaceService({ workspaceRepo });
  workspaceService.open({ workspaceKey: WS, operator: 'test' });
  const dailyReceiptRepo = createDailyReceiptRepository({ db });
  const monthlyDataRepo = createMonthlyDataRepository({ db });
  const billMatchLogRepo = createBillMatchLogRepository({ db });
  const pendingReviewRepo = createPendingReviewRepository({ db });
  const matchBadcaseRepo = createMatchBadcaseRepository({ db });
  const errorRecordRepo = createErrorRecordRepository({ db });
  const migrationService = createDailyWorkspaceMigrationService({
    db,
    dailyReceiptRepo,
    monthlyDataRepo: overrides.monthlyDataRepo || monthlyDataRepo,
    billMatchLogRepo,
    pendingReviewRepo,
    matchBadcaseRepo,
    errorRecordRepo,
    workspaceService,
  });
  t.after(() => {
    try { db.close?.(); } catch {
      // intentional: best-effort cleanup
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db, workspaceService, dailyReceiptRepo, monthlyDataRepo, billMatchLogRepo, pendingReviewRepo, matchBadcaseRepo, errorRecordRepo, migrationService };
}

function addDaily(ctx, overrides = {}) {
  const row = {
    workspaceKey: WS, receiptNo: 'R100', shop: 'THE SHILLA', name: 'ZHANG LIYA',
    passportNo: 'EG8761171', purchaseDate: '2026-05-15', departureDate: '2026-05-20',
    tourNo: '71990', tourMatchStatus: 'matched', billMatchStatus: 'matched',
    billMatchPriority: 1, ledgerStatus: 'posted', importedAt: '2026-05-01T00:00:00.000Z',
    sourceType: 'workbench', ...overrides,
  };
  row.rowHash = row.rowHash || computeDailyRowHash(row);
  ctx.dailyReceiptRepo.insertMany([row]);
  return ctx.dailyReceiptRepo._listAll({ workspaceKey: row.workspaceKey }).find((r) => r.rowHash === row.rowHash);
}

function getDaily(ctx, workspaceKey, id) {
  return ctx.dailyReceiptRepo._fetchFullById({ workspaceKey, id });
}

function addShadows(ctx, daily) {
  ctx.monthlyDataRepo.insertMany([{
    workspaceKey: daily.workspaceKey, modeFolder: 'THE SHILLA', isUnmatched: false,
    dailyReceiptId: daily.id, storeBillId: 10, receiptNo: daily.receiptNo, shop: daily.shop,
    purchaseDate: daily.purchaseDate, name: daily.name, passportNo: daily.passportNo,
    rowHash: `monthly-${daily.id}`, createdAt: '2026-05-01T00:00:00.000Z',
  }]);
  ctx.billMatchLogRepo.insertMany([{ workspaceKey: daily.workspaceKey, dailyReceiptId: daily.id, storeBillId: 10, matchPriority: 1, matchKey: 'R100', matchStatus: 'matched', matchedAt: '2026-05-01T00:00:00.000Z' }]);
  ctx.pendingReviewRepo.insertMany([{ workspaceKey: daily.workspaceKey, sourceTable: 'daily_receipt_export', sourceId: daily.id, reasonType: 'field_conflict', detail: { dailyReceiptId: daily.id }, status: 'open', createdAt: '2026-05-01T00:00:00.000Z' }]);
  ctx.matchBadcaseRepo.insertMany([{ workspaceKey: daily.workspaceKey, stage: 'bill_match', kind: 'field_conflict', sourceTable: 'daily_receipt_export', sourceId: daily.id, dailyReceiptId: daily.id, receiptNo: daily.receiptNo, purchaseDate: daily.purchaseDate, createdAt: '2026-05-01T00:00:00.000Z' }]);
}

function appFor(ctx) {
  const app = express();
  app.use(express.json());
  createMonthlyRoutes({
    workspaceService: ctx.workspaceService,
    importService: {},
    errorDetectionService: {},
    dailyReceiptRepo: ctx.dailyReceiptRepo,
    dailyWorkspaceMigrationService: ctx.migrationService,
    upload: { single: () => (_req, _res, next) => next() },
  }).register(app, null);
  return app;
}

function patch(app, url, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', async () => {
      try {
        const { port } = server.address();
        const res = await fetch(`http://127.0.0.1:${port}${url}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        resolve({ status: res.status, body: await res.json() });
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

test('B1.2 t1: same-month edit does not migrate and locks purchase_date', (t) => {
  const ctx = setup(t);
  const row = addDaily(ctx);
  const result = ctx.migrationService.migrateDailyByPurchaseDate({ workspaceKey: WS, dailyReceiptId: row.id, newPurchaseDate: '2026-05-20', operator: 'tester' });
  ctx.dailyReceiptRepo.applyFieldUpdates({ id: row.id, workspaceKey: WS, updates: { purchaseDate: '2026-05-20' }, manualLock: true });
  assert.equal(result.migrated, false);
  const after = getDaily(ctx, WS, row.id);
  assert.equal(after.purchaseDate, '2026-05-20');
  assert.equal(after.manualLockedFields, '["purchase_date"]');
});

test('B1.2 t2-t4/t17: cross-month migration moves row, resets state, preserves locks, recomputes hash', (t) => {
  const ctx = setup(t);
  const row = addDaily(ctx, { manualLockedFields: '["mode_folder"]' });
  ctx.dailyReceiptRepo.applyFieldUpdates({ id: row.id, workspaceKey: WS, updates: { modeFolder: 'MANUAL' }, manualLock: true });
  const oldHash = getDaily(ctx, WS, row.id).rowHash;
  const result = ctx.migrationService.migrateDailyByPurchaseDate({ workspaceKey: WS, dailyReceiptId: row.id, newPurchaseDate: '2026-04-15', operator: 'tester' });
  const moved = getDaily(ctx, TWS, row.id);
  const expectedHash = computeDailyRowHash({ workspaceKey: TWS, receiptNo: 'R100', purchaseDate: '2026-04-15', shop: 'THE SHILLA' });
  assert.equal(result.migrated, true);
  assert.equal(getDaily(ctx, WS, row.id), null);
  assert.equal(moved.workspaceKey, TWS);
  assert.equal(moved.tourMatchStatus, 'pending');
  assert.equal(moved.billMatchStatus, 'unmatched');
  assert.equal(moved.billMatchPriority, null);
  assert.equal(moved.ledgerStatus, 'posted');
  assert.equal(moved.remedyReason, null);
  assert.equal(moved.manualLockedFields, '["mode_folder","purchase_date"]');
  assert.notEqual(moved.rowHash, oldHash);
  assert.equal(moved.rowHash, expectedHash);
});

test('B1.2 迁移摘阶段状态锁(审计HIGH line534)+清模式背书戳(line486):人工背书补救行换月不再永久卡 pending/过早 settled', (t) => {
  const { filterStageUpdates } = require('../../lib/monthly/manual_lock');
  const ctx = setup(t);
  // 人工把 tour/bill_match_status 背书锁住(补救确认)+ 模式背书戳,并对字段「值」订正锁 name/mode_folder
  const row = addDaily(ctx, {
    manualLockedFields: '["tour_match_status","bill_match_status","name","mode_folder"]',
    modeConfirmedAt: '2026-05-10T00:00:00.000Z',
    modeConfirmedBy: 'reviewer1',
  });
  const result = ctx.migrationService.migrateDailyByPurchaseDate({ workspaceKey: WS, dailyReceiptId: row.id, newPurchaseDate: '2026-04-15', operator: 'tester' });
  assert.equal(result.migrated, true);
  const moved = getDaily(ctx, TWS, row.id);

  // 阶段状态被重置为待重判
  assert.equal(moved.tourMatchStatus, 'pending');
  assert.equal(moved.billMatchStatus, 'unmatched');
  // 关键(534):阶段状态锁必须摘掉,否则重匹配的 filterStageUpdates 跳过 → 永久卡 pending
  const locks = JSON.parse(moved.manualLockedFields || '[]');
  assert.ok(!locks.includes('tour_match_status'), 'tour_match_status 阶段锁必须摘掉');
  assert.ok(!locks.includes('bill_match_status'), 'bill_match_status 阶段锁必须摘掉');
  // 字段「值」订正锁照常保留(人工数据订正跨月仍有效)+ 迁移锁定购买日期
  assert.ok(locks.includes('name') && locks.includes('mode_folder') && locks.includes('purchase_date'), '值订正锁保留');
  // 行为证明:重匹配现在真能更新 tour_match_status(不再被锁跳过)
  const { allowed, skipped } = filterStageUpdates(moved, { tour_match_status: 'matched', bill_match_status: 'matched' });
  assert.equal(allowed.tour_match_status, 'matched');
  assert.equal(allowed.bill_match_status, 'matched');
  assert.deepEqual(skipped, [], '两个阶段状态都不再被锁跳过');
  // 模式背书戳清空(486):否则目标月 deriveSettlementStatus(rows.every(modeConfirmedAt))过早判 settled、旧月背书授权新月
  assert.equal(moved.modeConfirmedAt, null);
  assert.equal(moved.modeConfirmedBy ?? null, null);
});

test('B1.2 t5-t8: source workspace shadows are cleaned or closed transactionally', (t) => {
  const ctx = setup(t);
  const row = addDaily(ctx);
  addShadows(ctx, row);
  ctx.migrationService.migrateDailyByPurchaseDate({ workspaceKey: WS, dailyReceiptId: row.id, newPurchaseDate: '2026-04-15', operator: 'tester' });
  assert.equal(ctx.monthlyDataRepo.findByDaily({ workspaceKey: WS, dailyReceiptId: row.id }), null);
  assert.deepEqual(ctx.billMatchLogRepo.findByDaily({ workspaceKey: WS, dailyReceiptId: row.id }), []);
  assert.equal(ctx.pendingReviewRepo.list({ workspaceKey: WS, status: null, limit: 20 })[0].resolution, 'workspace_migrated');
  assert.deepEqual(ctx.matchBadcaseRepo.list({ workspaceKey: WS, limit: 20 }), []);
});

test('B1.2 t9-t11: date_missing recovery enters automated path and keeps demo prefix', (t) => {
  const ctx = setup(t);
  const row = addDaily(ctx, { purchaseDate: null, tourMatchStatus: 'date_missing', ledgerStatus: 'remedy', remedyReason: 'tour_match_unresolved', rowHash: 'date-missing-source' });
  ctx.migrationService.migrateDailyByPurchaseDate({ workspaceKey: WS, dailyReceiptId: row.id, newPurchaseDate: '2026-04-15', operator: 'tester' });
  const moved = getDaily(ctx, TWS, row.id);
  assert.equal(moved.tourMatchStatus, 'pending');
  assert.equal(moved.ledgerStatus, 'posted');
  assert.equal(moved.remedyReason, null);
  assert.equal(ctx.dailyReceiptRepo.listPendingTourMatch(TWS).some((r) => r.id === row.id), true);
  assert.equal(ctx.dailyReceiptRepo._listAll({ workspaceKey: '2026-04' }).length, 0);
});

test('B1.2 t12-t13: invalid or out-of-range purchaseDate is rejected with no writes', (t) => {
  const ctx = setup(t);
  const row = addDaily(ctx);
  assert.throws(
    () => ctx.migrationService.migrateDailyByPurchaseDate({ workspaceKey: WS, dailyReceiptId: row.id, newPurchaseDate: '2018-01-15', operator: 'tester' }),
    (err) => err.code === 'purchase_date_out_of_range'
  );
  assert.throws(
    () => ctx.migrationService.migrateDailyByPurchaseDate({ workspaceKey: WS, dailyReceiptId: row.id, newPurchaseDate: 'not-a-date', operator: 'tester' }),
    (err) => err.code === 'invalid_purchase_date'
  );
  assert.equal(getDaily(ctx, WS, row.id).purchaseDate, '2026-05-15');
  assert.equal(ctx.dailyReceiptRepo._listAll({ workspaceKey: TWS }).length, 0);
});

test('B1.2 t12-t13 HTTP: route returns 400 error codes for invalid dates', async (t) => {
  const ctx = setup(t);
  const row = addDaily(ctx);
  const invalid = await patch(appFor(ctx), `/api/monthly/workspaces/${WS}/ledger/${row.id}/fields`, { purchaseDate: 'not-a-date' });
  const outOfRange = await patch(appFor(ctx), `/api/monthly/workspaces/${WS}/ledger/${row.id}/fields`, { purchaseDate: '2018-01-15' });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, 'invalid_purchase_date');
  assert.equal(outOfRange.status, 400);
  assert.equal(outOfRange.body.code, 'purchase_date_out_of_range');
});

test('B1.2 t14: migration rolls back if shadow cleanup fails', (t) => {
  const ctx = setup(t, { monthlyDataRepo: { deleteByDaily() { throw new Error('boom'); } } });
  const row = addDaily(ctx);
  addShadows(ctx, row);
  assert.throws(() => ctx.migrationService.migrateDailyByPurchaseDate({ workspaceKey: WS, dailyReceiptId: row.id, newPurchaseDate: '2026-04-15', operator: 'tester' }), /boom/);
  assert.ok(getDaily(ctx, WS, row.id));
  assert.equal(getDaily(ctx, TWS, row.id), null);
  assert.equal(ctx.billMatchLogRepo.findByDaily({ workspaceKey: WS, dailyReceiptId: row.id }).length, 1);
  assert.equal(ctx.pendingReviewRepo.list({ workspaceKey: WS, status: 'open', limit: 20 }).length, 1);
  assert.equal(ctx.matchBadcaseRepo.list({ workspaceKey: WS, limit: 20 }).length, 1);
});

test('B1.2 t15: PATCH migrates and then writes remaining fields in target workspace', async (t) => {
  const ctx = setup(t);
  const row = addDaily(ctx);
  const res = await patch(appFor(ctx), `/api/monthly/workspaces/${WS}/ledger/${row.id}/fields`, { purchaseDate: '2026-04-15', tourNo: '99999' });
  const moved = getDaily(ctx, TWS, row.id);
  assert.equal(res.status, 200);
  assert.equal(res.body.migrated, true);
  assert.equal(res.body.targetWorkspaceKey, TWS);
  assert.equal(moved.tourNo, '99999');
  assert.equal(moved.manualLockedFields, '["purchase_date","tour_no"]');
});

test('B1.2 迁移标脏(8模块审计HIGH):源月 bill_match、目标月 tour_match 都标脏,否则两月都漏这张票', async (t) => {
  const ctx = setup(t);
  const row = addDaily(ctx);
  const dirtyCalls = [];
  const app = express();
  app.use(express.json());
  createMonthlyRoutes({
    workspaceService: ctx.workspaceService,
    importService: {},
    errorDetectionService: {},
    dailyReceiptRepo: ctx.dailyReceiptRepo,
    dailyWorkspaceMigrationService: ctx.migrationService,
    derivationRecomputeService: { markDirty: (ws, stage) => dirtyCalls.push({ ws, stage }) },
    upload: { single: () => (_req, _res, next) => next() },
  }).register(app, null);

  const res = await patch(app, `/api/monthly/workspaces/${WS}/ledger/${row.id}/fields`, { purchaseDate: '2026-04-15' });
  assert.equal(res.status, 200);
  assert.equal(res.body.migrated, true);
  // 源月 bill_match(行移走,merge 要把它从交付摘掉)+ 目标月 tour_match(新 pending 行要匹配进月度)
  assert.deepEqual(dirtyCalls, [
    { ws: WS, stage: 'bill_match' },
    { ws: TWS, stage: 'tour_match' },
  ]);
});

test('B1.2 t18: target row_hash collision returns 409 and leaves rows and shadows untouched', async (t) => {
  const ctx = setup(t);
  const row = addDaily(ctx);
  addShadows(ctx, row);
  ctx.workspaceService.open({ workspaceKey: TWS, operator: 'test' });
  const target = { ...row, workspaceKey: TWS, purchaseDate: '2026-04-15', rowHash: null, receiptDate: '2026-04-15', receiptNo: 'R100' };
  target.rowHash = computeDailyRowHash(target);
  ctx.dailyReceiptRepo.insertMany([target]);
  const res = await patch(appFor(ctx), `/api/monthly/workspaces/${WS}/ledger/${row.id}/fields`, { purchaseDate: '2026-04-15' });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'target_row_hash_collision');
  assert.ok(getDaily(ctx, WS, row.id));
  assert.equal(ctx.dailyReceiptRepo._listAll({ workspaceKey: TWS }).length, 1);
  assert.equal(ctx.monthlyDataRepo.findByDaily({ workspaceKey: WS, dailyReceiptId: row.id }) !== null, true);
  assert.equal(ctx.pendingReviewRepo.list({ workspaceKey: WS, status: 'open', limit: 20 }).length, 1);
});

test('D4a B1.2 t19: successful cross-month migration writes audit_log entry', (t) => {
  const dir = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'b1-2-audit-'));
  const db = openMonthlyDatabase({ dbPath: require('node:path').join(dir, 'monthly.sqlite') });
  t.after(() => {
    try { db.close?.(); } catch { /* intentional */ }
    require('node:fs').rmSync(dir, { recursive: true, force: true });
  });

  const workspaceRepo = createMonthlyWorkspaceRepository({ db });
  const workspaceService = createMonthlyWorkspaceService({ workspaceRepo });
  workspaceService.open({ workspaceKey: WS, operator: 'test' });
  const dailyReceiptRepo = createDailyReceiptRepository({ db });
  const monthlyDataRepo = createMonthlyDataRepository({ db });
  const billMatchLogRepo = createBillMatchLogRepository({ db });
  const pendingReviewRepo = createPendingReviewRepository({ db });
  const matchBadcaseRepo = createMatchBadcaseRepository({ db });
  const auditLogRepo = createAuditLogRepository({ db });

  const migrationSvc = createDailyWorkspaceMigrationService({
    db, dailyReceiptRepo, monthlyDataRepo, billMatchLogRepo,
    pendingReviewRepo, matchBadcaseRepo, workspaceService, auditLogRepo,
  });

  // Add a row and run cross-month migration
  const row = (() => {
    const r = {
      workspaceKey: WS, receiptNo: 'AUDIT-001', shop: 'THE SHILLA', name: 'TEST USER',
      passportNo: 'EG0000001', purchaseDate: '2026-05-15', departureDate: '2026-05-20',
      tourNo: 'TOUR001', tourMatchStatus: 'matched', billMatchStatus: 'matched',
      billMatchPriority: 1, ledgerStatus: 'posted', importedAt: '2026-05-01T00:00:00.000Z',
      sourceType: 'workbench',
    };
    r.rowHash = computeDailyRowHash(r);
    dailyReceiptRepo.insertMany([r]);
    return dailyReceiptRepo._listAll({ workspaceKey: WS }).find((x) => x.rowHash === r.rowHash);
  })();

  const result = migrationSvc.migrateDailyByPurchaseDate({
    workspaceKey: WS, dailyReceiptId: row.id, newPurchaseDate: '2026-04-15', operator: 'tester',
  });
  assert.equal(result.migrated, true);

  // Audit log should contain the migrate_daily_row entry
  const entries = auditLogRepo.list({ action: 'migrate_daily_row', limit: 10 });
  assert.equal(entries.length, 1, 'exactly one migrate_daily_row audit entry');
  assert.equal(entries[0].action, 'migrate_daily_row');
  assert.equal(entries[0].userId, 'tester');
  assert.equal(entries[0].resourceId, String(row.id));
  assert.equal(entries[0].details?.sourceWorkspaceKey, WS);
  assert.equal(entries[0].details?.targetWorkspaceKey, TWS);
});

// L614:跨月迁移把行搬去目标月后,源月 open TM_ error_record 变孤儿(源月已无此行→永不自愈)。
// 迁移事务内按行级 source_id 精确清源月该行的 TM error;同票号另一未迁移行的 TM 阻塞必须保住。
test('B1.2 L614: 跨月迁移清源月孤儿 TM error(按行精确,不连坐同票号兄弟行)', (t) => {
  const ctx = setup(t);
  // 待迁移行 A + 同源月同票号的兄弟行 B(不同购买日,不迁移)
  const rowA = addDaily(ctx, { receiptNo: 'R-MIG', purchaseDate: '2026-05-15', rowHash: 'a-mig' });
  const rowB = addDaily(ctx, { receiptNo: 'R-MIG', purchaseDate: '2026-05-18', rowHash: 'b-sib' });
  // 各自的 open TM error(按行 source_id)
  ctx.errorRecordRepo.insertMany([
    { workspaceKey: WS, errorType: 'TM_TOUR_NOT_FOUND', receiptNo: 'R-MIG', sourceId: rowA.id, detectedAt: '2026-05-01T00:00:00.000Z' },
    { workspaceKey: WS, errorType: 'TM_TOUR_NOT_FOUND', receiptNo: 'R-MIG', sourceId: rowB.id, detectedAt: '2026-05-01T00:00:00.000Z' },
  ]);
  assert.equal(
    ctx.db.prepare("SELECT COUNT(1) AS n FROM error_record WHERE workspace_key = ? AND status = 'open'").get(WS).n,
    2, '前置:源月两条 open TM error',
  );

  const result = ctx.migrationService.migrateDailyByPurchaseDate({
    workspaceKey: WS, dailyReceiptId: rowA.id, newPurchaseDate: '2026-04-15', operator: 'tester',
  });
  assert.equal(result.migrated, true, 'A 已跨月迁移到目标月');

  const remain = ctx.errorRecordRepo.list({ workspaceKey: WS, status: 'open', limit: 10 });
  assert.equal(remain.length, 1, '源月只剩兄弟行 B 的 TM error(A 的孤儿被清)');
  assert.equal(remain[0].sourceId, rowB.id, '保住的是未迁移兄弟行 B(不连坐)');
});

// L614:legacy(source_id 为 null)的源月 TM error 也应被迁移清理(receipt_no 兜底)。
test('B1.2 L614: legacy(无 source_id)源月 TM error 迁移时按 receipt_no 兜底清', (t) => {
  const ctx = setup(t);
  const rowA = addDaily(ctx, { receiptNo: 'R-LEG', purchaseDate: '2026-05-15', rowHash: 'a-leg' });
  ctx.errorRecordRepo.insertMany([
    { workspaceKey: WS, errorType: 'TM_TOUR_NOT_FOUND', receiptNo: 'R-LEG', detectedAt: '2026-05-01T00:00:00.000Z' }, // 无 sourceId
  ]);
  ctx.migrationService.migrateDailyByPurchaseDate({
    workspaceKey: WS, dailyReceiptId: rowA.id, newPurchaseDate: '2026-04-15', operator: 'tester',
  });
  assert.equal(
    ctx.errorRecordRepo.list({ workspaceKey: WS, status: 'open', limit: 10 }).length,
    0, 'legacy TM error 按 receipt_no 兜底清(过渡期不残留幽灵)',
  );
});
