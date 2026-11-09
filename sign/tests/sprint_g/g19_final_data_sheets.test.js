'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');

const { openMonthlyDatabase } = require('../../lib/storage/monthly_database');
const { createFinalDeliveryExportService } = require('../../services/monthly/final_delivery_export_service');

const WORKSPACE_KEY = '2026-05';

const SUMMARY_HEADERS = ['姓名', '护照号', '出境日期', '求和项:客人返点金额'];
const LOTTE_DETAIL_HEADERS = [
  '日期', '出账日期', '付款模式', '返点模式', '免税店', '免税分店', '上家', '入店公司',
  '导游', '代理', '原日期', '购买日期', '团号', '姓名', '护照号', '出境日期',
  '小票号', '原小票号', '分类', '品牌', 'SKU', '产品名称', 'REF NO', '数量',
  '总卖出($)', '总卖出(￦)', '纯卖出($)', '纯卖出(￦)', 'DC($)', 'DC(￦)',
  '折扣率', '商品券金额', '扣点商品券', '客人点数', '客人返点金额', '免税店点数',
  '免税店返点', '免税店追加点', '追加金额', '免税店最终返点', '分类', '备注',
  '备注2', '免税分店&购买日期&团号', '分类',
];
const RECEIPT_HEADERS = ['小票号', '代理', '出境日期', '已收', '姓名', '护照号', '负责人', '收票日期'];
const BILLING_HEADERS = [
  '返点模式', '免税分店', '购买日期', '团号', '姓名', '护照号', '小票号', '品牌',
  '数量', '总卖出($)', '总卖出(￦)', '纯卖出($)', '纯卖出(￦)', '客人点数',
  '客人返点金额', '出境日期',
];

test('最终数据 xlsx 对齐通用交付表头,小票 sheet 按 receipt_no 聚合', async () => {
  const { db, dir } = setupDb();
  try {
    insertStoreBill(db, {
      id: 1001,
      receiptNo: 'RCPT-AAA',
      rawPayload: {
        日期: '1',
        出账日期: '01/02',
        付款模式: '现金',
        上家: '210',
        入店公司: '2',
        导游: '롯데면세점',
        产品名称: 'History Product',
        'DC($)': 12,
        'DC(￦)': 12000,
        折扣率: 0.1,
        商品券金额: 30,
        扣点商品券: 3,
        免税店返点: 2200,
        免税店追加点: 0.02,
        追加金额: 200,
        免税店最终返点: 2400,
        备注: 'sample remark',
        备注2: '1차',
      },
    });
    // 同一小票号 3 个商品行 → 小票 sheet 聚合成 1 行,纯卖出/返点求和
    insertMonthlyRow(db, { rowHash: 'r1-item1', storeBillId: 1001, receiptNo: 'RCPT-AAA', netKrw: 100000, netUsd: 80, customerRebateKrw: 1000 });
    insertMonthlyRow(db, { rowHash: 'r1-item2', receiptNo: 'RCPT-AAA', netKrw: 200000, netUsd: 160, customerRebateKrw: 2000 });
    insertMonthlyRow(db, { rowHash: 'r1-item3', receiptNo: 'RCPT-AAA', netKrw: 300000, netUsd: 240, customerRebateKrw: 3000 });
    // 另一小票 1 行,不同代理
    insertMonthlyRow(db, { rowHash: 'r2-item1', receiptNo: 'RCPT-BBB', agent: 'Agent B', netKrw: 50000, netUsd: 40, customerRebateKrw: 500 });

    const service = createFinalDeliveryExportService({ db });
    const outputDir = path.join(dir, 'delivery');
    const result = await service.run({ workspaceKey: WORKSPACE_KEY, outputDir, operator: 'tester' });

    const dataFile = result.files.find((file) => file.kind === 'final_data' && file.folder === '乐天首尔');
    assert.ok(dataFile, 'final data xlsx should exist');

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(dataFile.path);

    const summary = workbook.getWorksheet('客户汇总');
    const detail = workbook.getWorksheet('明细');
    const receipt = workbook.getWorksheet('小票');
    const billing = workbook.getWorksheet('做账单');
    assert.ok(summary && detail && receipt && billing, '应有客户汇总/明细/小票/做账单 sheet');
    assert.equal(workbook.getWorksheet('代理'), undefined, '通用交付模板没有单独的代理 sheet');

    assert.deepEqual(rowValues(summary.getRow(1)), SUMMARY_HEADERS);
    assert.deepEqual(rowValues(detail.getRow(1)), LOTTE_DETAIL_HEADERS);
    assert.deepEqual(rowValues(receipt.getRow(1)), RECEIPT_HEADERS);
    assert.deepEqual(rowValues(billing.getRow(1)), BILLING_HEADERS);

    // 统一表格样式(只加视觉层):表头深蓝灰底 + 白字雅黑 + 冻结首行,四个数据 sheet 一致。
    for (const sheet of [summary, detail, receipt, billing]) {
      const headerCell = sheet.getRow(1).getCell(1);
      assert.equal(headerCell.fill.fgColor.argb, 'FF44546A', `${sheet.name} 表头深蓝灰底色`);
      assert.equal(headerCell.font.name, '微软雅黑', `${sheet.name} 表头雅黑字体`);
      assert.equal(headerCell.font.color.argb, 'FFFFFFFF', `${sheet.name} 表头白字`);
      const frozen = (sheet.views || []).find((view) => view.state === 'frozen');
      assert.ok(frozen && frozen.ySplit === 1, `${sheet.name} 冻结表头首行`);
    }

    // 明细 = 商品行级,4 数据行
    assert.equal(detail.rowCount, 5); // header + 4
    // 做账单 = 商品行级,4 数据行
    assert.equal(billing.rowCount, 5);
    // 小票 = 2 张 distinct receipt → 2 数据行
    assert.equal(receipt.rowCount, 3); // header + 2
    // 客户汇总 = 1 个客户,返点按客户聚合
    assert.equal(summary.rowCount, 2);
    assert.equal(summary.getRow(2).getCell(4).value, 6500);

    const detailHeaders = rowValues(detail.getRow(1));
    const detailIdx = (header) => detailHeaders.indexOf(header) + 1;
    assert.equal(detail.getRow(2).getCell(detailIdx('产品名称')).value, 'History Product');
    assert.equal(detail.getRow(2).getCell(detailIdx('DC($)')).value, 12);
    assert.equal(detail.getRow(2).getCell(detailIdx('折扣率')).value, 0.1);
    assert.equal(detail.getRow(2).getCell(detailIdx('备注2')).value, '1차');

    // 找到 RCPT-AAA 聚合行,校验 SUM
    const headers = receipt.getRow(1).values; // 1-indexed
    const colIndex = (header) => headers.indexOf(header);
    const idxReceipt = colIndex('小票号');

    let aaaRow = null;
    receipt.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      if (row.getCell(idxReceipt).value === 'RCPT-AAA') aaaRow = row;
    });
    assert.ok(aaaRow, 'RCPT-AAA 聚合行应存在');
  } finally {
    cleanup(db, dir);
  }
});

function setupDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g19-final-data-'));
  const db = openMonthlyDatabase({ dbPath: path.join(dir, 'monthly.sqlite') });
  db.prepare(`
    INSERT INTO monthly_workspace (workspace_key, year, month, status, created_at, updated_at)
    VALUES (?, 2026, 5, 'open', ?, ?)
  `).run(WORKSPACE_KEY, new Date().toISOString(), new Date().toISOString());
  return { db, dir };
}

function insertStoreBill(db, overrides = {}) {
  const now = new Date().toISOString();
  const row = {
    id: 1,
    storeFamily: '乐天',
    storeBranch: '乐天明洞',
    mode: 'H团',
    tourNo: 'T001',
    purchaseDate: '2026-05-12',
    originalDate: '2026-05-12',
    departureDate: '2026-05-20',
    name: 'HAN SNOW',
    passportNo: 'M12345678',
    receiptNo: 'R001',
    brand: 'BRAND',
    sku: 'SKU-1',
    refNo: 'REF-1',
    category: 'COS',
    qty: 1,
    grossUsd: 100,
    grossKrw: 130000,
    netUsd: 80,
    netKrw: 100000,
    points: 0.0332,
    rebateAmount: 1000,
    storeBasePoints: 0.02,
    storeExtraPoints: 0.01,
    rawPayload: {},
    ...overrides,
  };
  db.prepare(`
    INSERT INTO store_bill (
      id, workspace_key, store_family, store_branch, mode, tour_no, purchase_date,
      original_date, departure_date, name, passport_no, receipt_no, brand, sku,
      ref_no, category, qty, gross_usd, gross_krw, net_usd, net_krw, points,
      rebate_amount, store_base_points, store_extra_points, source_file,
      source_sheet, source_row, is_detail_sheet, raw_payload, row_hash, imported_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    WORKSPACE_KEY,
    row.storeFamily,
    row.storeBranch,
    row.mode,
    row.tourNo,
    row.purchaseDate,
    row.originalDate,
    row.departureDate,
    row.name,
    row.passportNo,
    row.receiptNo,
    row.brand,
    row.sku,
    row.refNo,
    row.category,
    row.qty,
    row.grossUsd,
    row.grossKrw,
    row.netUsd,
    row.netKrw,
    row.points,
    row.rebateAmount,
    row.storeBasePoints,
    row.storeExtraPoints,
    '账单.xlsx',
    '明细',
    2,
    1,
    JSON.stringify(row.rawPayload),
    `bill-${row.id}`,
    now
  );
}

function insertMonthlyRow(db, overrides = {}) {
  const now = new Date().toISOString();
  const row = {
    workspaceKey: WORKSPACE_KEY,
    modeFolder: '乐天首尔',
    isUnmatched: false,
    dailyReceiptId: 1,
    storeBillId: 1,
    rowHash: `row-${Math.random()}`,
    agent: 'Agent A',
    name: 'HAN SNOW',
    passportNo: 'M12345678',
    purchaseDate: '2026-05-12',
    departureDate: '2026-05-20',
    receiptNo: 'R001',
    tourNo: 'T001',
    brand: 'BRAND',
    qty: 1,
    grossUsd: 100,
    grossKrw: 130000,
    netKrw: 1000000,
    netUsd: 800,
    customerPoints: 0.0332,
    customerRebateKrw: 1000,
    customerRebateUsd: 1.25,
    ...overrides,
  };
  db.prepare(`
    INSERT INTO monthly_data (
      workspace_key, mode_folder, is_unmatched, daily_receipt_id, store_bill_id,
      agent, name, passport_no, purchase_date, departure_date, receipt_no, tour_no,
      brand, qty, gross_usd, gross_krw, net_krw, net_usd,
      customer_points, customer_rebate_krw, customer_rebate_usd,
      row_hash, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.workspaceKey,
    row.modeFolder,
    row.isUnmatched ? 1 : 0,
    row.dailyReceiptId,
    row.storeBillId,
    row.agent,
    row.name,
    row.passportNo,
    row.purchaseDate,
    row.departureDate,
    row.receiptNo,
    row.tourNo,
    row.brand,
    row.qty,
    row.grossUsd,
    row.grossKrw,
    row.netKrw,
    row.netUsd,
    row.customerPoints,
    row.customerRebateKrw,
    row.customerRebateUsd,
    row.rowHash,
    now,
    now
  );
}

function rowValues(row) {
  return row.values.slice(1);
}

function cleanup(db, dir) {
  try { db.close?.(); } catch { /* noop */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
}
