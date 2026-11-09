'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { runMigrations } = require('../../lib/storage/migration_runner');
const { createBrandActivityRepository } = require('../../repositories/brand_activity_repository');
const { createDailyReceiptRepository } = require('../../repositories/daily_receipt_repository');
const { createStoreBillRepository } = require('../../repositories/store_bill_repository');
const { createBillMatchLogRepository } = require('../../repositories/bill_match_log_repository');
const { createMonthlyDataRepository } = require('../../repositories/monthly_data_repository');
const { createMergeStreamingService } = require('../../services/monthly/merge_streaming_service');
const { createFinalDeliveryExportService } = require('../../services/monthly/final_delivery_export_service');
const { mapBrandActivityRow, isBrandActivityRow } = require('../../lib/monthly_pipeline/bill_mapper');

const MIGRATIONS = path.join(__dirname, '..', '..', 'lib', 'storage', 'migrations');
const WS = '2026-02';

function makeDb() {
  const db = new DatabaseSync(':memory:');
  runMigrations(db, MIGRATIONS, { logger: { info() {}, warn() {}, error() {} } });
  db.exec(`INSERT INTO monthly_workspace (workspace_key, year, month, status, created_at, updated_at)
           VALUES ('${WS}', 2026, 2, 'open', 't', 't')`);
  return db;
}

const brandRaw = {
  '返点模式': '品牌活动', '免税店': '乐天', '免税分店': '乐天明洞',
  '护照号': 'EK1948532', '姓名': 'WEN', '品牌': 'QEELIN',
  '购买日期': '2026-02-01', '纯卖出(￦)': '2854000', '客人点数': '0.015', '客人返点金额': '42810',
};

test('isBrandActivityRow 识别品牌活动/限时活动,不误伤普通账单', () => {
  assert.equal(isBrandActivityRow(brandRaw), true);
  assert.equal(isBrandActivityRow({ '返点模式': '限时活动', '护照号': 'X' }), true);
  assert.equal(isBrandActivityRow({ '返点模式': '乐天SG-本司', '护照号': 'X' }), false);
  assert.equal(isBrandActivityRow({ '护照号': 'X' }), false);
});

test('mapBrandActivityRow 归乐天首尔、抓返点、无小票号', () => {
  const m = mapBrandActivityRow({ asObject: brandRaw, workspaceKey: WS, sheetName: 'Sheet1', sourceFile: 'b', sourceRow: 2, importedAt: 't' });
  assert.equal(m.modeFolder, '乐天首尔');
  assert.equal(m.passportNo, 'EK1948532');
  assert.equal(m.rebateAmount, 42810);
  assert.equal(m.netKrw, 2854000);
  assert.equal(m.mode, '品牌活动');
  assert.ok(m.rowHash);
});

test('brand_activity 仓库:插入/去重/汇总', () => {
  const db = makeDb();
  const repo = createBrandActivityRepository({ db });
  const r1 = mapBrandActivityRow({ asObject: brandRaw, workspaceKey: WS, sheetName: 'S', sourceFile: 'b', sourceRow: 2, importedAt: 't' });
  const r2 = mapBrandActivityRow({ asObject: { ...brandRaw, '护照号': 'EQ0368528', '客人返点金额': '-1000' }, workspaceKey: WS, sheetName: 'S', sourceFile: 'b', sourceRow: 3, importedAt: 't' });
  const res = repo.insertMany([r1, r2]);
  assert.equal(res.inserted, 2);
  // 重复插入 r1 → 去重
  assert.equal(repo.insertMany([r1]).inserted, 0);
  assert.equal(repo.countByWorkspace(WS), 2);
  const s = repo.summary(WS);
  assert.equal(s.rows, 2);
  assert.equal(s.rebateTotal, 41810); // 42810 + (-1000)
  assert.equal(s.negativeRows, 1);
});

test('流式 merge 把品牌活动折进乐天首尔交付(含负数冲减)', () => {
  const db = makeDb();
  const brandRepo = createBrandActivityRepository({ db });
  brandRepo.insertMany([
    mapBrandActivityRow({ asObject: brandRaw, workspaceKey: WS, sheetName: 'S', sourceFile: 'b', sourceRow: 2, importedAt: 't' }),
    mapBrandActivityRow({ asObject: { ...brandRaw, '护照号': 'P-NEG', '客人返点金额': '-1500' }, workspaceKey: WS, sheetName: 'S', sourceFile: 'b', sourceRow: 3, importedAt: 't' }),
  ]);

  const merge = createMergeStreamingService({
    db,
    dailyReceiptRepo: createDailyReceiptRepository({ db }),
    billMatchLogRepo: createBillMatchLogRepository({ db }),
    monthlyDataRepo: createMonthlyDataRepository({ db }),
    storeBillRepo: createStoreBillRepository({ db }),
    brandActivityRepo: brandRepo,
  });

  return merge.run({ workspaceKey: WS }).then((stats) => {
    assert.equal(stats.brandActivity, 2, '2 条品牌活动折入');
    const rows = db.prepare("SELECT mode_folder, mode_raw, is_brand_activity, customer_rebate_krw, store_bill_id FROM monthly_data WHERE workspace_key=? AND is_brand_activity=1 ORDER BY customer_rebate_krw DESC").all(WS);
    assert.equal(rows.length, 2);
    for (const r of rows) {
      assert.equal(r.mode_folder, '乐天首尔');
      assert.equal(r.mode_raw, '品牌活动');
      assert.equal(r.is_brand_activity, 1);
      assert.equal(r.store_bill_id, null, '品牌行不是 store_bill');
    }
    assert.equal(rows[0].customer_rebate_krw, 42810);
    assert.equal(rows[1].customer_rebate_krw, -1500, '负数(退货品牌)原样冲减');
  });
});

test('最终交付包包含无 store_bill_id 的品牌活动行', async () => {
  const db = makeDb();
  const brandRepo = createBrandActivityRepository({ db });
  brandRepo.insertMany([
    mapBrandActivityRow({ asObject: brandRaw, workspaceKey: WS, sheetName: 'S', sourceFile: 'b', sourceRow: 2, importedAt: 't' }),
  ]);

  const merge = createMergeStreamingService({
    db,
    dailyReceiptRepo: createDailyReceiptRepository({ db }),
    billMatchLogRepo: createBillMatchLogRepository({ db }),
    monthlyDataRepo: createMonthlyDataRepository({ db }),
    storeBillRepo: createStoreBillRepository({ db }),
    brandActivityRepo: brandRepo,
  });
  await merge.run({ workspaceKey: WS });

  const service = createFinalDeliveryExportService({ db });
  const readiness = service.checkReadiness({ workspaceKey: WS });
  assert.equal(readiness.ok, true);
  assert.equal(readiness.eligibleRows, 1);
  assert.equal(readiness.excluded.dailyWithoutBill, 0);

  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-final-delivery-'));
  const result = await service.run({ workspaceKey: WS, outputDir });
  const finalData = result.files.find((f) => f.kind === 'final_data' && f.rows === 1);
  assert.ok(finalData, 'brand activity row should be written to final data workbook');
  assert.equal(fs.existsSync(finalData.path), true);
});

test('流式 merge 把退货(refund/净额负)折进交付做冲减(修复生产既有缺口)', () => {
  const db = makeDb();
  const storeBillRepo = createStoreBillRepository({ db });
  // 一条退货账单:transaction_type=refund,返点为负。bill_match 不匹配它,以前流式版会丢掉。
  storeBillRepo.insertMany([{
    workspaceKey: WS, storeFamily: '乐天', storeBranch: '乐天明洞', mode: '乐天SG-本司',
    passportNo: 'REF1', name: 'RR', netKrw: -5000, rebateAmount: -75,
    transactionType: 'refund', isDetailSheet: 1, rowHash: 'refund-1', importedAt: 't',
  }]);

  const merge = createMergeStreamingService({
    db,
    dailyReceiptRepo: createDailyReceiptRepository({ db }),
    billMatchLogRepo: createBillMatchLogRepository({ db }),
    monthlyDataRepo: createMonthlyDataRepository({ db }),
    storeBillRepo,
  });

  return merge.run({ workspaceKey: WS }).then((stats) => {
    assert.equal(stats.refund, 1, '1 条退货折入');
    const r = db.prepare("SELECT mode_folder, is_unmatched, customer_rebate_krw FROM monthly_data WHERE workspace_key=? AND passport_no='REF1'").get(WS);
    assert.ok(r, '退货行进了交付');
    assert.equal(r.mode_folder, '乐天首尔');
    assert.equal(r.is_unmatched, 0, '退货不是未收');
    assert.equal(r.customer_rebate_krw, -75, '负返点冲减');
  });
});
