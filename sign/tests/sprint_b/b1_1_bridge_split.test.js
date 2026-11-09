'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openMonthlyDatabase } = require('../../lib/storage/monthly_database');
const { createDailyReceiptRepository } = require('../../repositories/daily_receipt_repository');
const { createMonthlyWorkspaceRepository } = require('../../repositories/monthly_workspace_repository');
const { createModeDeductConfigRepository } = require('../../repositories/monthly/mode_deduct_config_repo');
const { createModeFolderMappingRepository } = require('../../repositories/monthly/mode_folder_mapping_repo');
const { createMonthlyWorkspaceService } = require('../../services/monthly/workspace_service');
const { createTourMatchService } = require('../../services/monthly/tour_match_service');
const { createWorkbenchBatchLedgerImportService } = require('../../services/workbench_batch_ledger_import_service');
const { createWorkbenchLedgerBridgeService } = require('../../services/workbench_ledger_bridge_service');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b1-bridge-split-'));
  const db = openMonthlyDatabase({ dbPath: path.join(dir, 'monthly.sqlite') });
  const workspaceRepo = createMonthlyWorkspaceRepository({ db });
  const workspaceService = createMonthlyWorkspaceService({ workspaceRepo });
  workspaceService.open({ workspaceKey: 'demo-2026-05', operator: 'test' });
  const dailyReceiptRepo = createDailyReceiptRepository({ db });
  const bridgeService = createWorkbenchLedgerBridgeService({
    dailyReceiptRepo,
    workspaceService,
    logger: { log() {}, error() {} },
  });
  const tourMatchService = createTourMatchService({
    dailyReceiptRepo,
    groupCodeRepo: {
      findByTour() {
        throw new Error('date_missing rows must not reach tour matching');
      },
    },
    pendingReviewRepo: { insertMany() { return { inserted: 0, skipped: 0 }; } },
  });
  t.after(() => {
    try { db.close?.(); } catch {
      // intentional: best-effort cleanup
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    db,
    workspaceRepo,
    workspaceService,
    dailyReceiptRepo,
    bridgeService,
    tourMatchService,
    modeDeductRepo: createModeDeductConfigRepository({ db }),
    modeMappingRepo: createModeFolderMappingRepository({ db }),
  };
}

function passport(overrides = {}) {
  return {
    id: `p-${Math.random()}`,
    docTypeFinal: 'passport',
    sourceGroupKey: 'g1',
    reviewed: true,
    extractedNameFinal: 'ZHANG LIYA',
    chineseNameFinal: 'ZHANG CN',
    passportNoFinal: 'EG8761171',
    ...overrides,
  };
}

function receipt(id, purchaseDateFinal, overrides = {}) {
  return {
    id,
    docTypeFinal: 'receipt',
    sourceGroupKey: 'g1',
    reviewed: true,
    receiptStoreFinal: 'THE SHILLA',
    receiptNoFinal: `0326155300${String(id).replace(/\D/g, '').padStart(3, '0')}`,
    groupNoFinal: '71990',
    purchaseDateFinal,
    departureDateFinal: '2026-06-01',
    ...overrides,
  };
}

async function sync(ctx, groupTasks, workspaceKey = 'demo-2026-05') {
  return ctx.bridgeService.syncApprovedGroup({
    batchId: 'batch_b1',
    workspaceKey,
    operator: 'reviewer1',
    groupTasks,
  });
}

function rows(ctx, workspaceKey) {
  return ctx.dailyReceiptRepo._listAll({ workspaceKey });
}

test('B1.1 t1: same-month receipts all enter the requested demo workspace', async (t) => {
  const ctx = setup(t);
  const result = await sync(ctx, [
    passport(),
    receipt('r1', '2026-05-01'),
    receipt('r2', '2026-05-02'),
    receipt('r3', '2026-05-03'),
  ]);

  assert.deepEqual(result.affectedWorkspaces, ['demo-2026-05']);
  assert.equal(rows(ctx, 'demo-2026-05').length, 3);
});

test('B1.1 t2: one customer group can split into two target workspaces', async (t) => {
  const ctx = setup(t);
  const result = await sync(ctx, [
    passport(),
    receipt('r1', '2026-04-30'),
    receipt('r2', '2026-05-01'),
    receipt('r3', '2026-05-02'),
  ]);

  assert.deepEqual(result.affectedWorkspaces.sort(), ['demo-2026-04', 'demo-2026-05']);
  assert.equal(rows(ctx, 'demo-2026-04').length, 1);
  assert.equal(rows(ctx, 'demo-2026-05').length, 2);
});

test('B1.1 t3: one customer group can split into three target workspaces', async (t) => {
  const ctx = setup(t);
  const result = await sync(ctx, [
    passport(),
    receipt('r1', '2026-04-30'),
    receipt('r2', '2026-05-01'),
    receipt('r3', '2026-06-01'),
  ]);

  assert.deepEqual(result.affectedWorkspaces.sort(), ['demo-2026-04', 'demo-2026-05', 'demo-2026-06']);
  assert.equal(rows(ctx, 'demo-2026-04').length, 1);
  assert.equal(rows(ctx, 'demo-2026-05').length, 1);
  assert.equal(rows(ctx, 'demo-2026-06').length, 1);
});

test('B1.1 t4: missing purchase dates stay in requested workspace and keep posted ledger status', async (t) => {
  const ctx = setup(t);
  const result = await sync(ctx, [passport(), receipt('r1', '')]);
  const [row] = rows(ctx, 'demo-2026-05');

  assert.deepEqual(result.affectedWorkspaces, ['demo-2026-05']);
  assert.equal(row.purchaseDate, null);
  assert.equal(row.tourMatchStatus, 'date_missing');
  assert.equal(row.ledgerStatus, 'posted');
  assert.equal(row.remedyReason, null);
});

test('B1.1 t5: mixed missing and dated receipts split correctly', async (t) => {
  const ctx = setup(t);
  const result = await sync(ctx, [
    passport(),
    receipt('r1', '2026-04-15'),
    receipt('r2', ''),
  ]);

  assert.deepEqual(result.affectedWorkspaces.sort(), ['demo-2026-04', 'demo-2026-05']);
  assert.equal(rows(ctx, 'demo-2026-04')[0].tourMatchStatus, 'pending');
  const missing = rows(ctx, 'demo-2026-05')[0];
  assert.equal(missing.tourMatchStatus, 'date_missing');
  assert.equal(missing.ledgerStatus, 'posted');
  assert.equal(missing.remedyReason, null);
});

test('B1.1 t6: target month is auto-opened when the monthly workspace does not exist', async (t) => {
  const ctx = setup(t);
  await sync(ctx, [passport(), receipt('r1', '2026-04-15')]);

  assert.ok(ctx.workspaceRepo.findByKey('demo-2026-04'));
});

test('B1.1 t7: auto-opened target month does not copy financial config', async (t) => {
  const ctx = setup(t);
  await sync(ctx, [passport(), receipt('r1', '2026-04-15')]);

  assert.deepEqual(ctx.modeDeductRepo.listByWorkspace('demo-2026-04'), []);
  assert.deepEqual(ctx.modeMappingRepo.listByWorkspace('demo-2026-04'), []);
});

test('B1.1 t8: out-of-range purchase date fails before any row is written', async (t) => {
  const ctx = setup(t);
  await assert.rejects(
    () => sync(ctx, [
      passport(),
      receipt('r1', '2026-05-01'),
      receipt('r2', '2018-01-15', {
        sourceGroupLabel: '兜兜',
        receiptNoFinal: '90176326000330',
        fileName: 'bad-receipt.jpg',
      }),
    ]),
    (err) => err.status === 400
      && err.code === 'purchase_date_out_of_range'
      && err.message.includes('客户组 兜兜')
      && err.message.includes('task r2')
      && err.message.includes('小票号 90176326000330')
      && err.message.includes('文件 bad-receipt.jpg')
      // A 方案:结构化定位信息(供前端渲染"跳到该图"链接)
      && err.details
      && err.details.taskId === 'r2'
      && err.details.fileName === 'bad-receipt.jpg'
      && err.details.reason === 'purchase_date_out_of_range'
  );

  assert.equal(rows(ctx, 'demo-2026-05').length, 0);
  assert.equal(rows(ctx, 'demo-2018-01').length, 0);
});

test('B1.1 t9: batch ledger import runs tour_match once per affected workspace', async () => {
  const tourCalls = [];
  const service = createWorkbenchBatchLedgerImportService({
    ledgerBridgeService: {
      async syncApprovedGroup() {
        return {
          workspaceKey: 'demo-2026-04',
          affectedWorkspaces: ['demo-2026-04', 'demo-2026-05'],
          inserted: 2,
          skipped: 0,
        };
      },
    },
    tourMatchService: {
      async run(args) {
        tourCalls.push(args);
        return { scanned: 0, matched: 0 };
      },
    },
  });
  const batch = {
    id: 'batch_b1',
    monthlyWorkspaceKey: 'demo-2026-05',
    tasks: [
      passport({ id: 'p1', sourceGroupKey: 'g1' }),
      receipt('r1', '2026-04-15', { sourceGroupKey: 'g1' }),
    ],
  };

  const result = await service.importBatchToLedger({ batch, operator: 'reviewer1' });

  assert.deepEqual(result.affectedWorkspaces, ['demo-2026-04', 'demo-2026-05']);
  assert.deepEqual(tourCalls.map((call) => call.workspaceKey), ['demo-2026-04', 'demo-2026-05']);
  assert.equal(result.tourMatchResults.length, 2);
  assert.deepEqual(result.tourMatch, result.tourMatchResults[0]);
});

test('B1.1 t10: date_missing rows are skipped by tour_match because only pending is scanned', async (t) => {
  const ctx = setup(t);
  await sync(ctx, [passport(), receipt('r1', '')]);
  const before = rows(ctx, 'demo-2026-05')[0];
  const result = await ctx.tourMatchService.run({ workspaceKey: 'demo-2026-05' });
  const after = rows(ctx, 'demo-2026-05')[0];

  assert.equal(result.scanned, 0);
  assert.equal(before.tourMatchStatus, 'date_missing');
  assert.equal(after.tourMatchStatus, 'date_missing');
});

test('B1.1 t11: customer identity is copied to every cross-month receipt row', async (t) => {
  const ctx = setup(t);
  await sync(ctx, [
    passport({ extractedNameFinal: 'LI HUA', passportNoFinal: 'EP1111111' }),
    receipt('r1', '2026-04-15', { departureDateFinal: '2026-04-20' }),
    receipt('r2', '2026-05-15', { departureDateFinal: '2026-04-20' }),
  ]);

  for (const row of [rows(ctx, 'demo-2026-04')[0], rows(ctx, 'demo-2026-05')[0]]) {
    assert.equal(row.name, 'LI HUA');
    assert.equal(row.passportNo, 'EP1111111');
    assert.equal(row.departureDate, '2026-04-20');
  }
});

test('B1.1 t12: bridge-created rows start with no manual locked fields', async (t) => {
  const ctx = setup(t);
  await sync(ctx, [passport(), receipt('r1', '2026-05-15')]);
  assert.equal(rows(ctx, 'demo-2026-05')[0].manualLockedFields, null);
});

test('B1.1 t13: demo requested workspace keeps cross-month rows in demo workspaces', async (t) => {
  const ctx = setup(t);
  await sync(ctx, [passport(), receipt('r1', '2026-04-15')], 'demo-2026-05');

  assert.equal(rows(ctx, 'demo-2026-04').length, 1);
  assert.equal(rows(ctx, '2026-04').length, 0);
});
