'use strict';

const fs = require('node:fs');
const ExcelJS = require('exceljs');

const { exportColumnDescription } = require('./builders');
const {
  styledColumnDefs,
  styleHeaderRowInPlace,
  styleBodyRowInPlace,
  resolveColumnTypes,
  FONT,
  COLORS,
  SIZE_BODY,
  HEIGHT_BODY,
  HEIGHT_HEADER,
} = require('../../../lib/excel_style');

// ─── numFmt / width helpers ──────────────────────────────────────────────────

const KRW_KEYS = new Set([
  'gross_krw', 'net_krw', 'dc_krw',
  'voucher_amount', 'voucher_deduction',
  'customer_points', 'customer_rebate_krw',
  'store_base_points', 'store_base_rebate',
  'store_extra_points', 'store_extra_amount', 'store_final_rebate',
]);

const USD_KEYS = new Set([
  'gross_usd', 'net_usd', 'dc_usd', 'customer_rebate_usd',
]);

const PCT_KEYS = new Set(['discount_rate']);

const INT_KEYS = new Set(['qty']);

const WIDE_KEYS = new Set([
  'receipt_no', 'original_receipt_no', 'passport_no', 'name',
  'shop', 'branch', 'upstream', 'entry_company', 'product_name', 'remark',
]);

const NARROW_KEYS = new Set(['qty', 'mode_raw', 'payment_mode', 'category', 'brand', 'sku']);

/**
 * Returns { style: { numFmt? }, width } for a given column key.
 * Applied to sheet.columns so ExcelJS formats every cell in the column.
 */
function columnProps(key) {
  let numFmt;
  if (KRW_KEYS.has(key)) numFmt = '#,##0';
  else if (USD_KEYS.has(key)) numFmt = '#,##0.00';
  else if (PCT_KEYS.has(key)) numFmt = '0.00%';
  else if (INT_KEYS.has(key)) numFmt = '0';

  let width = 12;
  if (WIDE_KEYS.has(key)) width = 18;
  else if (NARROW_KEYS.has(key)) width = 10;
  else if (KRW_KEYS.has(key)) width = 16;
  else if (USD_KEYS.has(key)) width = 14;

  return { style: numFmt ? { numFmt } : {}, width };
}

// ─── 生成说明 sheet 的轻量样式(只加视觉层,绝不改任何单元格值) ────────────

function styleInfoTitleCell(cell) {
  cell.font = { name: FONT, size: 11, bold: true, color: { argb: COLORS.headerFont } };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.headerBg } };
  cell.alignment = { horizontal: 'left', vertical: 'middle' };
}

function styleInfoLabelCell(cell) {
  cell.font = { name: FONT, size: SIZE_BODY, bold: true };
  cell.alignment = { horizontal: 'left', vertical: 'middle' };
}

function styleInfoValueCell(cell) {
  cell.font = { name: FONT, size: SIZE_BODY };
  cell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
}

/**
 * 流式向 info sheet 追加一行并就地上样式后 commit。
 * kind='title' → 深蓝灰标题带;否则首列加粗为标签、其余列为值(换行)。
 * 只设字体/填充/对齐/行高,不触碰任何单元格值。
 */
function commitInfoRow(sheet, values, kind = 'kv') {
  const row = sheet.addRow(values);
  row.height = kind === 'title' ? HEIGHT_HEADER : HEIGHT_BODY;
  if (kind === 'title') {
    for (let c = 1; c <= values.length; c += 1) styleInfoTitleCell(row.getCell(c));
  } else {
    styleInfoLabelCell(row.getCell(1));
    for (let c = 2; c <= values.length; c += 1) styleInfoValueCell(row.getCell(c));
  }
  row.commit();
  return row;
}

// ─── writer ─────────────────────────────────────────────────────────────────

async function writeRowsStreaming(filePath, sheetName, columns, rows, metadata = {}) {
  // Remove stale file first so exceljs can take a fresh handle
  if (fs.existsSync(filePath)) {
    try { fs.unlinkSync(filePath); } catch {
      // intentional: best-effort cleanup
    }
  }
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: filePath,
    useStyles: true,
    useSharedStrings: true,
  });
  const info = workbook.addWorksheet('生成说明');
  commitInfoRow(info, ['生成说明'], 'title');
  commitInfoRow(info, ['文件用途', metadata.title || sheetName]);
  commitInfoRow(info, ['工作月份', metadata.workspaceKey || '']);
  commitInfoRow(info, ['生成时间', new Date().toISOString()]);
  commitInfoRow(info, ['生成人', metadata.operator || '系统']);
  const declaredRowCount = rowCount(rows, metadata);
  commitInfoRow(info, ['数据行数', declaredRowCount]);
  commitInfoRow(info, ['数据口径', metadata.description || '']);
  commitInfoRow(info, ['反向追溯字段', '系统月度ID、台账ID、账单ID、匹配日志ID、匹配规则、台账/账单来源文件、工作表、行号。']);
  commitInfoRow(info, ['核对方式', '先用系统月度ID定位导出行，再用台账ID/账单ID回查系统；来源文件、工作表、行号用于回到原 Excel 核对。']);
  commitInfoRow(info, ['字段口径说明'], 'title');
  for (const column of columns) {
    commitInfoRow(info, [column.header, exportColumnDescription(column.key)]);
  }
  commitInfoRow(info, ['说明', '本页用于反向追溯导出文件生成时的数据口径。']);
  info.commit();

  const sheet = workbook.addWorksheet(sheetName);
  // 把 columnProps 产出的 numFmt/列宽透传进 styledColumnDefs 的输入,
  // 让样式模块只补字体/对齐/文本格式,保留调用方已锁的 numFmt 与列宽。
  const styledInputColumns = columns.map((c) => {
    const { style, width } = columnProps(c.key);
    return { header: c.header, key: c.key, width, style };
  });
  sheet.columns = styledColumnDefs(styledInputColumns);
  const columnCount = styledInputColumns.length;
  const columnTypes = resolveColumnTypes(styledInputColumns);
  // 表头行就地上样式(sheet.columns 设完、加数据行之前,流式铁律)。
  styleHeaderRowInPlace(sheet.getRow(1), columnCount);
  let rowsWritten = 0;
  for (const r of rows || []) {
    const obj = {};
    // Use null (not '') for missing values so numeric cells stay empty
    // rather than being written as the string ''.
    for (const c of columns) obj[c.key] = r[c.key] ?? null;
    const row = sheet.addRow(obj);
    // 数据行只上视觉层(字体/边框/对齐/隔行/行高);numFmt 由列样式提供,
    // styleBodyRowInPlace 侦测到已有 numFmt 不会覆盖(保护 #,##0 / #,##0.00 / 0.00%)。
    styleBodyRowInPlace(row, { types: columnTypes, dataIndex: rowsWritten + 1, columnCount });
    row.commit();
    rowsWritten += 1;
  }
  sheet.commit();
  await workbook.commit();
  return { filePath, rowsWritten };
}

function rowCount(rows, metadata) {
  const explicit = Number(metadata.rowCount);
  if (Number.isFinite(explicit)) return explicit;
  if (Array.isArray(rows)) return rows.length;
  if (Number.isFinite(Number(rows?.length))) return Number(rows.length);
  return '';
}

module.exports = { writeRowsStreaming, columnProps };
