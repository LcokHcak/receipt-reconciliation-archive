'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openMonthlyDatabase } = require('../../lib/storage/monthly_database');
const { calcCustomerRebate } = require('../../lib/monthly/customer_rebate_calculator');
const { createMergeStreamingService } = require('../../services/monthly/merge_streaming_service');
const { createMonthlyDataRepository } = require('../../repositories/monthly_data_repository');

const WS = '2026-01';
const FOLDER = '乐天首尔';

// ─── calculator unit tests ───────────────────────────────────────────────────

test('calcCustomerRebate — basic formula', () => {
  const result = calcCustomerRebate({
    storeBasePoints: 0.05,
    storeExtraPoints: 0.01,
    deductValue: -0.005,
    netKrw: 100000,
    netUsd: 80,
  });
  // points = 0.05 + 0.01 + (-0.005) = 0.055
  assert.equal(result.customerPoints, 0.055);
  assert.equal(result.customerRebateKrw, 5500);
  assert.equal(result.customerRebateUsd, 4.4);
});

test('calcCustomerRebate — no deduct value (null treated as 0)', () => {
  const result = calcCustomerRebate({
    storeBasePoints: 0.1,
    storeExtraPoints: 0,
    deductValue: null,
    netKrw: 200000,
    netUsd: null,
  });
  assert.equal(result.customerPoints, 0.1);
  assert.equal(result.customerRebateKrw, 20000);
  assert.equal(result.customerRebateUsd, null);
});

test('calcCustomerRebate — both storeBasePoints and storeExtraPoints null → skip formula', () => {
  const result = calcCustomerRebate({
    storeBasePoints: null,
    storeExtraPoints: null,
    deductValue: 0.01,
    netKrw: 50000,
    netUsd: 40,
  });
  assert.equal(result.customerPoints, null);
  assert.equal(result.customerRebateKrw, null);
  assert.equal(result.customerRebateUsd, null);
});

test('calcCustomerRebate — storeExtraPoints null treated as 0 when storeBasePoints present', () => {
  const result = calcCustomerRebate({
    storeBasePoints: 0.08,
    storeExtraPoints: null,
    deductValue: 0,
    netKrw: 10000,
    netUsd: 8,
  });
  assert.equal(result.customerPoints, 0.08);
  assert.equal(result.customerRebateKrw, 800);
  assert.equal(result.customerRebateUsd, 0.64);
});

test('calcCustomerRebate — negative deduct can push points below 0', () => {
  const result = calcCustomerRebate({
    storeBasePoints: 0.02,
    storeExtraPoints: 0,
    deductValue: -0.05,
    netKrw: 100000,
    netUsd: 80,
  });
  assert.equal(result.customerPoints, -0.03);
  assert.equal(result.customerRebateKrw, -3000);
  assert.equal(result.customerRebateUsd, -2.4);
});

test('calcCustomerRebate — 4 decimal precision preserved', () => {
  const result = calcCustomerRebate({
    storeBasePoints: 0.0333,
    storeExtraPoints: 0.0001,
    deductValue: null,
    netKrw: 33333,
    netUsd: null,
  });
  assert.equal(result.customerPoints, 0.0334);
  assert.ok(Number.isFinite(result.customerRebateKrw));
});

// ─── integration tests (merge service wires formula into monthly_data) ────────

async function withDb(fn) {
  const tmp = path.join(os.tmpdir(), `b2-p2-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  const db = openMonthlyDatabase({ dbPath: tmp });
  try {
    return await fn(db);
  } finally {
    try { db.close?.(); } catch { /**/ }
    try { fs.unlinkSync(tmp); } catch { /**/ }
  }
}

function stubDailyRepo(rows) {
  return {
    countByMode: () => [{ folder: FOLDER, n: rows.length }],
    listByMode: ({ limit, offset }) => rows.slice(offset, offset + limit),
    _listAll: ({ workspaceKey }) => rows.filter((r) => r.workspaceKey === workspaceKey),
  };
}

function stubBillMatchLogRepo(matched = [], unmatched = []) {
  return {
    list: ({ status, limit, offset }) => {
      const src = status === 'matched' ? matched : unmatched;
      return src.slice(offset, offset + limit);
    },
  };
}

function stubStoreBillRepo(bills) {
  const map = new Map(bills.map((b) => [Number(b.id), b]));
  return {
    iterateDetail: () => bills,
    get: (id) => map.get(Number(id)),
  };
}

function makeDeductRepo(deductValue) {
  return {
    listByWorkspace: () => [{ modeFolder: FOLDER, deductValue }],
  };
}

function makeMappingRepo(entries = []) {
  return {
    listByWorkspace: () => entries,
  };
}

function makeWorkspaceRepo(ws = null) {
  return {
    findByKey: () => ws,
  };
}

test('merge service — formula applied: customerRebateKrw written to monthly_data', async () => {
  await withDb(async (db) => {
    const monthlyDataRepo = createMonthlyDataRepository({ db });

    const row = {
      id: 1, workspaceKey: WS, modeFolder: FOLDER, ledgerStatus: 'posted',
      storeBasePoints: 0.05, storeExtraPoints: 0.01,
      netKrw: 100000, netUsd: 80,
      receiptNo: 'R001', name: 'TEST USER', passportNo: 'PA001', purchaseDate: '2026-01-15',
    };
    const bill = { id: 99, mode: '乐天SG', storeFamily: '乐天', storeBranch: '首尔' };

    const svc = createMergeStreamingService({
      dailyReceiptRepo: stubDailyRepo([row]),
      billMatchLogRepo: stubBillMatchLogRepo(
        [{ dailyReceiptId: 1, storeBillId: 99 }],
        []
      ),
      monthlyDataRepo,
      storeBillRepo: stubStoreBillRepo([bill]),
      modeDeductConfigRepo: makeDeductRepo(-0.005),
      modeFolderMappingRepo: makeMappingRepo(),
      workspaceRepo: makeWorkspaceRepo({ deductConfigConfirmedAt: '2026-05-20', modeMappingConfirmedAt: '2026-05-20' }),
    });

    await svc.run({ workspaceKey: WS });

    const rows = db.prepare('SELECT * FROM monthly_data WHERE workspace_key = ?').all(WS);
    assert.equal(rows.length, 1);
    // points = 0.05 + 0.01 + (-0.005) = 0.055
    assert.equal(rows[0].customer_rebate_krw, 5500);
    assert.equal(rows[0].customer_rebate_usd, 4.4);
  });
});

test('merge service — customerRebate mirrors customerRebateKrw (dual-write)', async () => {
  await withDb(async (db) => {
    const monthlyDataRepo = createMonthlyDataRepository({ db });

    const row = {
      id: 1, workspaceKey: WS, modeFolder: FOLDER, ledgerStatus: 'posted',
      storeBasePoints: 0.1, storeExtraPoints: 0,
      netKrw: 50000, netUsd: 40,
      receiptNo: 'R002', name: 'B', passportNo: 'PB', purchaseDate: '2026-01-16',
    };
    const bill = { id: 10, mode: null };

    const svc = createMergeStreamingService({
      dailyReceiptRepo: stubDailyRepo([row]),
      billMatchLogRepo: stubBillMatchLogRepo([{ dailyReceiptId: 1, storeBillId: 10 }], []),
      monthlyDataRepo,
      storeBillRepo: stubStoreBillRepo([bill]),
      modeDeductConfigRepo: makeDeductRepo(null),
      modeFolderMappingRepo: makeMappingRepo(),
      workspaceRepo: makeWorkspaceRepo(null),
    });

    await svc.run({ workspaceKey: WS });

    const r = db.prepare('SELECT * FROM monthly_data WHERE workspace_key = ?').get(WS);
    assert.equal(r.customer_rebate, r.customer_rebate_krw, 'customer_rebate should mirror KRW');
    assert.equal(r.customer_rebate_krw, 5000);
  });
});

test('merge service — unmatched bill row has null KRW and USD rebates', async () => {
  await withDb(async (db) => {
    const monthlyDataRepo = createMonthlyDataRepository({ db });

    const bill = { id: 200, mode: '乐天SG', storeFamily: '乐天', storeBranch: '首尔', netKrw: 80000, netUsd: 60 };

    const svc = createMergeStreamingService({
      dailyReceiptRepo: stubDailyRepo([]),
      billMatchLogRepo: stubBillMatchLogRepo([], [{ storeBillId: 200 }]),
      monthlyDataRepo,
      storeBillRepo: stubStoreBillRepo([bill]),
      modeDeductConfigRepo: makeDeductRepo(0.05),
      modeFolderMappingRepo: makeMappingRepo([{ modeRaw: '乐天SG', modeFolder: FOLDER }]),
      workspaceRepo: makeWorkspaceRepo(null),
    });

    await svc.run({ workspaceKey: WS });

    const r = db.prepare('SELECT * FROM monthly_data WHERE workspace_key = ? AND is_unmatched = 1').get(WS);
    assert.ok(r, 'unmatched bill row should be inserted');
    assert.equal(r.customer_rebate_krw, null);
    assert.equal(r.customer_rebate_usd, null);
  });
});

test('merge service — mergeConfigVersion written to monthly_data', async () => {
  await withDb(async (db) => {
    const monthlyDataRepo = createMonthlyDataRepository({ db });

    const row = {
      id: 1, workspaceKey: WS, modeFolder: FOLDER, ledgerStatus: 'posted',
      storeBasePoints: 0.05, storeExtraPoints: 0,
      netKrw: 10000, netUsd: 8,
      receiptNo: 'RV', name: 'V', passportNo: 'PV', purchaseDate: '2026-01-10',
    };

    const svc = createMergeStreamingService({
      dailyReceiptRepo: stubDailyRepo([row]),
      billMatchLogRepo: stubBillMatchLogRepo([{ dailyReceiptId: 1, storeBillId: 5 }], []),
      monthlyDataRepo,
      storeBillRepo: stubStoreBillRepo([{ id: 5, mode: null }]),
      modeDeductConfigRepo: makeDeductRepo(0),
      modeFolderMappingRepo: makeMappingRepo(),
      workspaceRepo: makeWorkspaceRepo({
        deductConfigConfirmedAt: '2026-05-20T10:00:00.000Z',
        modeMappingConfirmedAt: '2026-05-19T08:00:00.000Z',
      }),
    });

    await svc.run({ workspaceKey: WS });

    const r = db.prepare('SELECT merge_config_version FROM monthly_data WHERE workspace_key = ?').get(WS);
    assert.equal(
      r.merge_config_version,
      'deduct=2026-05-20T10:00:00.000Z|mapping=2026-05-19T08:00:00.000Z'
    );
  });
});

test('merge service — no repos provided → deductMap empty, formula skipped (null points)', async () => {
  await withDb(async (db) => {
    const monthlyDataRepo = createMonthlyDataRepository({ db });

    const row = {
      id: 1, workspaceKey: WS, modeFolder: FOLDER, ledgerStatus: 'posted',
      storeBasePoints: null, storeExtraPoints: null,
      netKrw: 10000, netUsd: 8,
      receiptNo: 'RN', name: 'N', passportNo: 'PN', purchaseDate: '2026-01-11',
    };

    const svc = createMergeStreamingService({
      dailyReceiptRepo: stubDailyRepo([row]),
      billMatchLogRepo: stubBillMatchLogRepo([{ dailyReceiptId: 1, storeBillId: 3 }], []),
      monthlyDataRepo,
      storeBillRepo: stubStoreBillRepo([{ id: 3, mode: null }]),
      // intentionally no deductConfigRepo / mappingRepo / workspaceRepo
    });

    await svc.run({ workspaceKey: WS });

    const r = db.prepare('SELECT * FROM monthly_data WHERE workspace_key = ?').get(WS);
    assert.equal(r.customer_rebate_krw, null);
    assert.equal(r.customer_rebate_usd, null);
    assert.equal(r.merge_config_version, null);
  });
});

test('merge service — mappingMap lookup takes precedence over classifyBillFolder heuristic', async () => {
  await withDb(async (db) => {
    const monthlyDataRepo = createMonthlyDataRepository({ db });

    const bill = { id: 77, mode: 'CUSTOM_MODE', storeFamily: null, storeBranch: null };
    const row = {
      id: 1, workspaceKey: WS, modeFolder: null, ledgerStatus: 'posted',
      storeBasePoints: 0.04, storeExtraPoints: 0,
      netKrw: 20000, netUsd: 15,
      receiptNo: 'RM', name: 'M', passportNo: 'PM', purchaseDate: '2026-01-12',
    };

    const svc = createMergeStreamingService({
      dailyReceiptRepo: stubDailyRepo([row]),
      billMatchLogRepo: stubBillMatchLogRepo([{ dailyReceiptId: 1, storeBillId: 77 }], []),
      monthlyDataRepo,
      storeBillRepo: stubStoreBillRepo([bill]),
      modeDeductConfigRepo: makeDeductRepo(0),
      modeFolderMappingRepo: makeMappingRepo([{ modeRaw: 'CUSTOM_MODE', modeFolder: FOLDER }]),
      workspaceRepo: makeWorkspaceRepo(null),
    });

    await svc.run({ workspaceKey: WS });

    const r = db.prepare('SELECT mode_folder FROM monthly_data WHERE workspace_key = ?').get(WS);
    assert.equal(r.mode_folder, FOLDER, 'custom mode should resolve via mappingMap');
  });
});

test('merge service — deleteByWorkspace called before insert (idempotent rebuild)', async () => {
  await withDb(async (db) => {
    const monthlyDataRepo = createMonthlyDataRepository({ db });

    // Pre-seed a stale row
    db.exec(`INSERT INTO monthly_data (workspace_key, mode_folder, is_unmatched, daily_receipt_id,
      store_bill_id, row_hash, created_at, updated_at)
      VALUES ('${WS}', '${FOLDER}', 0, 999, 888, 'stale-hash', '2026-01-01', '2026-01-01')`);
    assert.equal(monthlyDataRepo.countByWorkspace(WS), 1);

    const svc = createMergeStreamingService({
      dailyReceiptRepo: stubDailyRepo([]),
      billMatchLogRepo: stubBillMatchLogRepo([], []),
      monthlyDataRepo,
      // no storeBillRepo → fallback path, 0 rows after delete
    });

    await svc.run({ workspaceKey: WS });

    assert.equal(monthlyDataRepo.countByWorkspace(WS), 0, 'stale row should be deleted');
  });
});

test('merge service — fallback path (no storeBillRepo) still applies formula', async () => {
  await withDb(async (db) => {
    const monthlyDataRepo = createMonthlyDataRepository({ db });

    const row = {
      id: 1, workspaceKey: WS, modeFolder: FOLDER, ledgerStatus: 'posted',
      storeBasePoints: 0.06, storeExtraPoints: 0.02,
      netKrw: 100000, netUsd: 80,
      receiptNo: 'RF', name: 'F', passportNo: 'PF', purchaseDate: '2026-01-13',
    };

    const svc = createMergeStreamingService({
      dailyReceiptRepo: stubDailyRepo([row]),
      billMatchLogRepo: stubBillMatchLogRepo([], []),
      monthlyDataRepo,
      // no storeBillRepo
      modeDeductConfigRepo: makeDeductRepo(0),
      modeFolderMappingRepo: makeMappingRepo(),
      workspaceRepo: makeWorkspaceRepo(null),
    });

    await svc.run({ workspaceKey: WS });

    const r = db.prepare('SELECT * FROM monthly_data WHERE workspace_key = ?').get(WS);
    // points = 0.06 + 0.02 + 0 = 0.08
    assert.equal(r.customer_rebate_krw, 8000);
    assert.equal(r.customer_rebate_usd, 6.4);
  });
});

test('calcCustomerRebate — storeBasePoints only (storeExtraPoints 0)', () => {
  const result = calcCustomerRebate({
    storeBasePoints: 0.07,
    storeExtraPoints: 0,
    deductValue: 0,
    netKrw: 300000,
    netUsd: 240,
  });
  assert.equal(result.customerPoints, 0.07);
  assert.equal(result.customerRebateKrw, 21000);
  assert.equal(result.customerRebateUsd, 16.8);
});

test('calcCustomerRebate — zero net values produce zero rebate (not null)', () => {
  const result = calcCustomerRebate({
    storeBasePoints: 0.05,
    storeExtraPoints: 0,
    deductValue: null,
    netKrw: 0,
    netUsd: 0,
  });
  assert.equal(result.customerRebateKrw, 0);
  assert.equal(result.customerRebateUsd, 0);
});

test('calcCustomerRebate — large values stay within 4 decimal places', () => {
  const result = calcCustomerRebate({
    storeBasePoints: 0.0333,
    storeExtraPoints: 0.0001,
    deductValue: -0.0002,
    netKrw: 9999999,
    netUsd: null,
  });
  const decimals = (result.customerRebateKrw.toString().split('.')[1] || '').length;
  assert.ok(decimals <= 4, `expected ≤4 decimals, got ${decimals}`);
});

test('calcCustomerRebate — netUsd null means USD rebate null while KRW computed', () => {
  const result = calcCustomerRebate({
    storeBasePoints: 0.05,
    storeExtraPoints: 0,
    deductValue: null,
    netKrw: 50000,
    netUsd: null,
  });
  assert.equal(result.customerRebateKrw, 2500);
  assert.equal(result.customerRebateUsd, null);
});

test('merge service — multiple folders each use their own deductValue', async () => {
  await withDb(async (db) => {
    const monthlyDataRepo = createMonthlyDataRepository({ db });

    const folder2 = '爱宝客';
    const row1 = {
      id: 1, workspaceKey: WS, modeFolder: FOLDER, ledgerStatus: 'posted',
      storeBasePoints: 0.05, storeExtraPoints: 0,
      netKrw: 100000, netUsd: 80,
      receiptNo: 'R-F1', name: 'A', passportNo: 'PA', purchaseDate: '2026-01-15',
    };
    const row2 = {
      id: 2, workspaceKey: WS, modeFolder: folder2, ledgerStatus: 'posted',
      storeBasePoints: 0.05, storeExtraPoints: 0,
      netKrw: 100000, netUsd: 80,
      receiptNo: 'R-F2', name: 'B', passportNo: 'PB', purchaseDate: '2026-01-15',
    };

    const multiDeductRepo = {
      listByWorkspace: () => [
        { modeFolder: FOLDER, deductValue: 0.01 },
        { modeFolder: folder2, deductValue: -0.01 },
      ],
    };

    const twoFolderDailyRepo = {
      countByMode: () => [
        { folder: FOLDER, n: 1 },
        { folder: folder2, n: 1 },
      ],
      listByMode: ({ modeFolder, limit, offset }) =>
        (modeFolder === FOLDER ? [row1] : [row2]).slice(offset, offset + limit),
      _listAll: () => [row1, row2],
    };

    const svc = createMergeStreamingService({
      dailyReceiptRepo: twoFolderDailyRepo,
      billMatchLogRepo: stubBillMatchLogRepo([], []),
      monthlyDataRepo,
      modeDeductConfigRepo: multiDeductRepo,
      modeFolderMappingRepo: makeMappingRepo(),
      workspaceRepo: makeWorkspaceRepo(null),
    });

    await svc.run({ workspaceKey: WS });

    const r1 = db.prepare('SELECT customer_rebate_krw FROM monthly_data WHERE receipt_no = ?').get('R-F1');
    const r2 = db.prepare('SELECT customer_rebate_krw FROM monthly_data WHERE receipt_no = ?').get('R-F2');
    // FOLDER: points = 0.05 + 0.01 = 0.06 → 6000
    assert.equal(r1.customer_rebate_krw, 6000);
    // folder2: points = 0.05 + (-0.01) = 0.04 → 4000
    assert.equal(r2.customer_rebate_krw, 4000);
  });
});
