'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

const { runMigrations } = require('../../lib/storage/migration_runner');
const { openMonthlyDatabase } = require('../../lib/storage/monthly_database');
const { createMonthlyWorkspaceRepository } = require('../../repositories/monthly_workspace_repository');
const { createDailyReceiptRepository } = require('../../repositories/daily_receipt_repository');
const { createBillMatchLogRepository } = require('../../repositories/bill_match_log_repository');
const { createModeDeductConfigRepository } = require('../../repositories/monthly/mode_deduct_config_repo');
const { createModeFolderMappingRepository } = require('../../repositories/monthly/mode_folder_mapping_repo');
const { createMonthlyWorkspaceService } = require('../../services/monthly/workspace_service');
const { createModeConfigService } = require('../../services/monthly/mode_config_service');
const { createModeFolderApplyService } = require('../../services/monthly/mode_folder_apply_service');
const { createMonthlyRoutes } = require('../../routes/monthly_routes');

const WS = 'demo-2026-05';
const PREV_WS = 'demo-2026-04';
const PROD_WS = '2026-05';
const FOLDERS = ['乐天首尔', '乐天釜山', '爱宝客', '济州新罗V团'];

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b2-config-'));
  const db = openMonthlyDatabase({ dbPath: path.join(dir, 'monthly.sqlite') });
  const workspaceRepo = createMonthlyWorkspaceRepository({ db });
  const workspaceService = createMonthlyWorkspaceService({ workspaceRepo });
  workspaceService.open({ workspaceKey: WS, operator: 'test' });
  workspaceService.open({ workspaceKey: PREV_WS, operator: 'test' });
  workspaceService.open({ workspaceKey: 'demo-2026-03', operator: 'test' });
  workspaceService.open({ workspaceKey: PROD_WS, operator: 'test' });

  const dailyReceiptRepo = createDailyReceiptRepository({ db });
  const billMatchLogRepo = createBillMatchLogRepository({ db });
  const modeDeductConfigRepo = createModeDeductConfigRepository({ db });
  const modeFolderMappingRepo = createModeFolderMappingRepository({ db });
  const modeConfigService = createModeConfigService({
    workspaceService,
    workspaceRepo,
    modeDeductConfigRepo,
    modeFolderMappingRepo,
    modeFolderApplyService: createModeFolderApplyService({ dailyReceiptRepo, modeFolderMappingRepo }),
  });

  const app = express();
  app.use(express.json());
  createMonthlyRoutes({
    workspaceService,
    importService: {},
    errorDetectionService: {},
    upload: { single: () => (_req, _res, next) => next() },
    modeConfigService,
    dailyReceiptRepo,
    billMatchLogRepo,
    mergeService: {
      async run({ workspaceKey }) {
        return { workspaceKey, merged: true };
      },
    },
  }).register(app, null);

  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    server.close();
    try { db.close?.(); } catch {
      // intentional: best-effort cleanup
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  return { db, baseUrl, dailyReceiptRepo, billMatchLogRepo };
}

test('B2 phase1 t0: migration is idempotent and adds config tables/columns', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b2-migration-'));
  const db = openMonthlyDatabase({ dbPath: path.join(dir, 'monthly.sqlite') });
  const migrationsDir = path.join(__dirname, '..', '..', 'lib', 'storage', 'migrations');
  runMigrations(db, migrationsDir, { logger: null });

  assert.ok(tableExists(db, 'mode_deduct_config'));
  assert.ok(tableExists(db, 'mode_folder_mapping'));
  assert.ok(columnExists(db, 'monthly_workspace', 'deduct_config_confirmed_at'));
  assert.ok(columnExists(db, 'monthly_workspace', 'mode_mapping_confirmed_at'));

  t.after(() => {
    try { db.close?.(); } catch {
      // intentional: best-effort cleanup
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

test('B2 phase1 t1-t6: deduct config default rows, updates, validation, copy previous', async (t) => {
  const { baseUrl } = await setup(t);

  const initial = await requestJson(baseUrl, 'GET', `/api/monthly/workspaces/${WS}/deduct-config`);
  assert.equal(initial.status, 200);
  assert.equal(initial.body.confirmed_at, null);
  assert.deepEqual(initial.body.rows.map((r) => r.mode_folder), FOLDERS);
  assert.deepEqual(initial.body.rows.map((r) => r.deduct_value), [null, null, null, null]);

  const putAll = await requestJson(baseUrl, 'PUT', `/api/monthly/workspaces/${WS}/deduct-config`, {
    rows: FOLDERS.map((mode_folder, i) => ({ mode_folder, deduct_value: Number((0.01 * (i + 1)).toFixed(4)) })),
    confirm: true,
  });
  assert.equal(putAll.status, 200);
  assert.ok(putAll.body.confirmed_at);

  const partial = await requestJson(baseUrl, 'PUT', `/api/monthly/workspaces/${WS}/deduct-config`, {
    rows: [
      { mode_folder: FOLDERS[0], deduct_value: -0.0123 },
      { mode_folder: FOLDERS[1], deduct_value: 0.2222 },
    ],
  });
  assert.equal(partial.status, 200);
  assert.equal(partial.body.confirmed_at, null);
  assert.equal(rowByFolder(partial.body.rows, FOLDERS[0]).deduct_value, -0.0123);
  assert.equal(rowByFolder(partial.body.rows, FOLDERS[2]).deduct_value, 0.03);

  const invalid = await requestJson(baseUrl, 'PUT', `/api/monthly/workspaces/${WS}/deduct-config`, {
    rows: [{ mode_folder: '未知模式', deduct_value: 0.1 }],
  });
  assert.equal(invalid.status, 400);

  await requestJson(baseUrl, 'PUT', `/api/monthly/workspaces/${PREV_WS}/deduct-config`, {
    rows: FOLDERS.map((mode_folder, i) => ({ mode_folder, deduct_value: Number((0.1 * (i + 1)).toFixed(4)) })),
    confirm: true,
  });
  const copied = await requestJson(baseUrl, 'POST', `/api/monthly/workspaces/${WS}/deduct-config/copy-from-previous`);
  assert.equal(copied.status, 200);
  assert.equal(copied.body.copied, 4);
  assert.equal(copied.body.confirmed_at, null);
  assert.equal(rowByFolder(copied.body.rows, FOLDERS[3]).deduct_value, 0.4);

  const none = await requestJson(baseUrl, 'POST', '/api/monthly/workspaces/demo-2026-03/deduct-config/copy-from-previous');
  assert.equal(none.status, 200);
  assert.equal(none.body.copied, 0);
});

test('B2 phase1 t7-t10: mode mapping lists unmapped raw modes, confirms only complete mapping, validates folders', async (t) => {
  const { baseUrl, dailyReceiptRepo } = await setup(t);
  dailyReceiptRepo.insertMany([
    dailyRow({ modeRaw: '乐天SG-本司', rowHash: 'd1' }),
    dailyRow({ modeRaw: '爱宝客SG-本司', rowHash: 'd2' }),
    dailyRow({ modeRaw: '济州新罗V团-本司', rowHash: 'd3' }),
    dailyRow({ modeRaw: '乐天釜山SG-本司', rowHash: 'd4' }),
    dailyRow({ modeRaw: '未归类模式', rowHash: 'd5' }),
  ]);

  const initial = await requestJson(baseUrl, 'GET', `/api/monthly/workspaces/${WS}/mode-mapping`);
  assert.equal(initial.status, 200);
  assert.equal(initial.body.confirmed_at, null);
  assert.deepEqual(initial.body.unmapped.sort(), [
    '乐天SG-本司', '乐天釜山SG-本司', '未归类模式', '济州新罗V团-本司', '爱宝客SG-本司',
  ].sort());

  const partial = await requestJson(baseUrl, 'PUT', `/api/monthly/workspaces/${WS}/mode-mapping`, {
    mappings: [
      { mode_raw: '乐天SG-本司', mode_folder: '乐天首尔' },
      { mode_raw: '爱宝客SG-本司', mode_folder: '爱宝客' },
    ],
    confirm: true,
  });
  assert.equal(partial.status, 200);
  assert.equal(partial.body.dailyRowsRefreshed, 4);
  assert.equal(partial.body.confirmed_at, null);
  assert.ok(partial.body.unmapped.includes('未归类模式'));

  const full = await requestJson(baseUrl, 'PUT', `/api/monthly/workspaces/${WS}/mode-mapping`, {
    mappings: [
      { mode_raw: '乐天釜山SG-本司', mode_folder: '乐天釜山' },
      { mode_raw: '济州新罗V团-本司', mode_folder: '济州新罗V团' },
      { mode_raw: '未归类模式', mode_folder: '乐天首尔' },
    ],
    confirm: true,
  });
  assert.equal(full.status, 200);
  assert.ok(full.body.confirmed_at);
  assert.deepEqual(full.body.unmapped, []);

  const invalid = await requestJson(baseUrl, 'PUT', `/api/monthly/workspaces/${WS}/mode-mapping`, {
    mappings: [{ mode_raw: '新模式', mode_folder: '未知模式' }],
  });
  assert.equal(invalid.status, 400);
});

test('B2 phase1 t11-t15: merge blocks until deduct and mode mapping are confirmed and complete', async (t) => {
  const { db, baseUrl, dailyReceiptRepo, billMatchLogRepo } = await setup(t);
  dailyReceiptRepo.insertMany([
    dailyRow({ idSeed: 1, modeRaw: '乐天SG-本司', rowHash: 'merge-d1' }),
  ]);
  billMatchLogRepo.insertMany([{
    workspaceKey: WS,
    dailyReceiptId: 1,
    storeBillId: 1,
    matchPriority: 1,
    matchKey: 'test',
    matchStatus: 'matched',
    matchedAt: new Date().toISOString(),
  }]);

  let res = await requestJson(baseUrl, 'POST', `/api/monthly/workspaces/${WS}/stages/merge`, {});
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'merge_blocked');
  assert.equal(res.body.reason, 'deduct_config_not_confirmed');

  await requestJson(baseUrl, 'PUT', `/api/monthly/workspaces/${WS}/deduct-config`, {
    rows: FOLDERS.slice(0, 3).map((mode_folder) => ({ mode_folder, deduct_value: 0.01 })),
  });
  db.prepare(`
    UPDATE monthly_workspace
    SET deduct_config_confirmed_at = ?
    WHERE workspace_key = ?
  `).run(new Date().toISOString(), WS);
  res = await requestJson(baseUrl, 'POST', `/api/monthly/workspaces/${WS}/stages/merge`, {});
  assert.equal(res.status, 400);
  assert.equal(res.body.reason, 'deduct_value_missing');
  assert.deepEqual(res.body.details.missing_folders, ['济州新罗V团']);

  await requestJson(baseUrl, 'PUT', `/api/monthly/workspaces/${WS}/deduct-config`, {
    rows: FOLDERS.map((mode_folder) => ({ mode_folder, deduct_value: 0.01 })),
    confirm: true,
  });
  res = await requestJson(baseUrl, 'POST', `/api/monthly/workspaces/${WS}/stages/merge`, {});
  assert.equal(res.status, 400);
  assert.equal(res.body.reason, 'mode_mapping_not_confirmed');

  await requestJson(baseUrl, 'PUT', `/api/monthly/workspaces/${WS}/mode-mapping`, {
    mappings: [{ mode_raw: '其他模式', mode_folder: '乐天首尔' }],
    confirm: true,
  });
  db.prepare(`
    UPDATE monthly_workspace
    SET mode_mapping_confirmed_at = ?
    WHERE workspace_key = ?
  `).run(new Date().toISOString(), WS);
  res = await requestJson(baseUrl, 'POST', `/api/monthly/workspaces/${WS}/stages/merge`, {});
  assert.equal(res.status, 400);
  assert.equal(res.body.reason, 'mode_mapping_incomplete');
  assert.deepEqual(res.body.details.unmapped_modes, ['乐天SG-本司']);

  await requestJson(baseUrl, 'PUT', `/api/monthly/workspaces/${WS}/mode-mapping`, {
    mappings: [{ mode_raw: '乐天SG-本司', mode_folder: '乐天首尔' }],
    confirm: true,
  });
  res = await requestJson(baseUrl, 'POST', `/api/monthly/workspaces/${WS}/stages/merge`, {});
  assert.equal(res.status, 200);
  assert.equal(res.body.merged, true);
});

test('B2 phase1 t16: demo workspace config is isolated from production workspace', async (t) => {
  const { baseUrl } = await setup(t);
  await requestJson(baseUrl, 'PUT', `/api/monthly/workspaces/${WS}/deduct-config`, {
    rows: [{ mode_folder: '乐天首尔', deduct_value: 0.1234 }],
  });

  const demo = await requestJson(baseUrl, 'GET', `/api/monthly/workspaces/${WS}/deduct-config`);
  const prod = await requestJson(baseUrl, 'GET', `/api/monthly/workspaces/${PROD_WS}/deduct-config`);

  assert.equal(rowByFolder(demo.body.rows, '乐天首尔').deduct_value, 0.1234);
  assert.equal(rowByFolder(prod.body.rows, '乐天首尔').deduct_value, null);
});

async function requestJson(baseUrl, method, pathname, body = null) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

function rowByFolder(rows, folder) {
  return rows.find((r) => r.mode_folder === folder);
}

function tableExists(db, tableName) {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
  ).get(tableName));
}

function columnExists(db, tableName, columnName) {
  return db.prepare(`PRAGMA table_info('${tableName}')`).all()
    .some((row) => row.name === columnName);
}

function dailyRow(overrides = {}) {
  const modeRaw = overrides.modeRaw || '乐天SG-本司';
  const rowHash = overrides.rowHash || `daily-${modeRaw}`;
  return {
    workspaceKey: overrides.workspaceKey || WS,
    sourceCustomerId: `c-${rowHash}`,
    stmtDate: '2026-05-01',
    statementDate: '2026-05-01',
    paymentMode: 'CARD',
    modeRaw,
    modeNormalized: modeRaw,
    shop: 'THE SHILLA',
    branch: 'JEJU',
    upstream: 'UP',
    entryCompany: 'ENTRY',
    agent: 'AGENT',
    purchaseDate: '2026-05-01',
    tourNo: 'T001',
    name: 'TEST USER',
    passportNo: 'EA1234567',
    departureDate: '2026-05-02',
    receiptNo: `R-${rowHash}`,
    qty: 1,
    netUsd: 100,
    netKrw: 130000,
    customerPoints: 0.1,
    customerRebate: 10,
    storeBasePoints: 0.1,
    storeBaseRebate: 10,
    storeExtraPoints: 0,
    storeExtraAmount: 0,
    storeFinalRebate: 10,
    billMatchStatus: 'matched',
    billMatchPriority: 1,
    modeFolder: '乐天首尔',
    tourMatchStatus: 'matched',
    rowHash,
    importedAt: new Date().toISOString(),
    sourceType: 'imported',
    ledgerStatus: 'posted',
    postedAt: new Date().toISOString(),
    postedBy: 'tester',
  };
}
