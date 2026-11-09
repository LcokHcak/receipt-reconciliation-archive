'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');

const { openMonthlyDatabase } = require('../../lib/storage/monthly_database');
const { createFinalDeliveryExportService } = require('../../services/monthly/final_delivery_export_service');

const COMMON_SHEETS = ['客户汇总', '明细', '小票', '做账单'];
const SUMMARY_HEADERS = ['姓名', '护照号', '出境日期', '求和项:客人返点金额'];
const RECEIPT_HEADERS = ['小票号', '代理', '出境日期', '已收', '姓名', '护照号', '负责人', '收票日期'];
const BILLING_HEADERS = [
  '返点模式', '免税分店', '购买日期', '团号', '姓名', '护照号', '小票号', '品牌',
  '数量', '总卖出($)', '总卖出(￦)', '纯卖出($)', '纯卖出(￦)', '客人点数',
  '客人返点金额', '出境日期',
];
const LOTTE_DETAIL_HEADERS = [
  '日期', '出账日期', '付款模式', '返点模式', '免税店', '免税分店', '上家', '入店公司',
  '导游', '代理', '原日期', '购买日期', '团号', '姓名', '护照号', '出境日期',
  '小票号', '原小票号', '分类', '品牌', 'SKU', '产品名称', 'REF NO', '数量',
  '总卖出($)', '总卖出(￦)', '纯卖出($)', '纯卖出(￦)', 'DC($)', 'DC(￦)',
  '折扣率', '商品券金额', '扣点商品券', '客人点数', '客人返点金额', '免税店点数',
  '免税店返点', '免税店追加点', '追加金额', '免税店最终返点', '分类', '备注',
  '备注2', '免税分店&购买日期&团号', '分类',
];
const AIBAO_DETAIL_HEADERS = [
  '免税店', '免税分店', '导游', '原日期', '购买日期', '团号', '姓名', '护照号',
  '出境日期', '小票号', '原小票号', '分类', '品牌', 'SKU', '产品名称', 'REF NO',
  '数量', '总卖出($)', '总卖出(￦)', '纯卖出($)', '纯卖出(￦)', 'DC($)', 'DC(￦)',
  '商品券金额', '扣点商品券', '客人点数', '客人返点金额', '免税店点数',
  '免税店返点金额', '免税店追加', '追加金额', '免税店最终返点', '分类',
  '备注', '备注2', '代理',
];

test('final delivery uses one universal bucket template for every month and every bucket has a receipt sheet', async () => {
  for (const workspaceKey of ['2026-01', '2026-02']) {
    const { db, dir } = setupDb(workspaceKey);
    try {
      seedRows(db, workspaceKey);
      const result = await createFinalDeliveryExportService({ db }).run({
        workspaceKey,
        outputDir: path.join(dir, 'delivery'),
        operator: 'tester',
      });

      const lotte = await workbookFor(result, '乐天首尔');
      assert.deepEqual(lotte.worksheets.map((sheet) => sheet.name), COMMON_SHEETS, `${workspaceKey} 乐天首尔 should use common sheet names`);
      assert.deepEqual(rowValues(lotte.getWorksheet('客户汇总').getRow(1)), SUMMARY_HEADERS);
      assert.deepEqual(rowValues(lotte.getWorksheet('明细').getRow(1)), LOTTE_DETAIL_HEADERS);
      assert.deepEqual(rowValues(lotte.getWorksheet('小票').getRow(1)), RECEIPT_HEADERS);
      assert.deepEqual(rowValues(lotte.getWorksheet('做账单').getRow(1)), BILLING_HEADERS);

      // 统一表格样式(只加视觉层,不影响上面的表头/值契约):表头深蓝灰白字雅黑。
      const lotteHeaderCell = lotte.getWorksheet('明细').getRow(1).getCell(1);
      assert.equal(lotteHeaderCell.fill.fgColor.argb, 'FF44546A', '明细表头深蓝灰底色');
      assert.equal(lotteHeaderCell.font.name, '微软雅黑', '明细表头雅黑字体');

      const detail = lotte.getWorksheet('明细');
      const detailHeaders = rowValues(detail.getRow(1));
      const getDetail = (header, occurrence = 1) => detail.getRow(2).getCell(headerIndex(detailHeaders, header, occurrence) + 1).value;
      assert.equal(getDetail('返点模式'), 'SG');
      assert.equal(getDetail('免税店'), '乐天');
      assert.equal(getDetail('代理'), '多米');
      assert.equal(getDetail('备注'), '');
      assert.equal(getDetail('客人点数'), 0.223, '客人点数仍使用系统/扣点计算结果');
      assert.equal(getDetail('客人返点金额'), 1911418.186, '客人返点仍使用系统/扣点计算结果');

      const aibao = await workbookFor(result, '爱宝客');
      assert.deepEqual(aibao.worksheets.map((sheet) => sheet.name), COMMON_SHEETS, `${workspaceKey} 爱宝客 should use common sheet names`);
      assert.deepEqual(rowValues(aibao.getWorksheet('明细').getRow(1)), AIBAO_DETAIL_HEADERS);
      assert.deepEqual(rowValues(aibao.getWorksheet('小票').getRow(1)), RECEIPT_HEADERS);
      assert.deepEqual(rowValues(aibao.getWorksheet('做账单').getRow(1)), BILLING_HEADERS);
    } finally {
      cleanup(db, dir);
    }
  }
});

test('final delivery drops 「不用记」 rows from every data sheet (2026-07-24 出口过滤)', async () => {
  const workspaceKey = '2026-03';
  const { db, dir } = setupDb(workspaceKey);
  try {
    // 正常乐天票:进导出
    insertBill(db, workspaceKey, {
      id: 1,
      receiptNo: 'R-KEEP',
      rawPayload: { 返点模式: 'SG', 免税店: '乐天', 免税分店: '乐天明洞' },
    });
    insertMonthly(db, workspaceKey, {
      modeFolder: '乐天首尔',
      rowHash: `${workspaceKey}-keep`,
      storeBillId: 1,
      receiptNo: 'R-KEEP',
      modeRaw: '乐天SG-本司',
      shop: 'LOTTE',
    });
    // 同桶「不用记」票(mode_raw 带尾巴):台账保留、导出出口整行剔除
    insertBill(db, workspaceKey, {
      id: 2,
      receiptNo: 'R-DROP',
      rawPayload: { 返点模式: 'SG', 免税店: '乐天', 免税分店: '乐天明洞' },
    });
    insertMonthly(db, workspaceKey, {
      modeFolder: '乐天首尔',
      rowHash: `${workspaceKey}-drop`,
      storeBillId: 2,
      receiptNo: 'R-DROP',
      modeRaw: '乐天SG-本司（不用记）',
      shop: 'LOTTE',
    });

    const result = await createFinalDeliveryExportService({ db }).run({
      workspaceKey,
      outputDir: path.join(dir, 'delivery'),
      operator: 'tester',
    });

    const lotte = await workbookFor(result, '乐天首尔');
    // 「不用记」行不进任何数据 sheet:明细/做账单/小票 各只剩 header + 1(R-KEEP)
    assert.equal(lotte.getWorksheet('明细').rowCount, 2, '明细 header + 1(不用记行剔除)');
    assert.equal(lotte.getWorksheet('做账单').rowCount, 2, '做账单 header + 1');
    assert.equal(lotte.getWorksheet('小票').rowCount, 2, '小票 header + 1 distinct receipt');

    const receipt = lotte.getWorksheet('小票');
    const receiptHeaders = rowValues(receipt.getRow(1));
    const receiptNoIdx = receiptHeaders.indexOf('小票号') + 1;
    const survivingReceiptNos = [];
    receipt.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      survivingReceiptNos.push(row.getCell(receiptNoIdx).value);
    });
    assert.deepEqual(survivingReceiptNos, ['R-KEEP'], '仅保留非「不用记」小票');
  } finally {
    cleanup(db, dir);
  }
});

async function workbookFor(result, folder) {
  const file = result.files.find((item) => item.kind === 'final_data' && item.folder === folder);
  assert.ok(file, `${folder} final xlsx should exist`);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file.path);
  return workbook;
}

function setupDb(workspaceKey) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'universal-template-'));
  const db = openMonthlyDatabase({ dbPath: path.join(dir, 'monthly.sqlite') });
  const now = new Date().toISOString();
  const [, year, month] = workspaceKey.match(/^(\d{4})-(\d{2})$/);
  db.prepare(`
    INSERT INTO monthly_workspace (workspace_key, year, month, status, created_at, updated_at)
    VALUES (?, ?, ?, 'open', ?, ?)
  `).run(workspaceKey, Number(year), Number(month), now, now);
  return { db, dir };
}

function seedRows(db, workspaceKey) {
  insertBill(db, workspaceKey, {
    id: 1,
    receiptNo: 'R-LOTTE',
    rawPayload: {
      '1': '特殊',
      返点模式: 'SG',
      免税店: '乐天',
      免税分店: '乐天明洞',
      代理: '多米',
      备注: '',
      备注2: '4차',
      免税店返点: 1954275.096,
    },
  });
  insertMonthly(db, workspaceKey, {
    modeFolder: '乐天首尔',
    rowHash: `${workspaceKey}-lotte`,
    storeBillId: 1,
    receiptNo: 'R-LOTTE',
    modeRaw: '乐天SG-本司',
    shop: 'LOTTE',
    agent: '涛士',
    customerPoints: 0.223,
    customerRebateKrw: 1911418.186,
  });

  insertBill(db, workspaceKey, {
    id: 2,
    receiptNo: 'R-AIBAO',
    rawPayload: { 返点模式: 'PKG', 免税店: '爱宝客', 免税分店: '爱宝客' },
  });
  insertMonthly(db, workspaceKey, {
    modeFolder: '爱宝客',
    rowHash: `${workspaceKey}-aibao`,
    storeBillId: 2,
    receiptNo: 'R-AIBAO',
  });
}

function insertBill(db, workspaceKey, overrides = {}) {
  const now = new Date().toISOString();
  const row = {
    id: 1,
    receiptNo: 'R001',
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
    ) VALUES (?, ?, 'TEST', 'TEST', 'SG', 'T001', '2026-01-02',
      '2026-01-02', '2026-01-05', 'TEST NAME', 'P12345678', ?, 'BRAND', 'SKU',
      'REF', 'CAT', 1, 100, 140000, 80, 100000, 0.22,
      22000, 0.22, 0, '账单.xlsx', '明细', 2, 1, ?, ?, ?)
  `).run(row.id, workspaceKey, row.receiptNo, JSON.stringify(row.rawPayload), `${workspaceKey}-bill-${row.id}`, now);
}

function insertMonthly(db, workspaceKey, overrides = {}) {
  const now = new Date().toISOString();
  const row = {
    modeFolder: '乐天首尔',
    rowHash: `${workspaceKey}-monthly-${Math.random()}`,
    storeBillId: 1,
    receiptNo: 'R001',
    modeRaw: '系统模式',
    shop: 'SYSTEM SHOP',
    agent: 'SYSTEM AGENT',
    customerPoints: 0.22,
    customerRebateKrw: 22000,
    ...overrides,
  };
  db.prepare(`
    INSERT INTO monthly_data (
      workspace_key, mode_folder, is_unmatched, daily_receipt_id, store_bill_id,
      mode_raw, shop, branch, agent, original_date, purchase_date, tour_no,
      name, passport_no, departure_date, receipt_no, category, brand, sku, ref_no,
      qty, gross_usd, gross_krw, net_usd, net_krw, customer_points,
      customer_rebate_krw, store_base_points, store_base_rebate,
      store_extra_points, store_extra_amount, store_final_rebate, remark,
      row_hash, created_at, updated_at
    ) VALUES (?, ?, 0, 1, ?, ?, ?, 'SYSTEM BRANCH', ?, '2026-01-02', '2026-01-02', 'T001',
      'TEST NAME', 'P12345678', '2026-01-05', ?, 'CAT', 'BRAND', 'SKU', 'REF',
      1, 100, 140000, 80, 100000, ?, ?, 0.22, 22000, 0, 0, 22000, 'SYSTEM REMARK',
      ?, ?, ?)
  `).run(
    workspaceKey,
    row.modeFolder,
    row.storeBillId,
    row.modeRaw,
    row.shop,
    row.agent,
    row.receiptNo,
    row.customerPoints,
    row.customerRebateKrw,
    row.rowHash,
    now,
    now
  );
}

function rowValues(row) {
  return row.values.slice(1).map((value) => (value == null ? '' : value));
}

function headerIndex(headers, header, occurrence = 1) {
  let seen = 0;
  for (let i = 0; i < headers.length; i += 1) {
    if (headers[i] !== header) continue;
    seen += 1;
    if (seen === occurrence) return i;
  }
  return -1;
}

function cleanup(db, dir) {
  try { db.close?.(); } catch { /* noop */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
}
