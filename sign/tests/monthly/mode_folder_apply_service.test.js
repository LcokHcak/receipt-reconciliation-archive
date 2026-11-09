'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openMonthlyDatabase } = require('../../lib/storage/monthly_database');
const { MODE_TO_FOLDER } = require('../../lib/monthly_pipeline/mode_folder_classifier');
const { createDailyReceiptRepository } = require('../../repositories/daily_receipt_repository');
const { createModeFolderMappingRepository } = require('../../repositories/monthly/mode_folder_mapping_repo');
const { createModeFolderApplyService } = require('../../services/monthly/mode_folder_apply_service');

const WS = 'demo-2026-05';
const MODE_A = Object.keys(MODE_TO_FOLDER)[0];
const MODE_B = Object.keys(MODE_TO_FOLDER)[1];
const FOLDER_A = MODE_TO_FOLDER[MODE_A];
const FOLDER_B = MODE_TO_FOLDER[MODE_B];

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mode-folder-apply-'));
  const db = openMonthlyDatabase({ dbPath: path.join(dir, 'monthly.sqlite') });
  const dailyReceiptRepo = createDailyReceiptRepository({ db });
  const modeFolderMappingRepo = createModeFolderMappingRepository({ db });
  const service = createModeFolderApplyService({ dailyReceiptRepo, modeFolderMappingRepo });

  t.after(() => {
    try { db.close?.(); } catch {
      // intentional: best-effort cleanup
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  return { db, dailyReceiptRepo, modeFolderMappingRepo, service };
}

test('G14 mode folder apply updates all daily rows from saved mappings', (t) => {
  const { dailyReceiptRepo, modeFolderMappingRepo, service } = setup(t);
  dailyReceiptRepo.insertMany([
    dailyRow({ modeRaw: MODE_A, modeFolder: null, rowHash: 'g14-a' }),
    dailyRow({ modeRaw: MODE_B, modeFolder: null, rowHash: 'g14-b' }),
  ]);
  modeFolderMappingRepo.upsertRows({
    workspaceKey: WS,
    rows: [
      { modeRaw: MODE_A, modeFolder: FOLDER_A },
      { modeRaw: MODE_B, modeFolder: FOLDER_B },
    ],
    updatedAt: new Date().toISOString(),
  });

  const result = service.applyToWorkspace(WS);

  assert.equal(result.totalScanned, 2);
  assert.equal(result.updated, 2);
  assert.deepEqual(
    dailyReceiptRepo.listForModeFolderRefresh(WS).map((row) => row.modeFolder),
    [FOLDER_A, FOLDER_B],
  );
});

test('G14 mode folder apply leaves blank mode_raw rows unchanged and counts them', (t) => {
  const { dailyReceiptRepo, service } = setup(t);
  dailyReceiptRepo.insertMany([
    dailyRow({ modeRaw: '', modeFolder: null, rowHash: 'g14-blank' }),
    dailyRow({ modeRaw: MODE_A, modeFolder: FOLDER_A, rowHash: 'g14-unchanged' }),
  ]);

  const result = service.applyToWorkspace(WS);

  assert.equal(result.totalScanned, 2);
  assert.equal(result.blank, 1);
  assert.equal(result.updated, 0);
  assert.equal(result.unchanged, 2);
});

test('G14 explicit empty mapping clears existing daily mode_folder', (t) => {
  const { dailyReceiptRepo, modeFolderMappingRepo, service } = setup(t);
  dailyReceiptRepo.insertMany([
    dailyRow({ modeRaw: MODE_A, modeFolder: FOLDER_A, rowHash: 'g14-clear' }),
  ]);
  modeFolderMappingRepo.upsertRows({
    workspaceKey: WS,
    rows: [{ modeRaw: MODE_A, modeFolder: null }],
    updatedAt: new Date().toISOString(),
  });

  const result = service.applyToWorkspace(WS);

  assert.equal(result.updated, 1);
  assert.equal(dailyReceiptRepo.listForModeFolderRefresh(WS)[0].modeFolder, null);
});

test('G14 updateModeFolderBulk rolls back partial writes on failure', (t) => {
  const { db, dailyReceiptRepo } = setup(t);
  dailyReceiptRepo.insertMany([
    dailyRow({ modeRaw: MODE_A, modeFolder: null, rowHash: 'g14-rollback-a' }),
    dailyRow({ modeRaw: MODE_B, modeFolder: null, rowHash: 'g14-rollback-b' }),
  ]);
  db.exec(`
    CREATE TRIGGER g14_fail_mode_folder
    BEFORE UPDATE OF mode_folder ON daily_receipt_export
    WHEN NEW.mode_folder = 'FAIL'
    BEGIN
      SELECT RAISE(FAIL, 'forced mode folder failure');
    END;
  `);

  assert.throws(() => dailyReceiptRepo.updateModeFolderBulk({
    workspaceKey: WS,
    updates: [
      { id: 1, modeFolder: FOLDER_A },
      { id: 2, modeFolder: 'FAIL' },
    ],
  }), /forced mode folder failure/);

  assert.deepEqual(
    dailyReceiptRepo.listForModeFolderRefresh(WS).map((row) => row.modeFolder),
    [null, null],
  );
});

function dailyRow({ modeRaw, modeFolder, rowHash }) {
  return {
    workspaceKey: WS,
    modeRaw,
    modeFolder,
    receiptNo: rowHash,
    purchaseDate: '2026-05-10',
    shop: 'shop',
    rowHash,
    importedAt: '2026-05-10T00:00:00.000Z',
    sourceType: 'imported',
  };
}

test('百货P4:matched 的百货行不被"模式归类"确认打回 skipped(僵尸行复活防线)', (t) => {
  const { dailyReceiptRepo, service } = setup(t);
  dailyReceiptRepo.insertMany([
    // 百货行:桥接直标 matched,模式=店名常量(无 mapping、classifier 也认不出 → nextFolder=null)
    { ...dailyRow({ modeRaw: '乐天百货', modeFolder: null, rowHash: 'dept-1' }), tourMatchStatus: 'matched' },
    // 对照:非百货 matched 行无归类 → 照旧退回 skipped(原互转行为不变)
    { ...dailyRow({ modeRaw: '乐天R团', modeFolder: null, rowHash: 'df-1' }), tourMatchStatus: 'matched' },
  ]);

  const result = service.applyToWorkspace(WS);

  const rows = dailyReceiptRepo._listAll({ workspaceKey: WS });
  const dept = rows.find((r) => r.rowHash === 'dept-1');
  const df = rows.find((r) => r.rowHash === 'df-1');
  assert.equal(dept.tourMatchStatus, 'matched', '百货行必须保持 matched');
  assert.equal(dept.modeRaw, '乐天百货');
  assert.equal(df.tourMatchStatus, 'skipped_mode_not_required', '非百货互转行为不变');
  assert.ok(result.statusDemoted >= 1);
});
