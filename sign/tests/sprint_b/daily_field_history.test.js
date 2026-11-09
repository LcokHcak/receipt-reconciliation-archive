'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

const { computeDailyRowHash } = require('../../lib/monthly/daily_row_hash');
const { openMonthlyDatabase } = require('../../lib/storage/monthly_database');
const { createDailyFieldHistoryRepository } = require('../../repositories/daily_field_history_repository');
const { createDailyReceiptRepository } = require('../../repositories/daily_receipt_repository');
const { createMonthlyWorkspaceRepository } = require('../../repositories/monthly_workspace_repository');
const { createMonthlyWorkspaceService } = require('../../services/monthly/workspace_service');
const { createDailyWorkspaceMigrationService } = require('../../services/monthly/daily_workspace_migration_service');
const { createMonthlyRoutes } = require('../../routes/monthly_routes');

const WS = 'demo-2026-05';
const TWS = 'demo-2026-04';
let seq = 0;

function setup(t, historyRepoOverride = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-history-'));
  const dbPath = path.join(dir, 'monthly.sqlite');
  const db = openMonthlyDatabase({ dbPath });
  const workspaceRepo = createMonthlyWorkspaceRepository({ db });
  const workspaceService = createMonthlyWorkspaceService({ workspaceRepo });
  workspaceService.open({ workspaceKey: WS, operator: 'tester' });
  const historyRepo = historyRepoOverride || createDailyFieldHistoryRepository({ db });
  const dailyReceiptRepo = createDailyReceiptRepository({ db, fieldHistoryRepo: historyRepo });
  const migrationService = createDailyWorkspaceMigrationService({
    db,
    dailyReceiptRepo,
    monthlyDataRepo: { deleteByDaily() { return 0; } },
    billMatchLogRepo: { deleteByDaily() { return 0; } },
    pendingReviewRepo: { closeByDaily() { return 0; } },
    matchBadcaseRepo: { deleteByDaily() { return 0; } },
    workspaceService,
  });
  t.after(() => {
    try { db.close?.(); } catch {
      // intentional: best-effort cleanup
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db, dbPath, workspaceService, historyRepo, dailyReceiptRepo, migrationService };
}

function addDaily(ctx, overrides = {}) {
  seq += 1;
  const row = {
    workspaceKey: WS,
    receiptNo: `R-H-${seq}`,
    shop: 'THE SHILLA',
    name: 'HAN SEOL',
    passportNo: `M${String(seq).padStart(7, '0')}`,
    purchaseDate: '2026-05-12',
    departureDate: '2026-05-20',
    tourNo: '71990',
    tourMatchStatus: 'pending',
    billMatchStatus: 'unmatched',
    ledgerStatus: 'in_review',
    sourceType: 'workbench',
    importedAt: '2026-05-01T00:00:00.000Z',
    ...overrides,
  };
  row.rowHash = row.rowHash || computeDailyRowHash(row);
  ctx.dailyReceiptRepo.insertMany([row]);
  return ctx.dailyReceiptRepo._listAll({ workspaceKey: row.workspaceKey }).find((r) => r.rowHash === row.rowHash);
}

const histories = (ctx, ws, id, options = {}) => ctx.historyRepo.list({ workspaceKey: ws, dailyRowId: id, ...options });

async function getHistoryViaApi(ctx, url) {
  const app = express();
  app.use(express.json());
  createMonthlyRoutes({
    workspaceService: ctx.workspaceService,
    importService: {},
    errorDetectionService: {},
    dailyReceiptRepo: ctx.dailyReceiptRepo,
    dailyFieldHistoryRepo: ctx.historyRepo,
    upload: { single: () => (_req, _res, next) => next() },
  }).register(app, null);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`);
        resolve({ status: res.status, body: await res.json() });
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

test('0.4 t1: migration creates daily_field_history and is idempotent', (t) => {
  const ctx = setup(t);
  openMonthlyDatabase({ dbPath: ctx.dbPath }).close();
  const names = ctx.db.prepare(`
    SELECT name FROM sqlite_master
    WHERE name IN ('daily_field_history', 'idx_daily_field_history_row', 'idx_daily_field_history_source')
    ORDER BY name
  `).all().map((r) => r.name);
  assert.deepEqual(names, ['daily_field_history', 'idx_daily_field_history_row', 'idx_daily_field_history_source']);
});

test('0.4 t2: manual edit records changed fields only and keeps actor', (t) => {
  const ctx = setup(t);
  const row = addDaily(ctx);
  ctx.dailyReceiptRepo.applyFieldUpdates({ id: row.id, workspaceKey: WS, updates: { tourNo: '88888', name: row.name }, manualLock: true, actor: 'han' });
  const [h] = histories(ctx, WS, row.id);
  assert.equal(histories(ctx, WS, row.id).length, 1);
  assert.deepEqual([h.field, h.changeSource, h.actor, h.beforeValue, h.afterValue], ['tour_no', 'manual_edit', 'han', '"71990"', '"88888"']);
});

test('0.4 t3: ocr and pending resolution sources are recorded', (t) => {
  const ctx = setup(t);
  const row = addDaily(ctx);
  ctx.dailyReceiptRepo.updateTourMatch({ id: row.id, workspaceKey: WS, modeFolder: '乐天首尔', tourMatchStatus: 'matched' });
  ctx.dailyReceiptRepo.applyFieldUpdates({
    id: row.id, workspaceKey: WS, updates: { receiptNo: 'R-RESOLVED' }, manualLock: true,
    historySource: 'pending_resolution', actor: 'kim', conflictId: 42,
  });
  const rows = histories(ctx, WS, row.id);
  assert.ok(rows.some((r) => r.changeSource === 'ocr' && r.field === 'mode_folder'));
  assert.deepEqual(
    rows.filter((r) => r.changeSource === 'pending_resolution').map((r) => [r.conflictId, r.actor]),
    [['42', 'kim']]
  );
});

test('0.4 t4: bridge migration records workspace and purchaseDate changes', (t) => {
  const ctx = setup(t);
  const row = addDaily(ctx);
  ctx.migrationService.migrateDailyByPurchaseDate({ workspaceKey: WS, dailyReceiptId: row.id, newPurchaseDate: '2026-04-15', operator: 'bridge-op' });
  const rows = histories(ctx, TWS, row.id, { source: 'bridge_migration' });
  assert.deepEqual(rows.map((r) => r.field).sort(), ['purchase_date', 'workspace_key']);
  assert.ok(rows.every((r) => r.actor === 'bridge-op'));
});

test('0.4 t5: manual no-image insert records first-create history', (t) => {
  const ctx = setup(t);
  const row = addDaily(ctx, { sourceType: 'manual', sourceBatchId: 'manual-entry', name: 'MANUAL USER' });
  assert.ok(histories(ctx, WS, row.id, { source: 'manual_no_image' })
    .some((r) => r.field === 'name' && r.beforeValue === null && r.afterValue === '"MANUAL USER"'));
});

test('0.4 t6: history failure rolls back the daily update', (t) => {
  const ctx = setup(t, { recordChanges() { throw new Error('history boom'); }, list() { return []; } });
  const row = addDaily(ctx);
  assert.throws(() => ctx.dailyReceiptRepo.applyFieldUpdates({
    id: row.id, workspaceKey: WS, updates: { tourNo: '99999' }, manualLock: true,
  }), /history boom/);
  assert.equal(ctx.dailyReceiptRepo._fetchFullById({ workspaceKey: WS, id: row.id }).tourNo, '71990');
});

test('0.4 t7: API lists row history with source, before, and limit filters', async (t) => {
  const ctx = setup(t);
  const row = addDaily(ctx);
  ctx.dailyReceiptRepo.applyFieldUpdates({ id: row.id, workspaceKey: WS, updates: { tourNo: '11111' }, manualLock: true, actor: 'han' });
  ctx.dailyReceiptRepo.updateTourMatch({ id: row.id, workspaceKey: WS, modeFolder: '乐天首尔', tourMatchStatus: 'matched' });
  const res = await getHistoryViaApi(ctx, `/api/monthly/v2/${WS}/daily/${row.id}/history?source=manual_edit&limit=1&before=${encodeURIComponent(new Date().toISOString())}`);
  assert.deepEqual([res.status, res.body.rows.length, res.body.rows[0].changeSource, res.body.rows[0].dailyRowId], [200, 1, 'manual_edit', row.id]);
});

test('0.4 t8: list returns newest history first', (t) => {
  const ctx = setup(t);
  const row = addDaily(ctx);
  ctx.dailyReceiptRepo.applyFieldUpdates({ id: row.id, workspaceKey: WS, updates: { tourNo: '11111' }, manualLock: true });
  ctx.dailyReceiptRepo.applyFieldUpdates({ id: row.id, workspaceKey: WS, updates: { tourNo: '22222' }, manualLock: true });
  assert.deepEqual(histories(ctx, WS, row.id).map((r) => r.afterValue).slice(0, 2), ['"22222"', '"11111"']);
});
