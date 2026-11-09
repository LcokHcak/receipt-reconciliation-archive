'use strict';

/**
 * monthly_export_xlsx_format — D3 numFmt + width regression tests
 *
 * 1. KRW columns get numFmt '#,##0'
 * 2. USD columns get numFmt '#,##0.00'
 * 3. Percent columns get numFmt '0.00%'
 * 4. Null numeric values produce empty cells (value === null / undefined, not '')
 * 5. Column widths: KRW=16, USD=14, wide text=18, default=12
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ExcelJS = require('exceljs');

const { writeRowsStreaming } = require('../services/monthly/monthly_export/writers');
const { DATA_COLUMNS } = require('../services/monthly/monthly_export/builders');
const { COLORS, FONT } = require('../lib/excel_style');

function tmpFile() {
  return path.join(os.tmpdir(), `d3test_${Date.now()}_${Math.random().toString(36).slice(2)}.xlsx`);
}

async function generateAndRead(rows) {
  const filePath = tmpFile();
  try {
    await writeRowsStreaming(filePath, 'TestSheet', DATA_COLUMNS, rows, {
      title: 'D3 Format Test',
      workspaceKey: 'demo-2026-05',
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath);
    return wb;
  } finally {
    try { fs.unlinkSync(filePath); } catch { /* intentional */ }
  }
}

function getDataSheet(wb) {
  return wb.getWorksheet('TestSheet');
}

/** Returns the ExcelJS column object for the given DATA_COLUMNS key.
 *  Uses 1-based column index because column.key is not persisted in xlsx. */
function findCol(sheet, key) {
  const idx = DATA_COLUMNS.findIndex((c) => c.key === key);
  if (idx === -1) return null;
  return sheet.getColumn(idx + 1); // DATA_COLUMNS is the exact column order
}

// ─── Test 1: KRW numFmt ─────────────────────────────────────────────────────

test('D3: KRW columns have numFmt #,##0', async () => {
  const rows = [{ gross_krw: 1234567, net_krw: 890000, customer_rebate_krw: 5000 }];
  const wb = await generateAndRead(rows);
  const sheet = getDataSheet(wb);

  for (const key of ['gross_krw', 'net_krw', 'customer_rebate_krw']) {
    const col = findCol(sheet, key);
    assert.ok(col, `column ${key} should exist`);
    // numFmt may be on the column style or on the cell style
    const cell = sheet.getRow(2).getCell(col.number);
    assert.equal(cell.numFmt, '#,##0', `${key} numFmt should be #,##0`);
  }
});

// ─── Test 2: USD numFmt ─────────────────────────────────────────────────────

test('D3: USD columns have numFmt #,##0.00', async () => {
  const rows = [{ gross_usd: 1234.56, net_usd: 890.00, customer_rebate_usd: 12.34 }];
  const wb = await generateAndRead(rows);
  const sheet = getDataSheet(wb);

  for (const key of ['gross_usd', 'net_usd', 'customer_rebate_usd']) {
    const col = findCol(sheet, key);
    assert.ok(col, `column ${key} should exist`);
    const cell = sheet.getRow(2).getCell(col.number);
    assert.equal(cell.numFmt, '#,##0.00', `${key} numFmt should be #,##0.00`);
  }
});

// ─── Test 3: Percent numFmt ──────────────────────────────────────────────────

test('D3: discount_rate column has numFmt 0.00%', async () => {
  const rows = [{ discount_rate: 0.15 }];
  const wb = await generateAndRead(rows);
  const sheet = getDataSheet(wb);

  const col = findCol(sheet, 'discount_rate');
  assert.ok(col, 'column discount_rate should exist');
  const cell = sheet.getRow(2).getCell(col.number);
  assert.equal(cell.numFmt, '0.00%', 'discount_rate numFmt should be 0.00%');
});

// ─── Test 4: null numeric values produce empty cells ────────────────────────

test('D3: null numeric values produce empty cells, not the string empty', async () => {
  const rows = [{ gross_krw: null, gross_usd: null, discount_rate: null, name: null }];
  const wb = await generateAndRead(rows);
  const sheet = getDataSheet(wb);

  for (const key of ['gross_krw', 'gross_usd', 'discount_rate']) {
    const col = findCol(sheet, key);
    const cell = sheet.getRow(2).getCell(col.number);
    // The cell value should be null/undefined (empty), NOT the string ''
    assert.ok(
      cell.value === null || cell.value === undefined,
      `${key}: null input should produce empty cell, got ${JSON.stringify(cell.value)}`
    );
  }
  // String columns with null should also be empty (null or '')
  const nameCol = findCol(sheet, 'name');
  const nameCell = sheet.getRow(2).getCell(nameCol.number);
  assert.ok(
    nameCell.value === null || nameCell.value === undefined || nameCell.value === '',
    `name: null input should produce empty or null cell`
  );
});

// ─── Test 5: column widths ───────────────────────────────────────────────────

test('D3: column widths follow the key-based rules', async () => {
  const rows = [{}];
  const wb = await generateAndRead(rows);
  const sheet = getDataSheet(wb);

  const expectations = [
    { key: 'gross_krw', expectedWidth: 16 },
    { key: 'gross_usd', expectedWidth: 14 },
    { key: 'receipt_no', expectedWidth: 18 },
    { key: 'name', expectedWidth: 18 },
    { key: 'qty', expectedWidth: 10 },
    { key: 'stmt_date', expectedWidth: 12 },
  ];

  for (const { key, expectedWidth } of expectations) {
    const col = findCol(sheet, key);
    assert.ok(col, `column ${key} should exist`);
    assert.equal(col.width, expectedWidth, `${key} width should be ${expectedWidth}, got ${col.width}`);
  }
});

// ─── Test 6: 统一表格样式(视觉层)已套用,且未破坏 numFmt 锁 ──────────────

test('D3: unified table style applied — header band + 微软雅黑, numFmt still locked', async () => {
  const rows = [{ gross_krw: 1000, receipt_no: 'R1', name: 'A' }];
  const wb = await generateAndRead(rows);
  const sheet = getDataSheet(wb);

  // 表头:深蓝灰底 + 白字加粗 + 微软雅黑
  const headerCell = sheet.getRow(1).getCell(1);
  assert.equal(headerCell.fill.fgColor.argb, COLORS.headerBg, 'header fill 深蓝灰');
  assert.equal(headerCell.fill.fgColor.argb, 'FF44546A', 'header fill argb');
  assert.equal(headerCell.font.name, FONT, 'header font 微软雅黑');
  assert.equal(headerCell.font.bold, true, 'header bold');
  assert.equal(headerCell.font.color.argb, 'FFFFFFFF', 'header 白字');

  // 数据行:微软雅黑字体 + 细边框
  const bodyCell = sheet.getRow(2).getCell(1);
  assert.equal(bodyCell.font.name, FONT, 'body font 微软雅黑');
  assert.ok(bodyCell.border && bodyCell.border.bottom, 'body 细边框');

  // 样式未破坏既有 numFmt 锁(回归)
  const krwCol = findCol(sheet, 'gross_krw');
  assert.equal(sheet.getRow(2).getCell(krwCol.number).numFmt, '#,##0', 'KRW numFmt 仍为 #,##0');
});

test('D3: writeRowsStreaming accepts iterable rows with explicit row count', async () => {
  const filePath = tmpFile();
  function* rows() {
    yield { receipt_no: 'R1', gross_krw: 1000 };
    yield { receipt_no: 'R2', gross_krw: 2000 };
  }

  try {
    const result = await writeRowsStreaming(filePath, 'TestSheet', DATA_COLUMNS, rows(), {
      title: 'Iterable Format Test',
      workspaceKey: 'demo-2026-05',
      rowCount: 2,
    });
    assert.equal(result.rowsWritten, 2);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath);
    const info = wb.getWorksheet('生成说明');
    assert.equal(info.getRow(6).getCell(2).value, 2);
    const sheet = wb.getWorksheet('TestSheet');
    assert.equal(sheet.actualRowCount, 3);
  } finally {
    try { fs.unlinkSync(filePath); } catch { /* intentional */ }
  }
});
