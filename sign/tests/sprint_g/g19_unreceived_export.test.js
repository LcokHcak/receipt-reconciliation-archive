'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');

const { openMonthlyDatabase } = require('../../lib/storage/monthly_database');
const { createImportJobRepository } = require('../../repositories/import_job_repository');
const {
  createUnreceivedExportService,
  UNRECEIVED_DETAIL_COLUMNS,
  SECOND_ROUND_COLUMNS,
} = require('../../services/monthly/unreceived_export_service');
const { COLORS, FONT } = require('../../lib/excel_style');

const WORKSPACE_KEY = '2026-05';
// 未收=SMG总账口径(2026-07-22 拍板):store_bill 未收行必须挂 smg_ledger job。
let smgJobId = null;
// 2026-06-12 改版契约:未收清单 = 账单明细样式(运营可直接对回源账单溯源)+按桶分 sheet
const DETAIL_HEADERS = UNRECEIVED_DETAIL_COLUMNS.map((c) => c.header);
const TEMPLATE_HEADERS = SECOND_ROUND_COLUMNS.map((c) => c.header);

test('未收清单导出 账单明细样式+按桶 sheet + 4 团二轮空模板', async () => {
  const { db, dir } = setupDb();
  try {
    // 台账 4 张票
    insertDaily(db, { name: 'BAI XUE',  passportNo: 'EP6274602', receiptNo: 'RX-1', netUsd: 120.5, agent: 'A1' });
    insertDaily(db, { name: 'LI MING',  passportNo: 'EM1156758', receiptNo: 'RX-2', netUsd: 88,    agent: 'A2' });
    insertDaily(db, { name: 'NORMAL',   passportNo: 'EN0000001', receiptNo: 'RM-1', netUsd: 999 });
    // 大小写/尾空格变体:台账 'RX-3 ' 与账单 'rx-3' 归一化后同一张 → 不算未收
    insertDaily(db, { name: 'han snow', passportNo: 'P9',        receiptNo: 'RX-3 ', netUsd: 50,   agent: 'A3' });

    // 账单:RM-1 已收(同客户),rx-3 收(变体),ORPH-1 账单孤儿(台账无)=未收,两条明细行
    insertBill(db, { name: 'NORMAL',   passportNo: 'EN0000001', receiptNo: 'RM-1', hash: 'b1' });
    insertBill(db, { name: 'HAN SNOW', passportNo: 'P9',        receiptNo: 'rx-3', hash: 'b2' });
    insertBill(db, {
      name: 'GHOST', fullName: 'GHOST FULL', passportNo: 'EZ9', receiptNo: 'ORPH-1', hash: 'b3',
      brand: 'CHANEL', productName: 'LIP 99', netUsd: 77, netKrw: 100000,
    });
    insertBill(db, {
      name: 'GHOST', fullName: 'GHOST FULL', passportNo: 'EZ9', receiptNo: 'ORPH-1', hash: 'b4',
      brand: 'DIOR', productName: 'BAG 11', netUsd: 200, netKrw: 280000,
    });

    const service = createUnreceivedExportService({ db });
    const outputDir = path.join(dir, 'unreceived');
    const result = await service.exportForWorkspace({ workspaceKey: WORKSPACE_KEY, outputDir });
    const bucketRows = service.listUnreceivedRows(WORKSPACE_KEY, { folder: '乐天首尔' });

    // 口径不变(2026-06-03 统一): 未收 = 账单有、台账无,按小票计数。
    assert.equal(result.unreceivedRows, 1, '只统计账单有台账无;台账孤儿/已收/变体均排除');
    assert.equal(bucketRows.length, 1, '未收清单可按账单桶过滤');
    assert.equal(bucketRows[0].mode_folder, '乐天首尔');

    // 未收清单文件:按桶 sheet,账单明细样式(ORPH-1 的 2 条明细行都在)
    const listFile = result.files.find((f) => f.kind === 'unreceived_list');
    assert.ok(listFile && fs.existsSync(listFile.path));
    assert.equal(listFile.rows, 2, 'rows=明细行数(ORPH-1 两条商品行)');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(listFile.path);
    const sheet = wb.getWorksheet('乐天首尔');
    assert.ok(sheet, 'sheet 按桶命名');
    const headers = sheet.getRow(1).values.slice(1);
    assert.deepEqual(headers, DETAIL_HEADERS, '表头=账单明细样式 20 列');
    // 统一样式(视觉层):表头深蓝灰底 + 白字雅黑 + 冻结首行(freezeCols=0)
    const headerCell = sheet.getRow(1).getCell(1);
    assert.equal(headerCell.fill?.fgColor?.argb, COLORS.headerBg, '表头填充=深蓝灰 FF44546A');
    assert.equal(headerCell.font?.name, FONT, '表头字体=微软雅黑');
    assert.equal(sheet.views?.[0]?.state, 'frozen', '冻结首行');
    assert.equal(sheet.views?.[0]?.ySplit, 1, '冻结到表头行');
    assert.equal(sheet.views?.[0]?.xSplit || 0, 0, 'freezeCols=0 不冻结左列');
    assert.equal(sheet.rowCount, 3, 'header + ORPH-1 两条明细');
    const receiptColIdx = DETAIL_HEADERS.indexOf('小票号') + 1;
    assert.equal(sheet.getRow(2).getCell(receiptColIdx).value, 'ORPH-1');
    assert.equal(sheet.getRow(3).getCell(receiptColIdx).value, 'ORPH-1');
    const brandColIdx = DETAIL_HEADERS.indexOf('品牌') + 1;
    const brands = [sheet.getRow(2).getCell(brandColIdx).value, sheet.getRow(3).getCell(brandColIdx).value].sort();
    assert.deepEqual(brands, ['CHANEL', 'DIOR'], '同小票的全部明细行都导出(审核员溯源)');
    // 统一样式(视觉层·正文):数据行也上样式(雅黑字体 + 细边框),证明不止表头
    const dataCell = sheet.getRow(2).getCell(1);
    assert.equal(dataCell.font?.name, FONT, '正文字体=微软雅黑');
    assert.equal(dataCell.border?.bottom?.style, 'thin', '正文单元格细边框');

    // 4 团二轮模板:表头(轻量 9 列)存在,0 数据行
    const templates = result.files.filter((f) => f.kind === 'second_round_template');
    assert.equal(templates.length, 4);
    for (const tpl of templates) {
      assert.ok(fs.existsSync(tpl.path));
      const twb = new ExcelJS.Workbook();
      await twb.xlsx.readFile(tpl.path);
      const tsheet = twb.worksheets[0];
      assert.equal(tsheet.rowCount, 1, '模板只有表头行');
      const theaders = tsheet.getRow(1).values.slice(1);
      assert.deepEqual(theaders, TEMPLATE_HEADERS);
      // 空模板也套统一样式(观感一致)
      assert.equal(tsheet.getRow(1).getCell(1).fill?.fgColor?.argb, COLORS.headerBg, '模板表头深蓝灰底');
      assert.equal(tsheet.views?.[0]?.state, 'frozen', '模板也冻结首行');
    }
  } finally {
    cleanup(db, dir);
  }
});

function setupDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g19-unreceived-'));
  const db = openMonthlyDatabase({ dbPath: path.join(dir, 'monthly.sqlite') });
  db.prepare(`
    INSERT INTO monthly_workspace (workspace_key, year, month, status, created_at, updated_at)
    VALUES (?, 2026, 5, 'open', ?, ?)
  `).run(WORKSPACE_KEY, new Date().toISOString(), new Date().toISOString());
  smgJobId = createImportJobRepository({ db }).create({
    workspaceKey: WORKSPACE_KEY, jobType: 'smg_ledger', sourceFile: 'SMG总账.xlsx', operator: 'op',
    startedAt: new Date().toISOString(),
  });
  return { db, dir };
}

function insertDaily(db, overrides = {}) {
  const now = new Date().toISOString();
  const row = {
    modeFolder: '乐天首尔', modeRaw: 'LOTTE', tourNo: 'T001', purchaseDate: '2026-05-12',
    name: 'HAN SNOW', passportNo: 'M12345678', receiptNo: 'R001', brand: 'BRAND',
    netUsd: 800, agent: 'Agent A', rowHash: `daily-${Math.random()}`,
    tourMatchStatus: 'matched',
    ...overrides,
  };
  db.prepare(`
    INSERT INTO daily_receipt_export (
      workspace_key, mode_folder, mode_raw, tour_no, purchase_date,
      name, passport_no, receipt_no, brand, net_usd, agent,
      tour_match_status, row_hash, imported_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    WORKSPACE_KEY, row.modeFolder, row.modeRaw, row.tourNo, row.purchaseDate,
    row.name, row.passportNo, row.receiptNo, row.brand, row.netUsd, row.agent,
    row.tourMatchStatus, row.rowHash, now
  );
}

function insertBill(db, overrides = {}) {
  const now = new Date().toISOString();
  const row = {
    storeFamily: '乐天首尔', name: 'HAN SNOW', passportNo: 'M12345678',
    fullName: null, receiptNo: 'R001', hash: `bill-${Math.random()}`,
    brand: null, productName: null, netUsd: null, netKrw: null,
    purchaseDate: '2026-05-12', tourNo: 'T001',
    ...overrides,
  };
  db.prepare(`
    INSERT INTO store_bill (
      workspace_key, store_family, name, full_name, passport_no, receipt_no,
      brand, product_name, net_usd, net_krw, purchase_date, tour_no,
      row_hash, imported_at, import_job_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    WORKSPACE_KEY, row.storeFamily, row.name, row.fullName, row.passportNo, row.receiptNo,
    row.brand, row.productName, row.netUsd, row.netKrw, row.purchaseDate, row.tourNo,
    row.hash, now, row.importJobId !== undefined ? row.importJobId : smgJobId
  );
}

function cleanup(db, dir) {
  try { db.close?.(); } catch { /* noop */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
}
