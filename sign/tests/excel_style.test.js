'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');

const {
  applyExcelStyle,
  styledColumnDefs,
  styleHeaderRowInPlace,
  styleBodyRowInPlace,
  resolveColumnTypes,
  inferFieldType,
  statusColorFor,
  FONT,
  COLORS,
  HEIGHT_BODY,
  HEIGHT_HEADER,
} = require('../lib/excel_style');

function buildSheet(headers, rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('明细');
  ws.columns = headers.map((h) => ({ header: h, key: h }));
  for (const r of rows) ws.addRow(r);
  return ws;
}

test('字段类型推断:护照/小票/团号/金额/日期/状态/模式/数量/备注/姓名', () => {
  assert.equal(inferFieldType('护照号码'), 'id_text');
  assert.equal(inferFieldType('小票号'), 'id_text');
  assert.equal(inferFieldType('客户编号'), 'id_text');
  assert.equal(inferFieldType('团号'), 'tour');
  assert.equal(inferFieldType('客人返点金额'), 'amount');
  assert.equal(inferFieldType('总卖出(￦)'), 'amount');
  assert.equal(inferFieldType('购买日期'), 'date');
  assert.equal(inferFieldType('状态'), 'status');
  assert.equal(inferFieldType('返点模式'), 'mode');
  assert.equal(inferFieldType('数量'), 'count');
  assert.equal(inferFieldType('备注'), 'note');
  assert.equal(inferFieldType('异常原因'), 'note');
  assert.equal(inferFieldType('中文姓名'), 'name');
  assert.equal(inferFieldType('代理'), 'name');
});

test('applyExcelStyle:表头深蓝灰白字居中加粗+行高28', () => {
  const ws = buildSheet(['中文姓名', '护照号码', '购买日期'], [['张三', 'M1234567', '2026-07-01']]);
  applyExcelStyle(ws);
  const h = ws.getRow(1);
  assert.equal(h.height, HEIGHT_HEADER);
  const c = h.getCell(1);
  assert.equal(c.font.name, FONT);
  assert.equal(c.font.size, 11);
  assert.equal(c.font.bold, true);
  assert.equal(c.font.color.argb, COLORS.headerFont);
  assert.equal(c.fill.fgColor.argb, COLORS.headerBg);
  assert.equal(c.alignment.horizontal, 'center');
  assert.equal(c.alignment.vertical, 'middle');
  assert.ok(c.border.bottom && c.border.bottom.style === 'thin');
});

test('applyExcelStyle:正文雅黑10号+细边框+行高22+隔行填充', () => {
  const ws = buildSheet(['中文姓名'], [['张三'], ['李四'], ['王五']]);
  applyExcelStyle(ws);
  const r2 = ws.getRow(2); // 第1数据行(不隔行,无底色)
  assert.equal(r2.height, HEIGHT_BODY);
  assert.equal(r2.getCell(1).font.name, FONT);
  assert.equal(r2.getCell(1).font.size, 10);
  assert.ok(r2.getCell(1).border.top.style === 'thin');
  assert.equal(r2.getCell(1).fill, undefined, '奇数数据行无隔行底色');
  const r3 = ws.getRow(3); // 第2数据行(隔行,有极浅底色)
  assert.equal(r3.getCell(1).fill.fgColor.argb, COLORS.stripe);
});

test('applyExcelStyle:对齐按字段类型(姓名左/日期居中/金额右)', () => {
  const ws = buildSheet(['中文姓名', '购买日期', '客人返点金额'], [['张三', '2026-07-01', 100]]);
  applyExcelStyle(ws);
  const row = ws.getRow(2);
  assert.equal(row.getCell(1).alignment.horizontal, 'left');
  assert.equal(row.getCell(2).alignment.horizontal, 'center');
  assert.equal(row.getCell(3).alignment.horizontal, 'right');
});

test('applyExcelStyle:护照/小票/团号强制文本格式 @(防前导零丢失)', () => {
  const ws = buildSheet(['护照号码', '小票号', '团号'], [['M001', '0012345', '00789']]);
  applyExcelStyle(ws);
  const row = ws.getRow(2);
  assert.equal(row.getCell(1).numFmt, '@');
  assert.equal(row.getCell(2).numFmt, '@');
  assert.equal(row.getCell(3).numFmt, '@');
});

test('applyExcelStyle:不覆盖调用方已设 numFmt(保护 monthly 金额锁)', () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('数据');
  ws.columns = [{ header: '总卖出(￦)', key: 'a', style: { numFmt: '#,##0.00' } }];
  ws.addRow([1234.5]);
  applyExcelStyle(ws);
  assert.equal(ws.getRow(2).getCell(1).numFmt, '#,##0.00', '既有 numFmt 必须保留');
});

test('applyExcelStyle:数字金额无 numFmt 时兜底千分位', () => {
  const ws = buildSheet(['交易金额(￦)'], [[1234567]]);
  applyExcelStyle(ws);
  assert.equal(ws.getRow(2).getCell(1).numFmt, '#,##0');
});

test('applyExcelStyle:状态列条件底色(已完成绿/待处理黄/异常红/取消灰)', () => {
  const ws = buildSheet(['状态'], [['已完成'], ['待处理'], ['异常'], ['已取消']]);
  applyExcelStyle(ws);
  assert.equal(ws.getRow(2).getCell(1).fill.fgColor.argb, COLORS.statusDone);
  assert.equal(ws.getRow(3).getCell(1).fill.fgColor.argb, COLORS.statusPending);
  assert.equal(ws.getRow(4).getCell(1).fill.fgColor.argb, COLORS.statusError);
  assert.equal(ws.getRow(5).getCell(1).fill.fgColor.argb, COLORS.statusMuted);
});

test('applyExcelStyle:备注列换行,其它列单行', () => {
  const ws = buildSheet(['备注', '中文姓名'], [['很长的备注', '张三']]);
  applyExcelStyle(ws);
  assert.equal(ws.getRow(2).getCell(1).alignment.wrapText, true);
  assert.equal(ws.getRow(2).getCell(2).alignment.wrapText, false);
});

test('applyExcelStyle:冻结首行 + 自动筛选 + 横向打印表头重复', () => {
  const ws = buildSheet(['中文姓名', '护照号码'], [['张三', 'M1']]);
  applyExcelStyle(ws);
  assert.deepEqual(ws.views, [{ state: 'frozen', xSplit: 0, ySplit: 1 }]);
  assert.ok(ws.autoFilter, '开启自动筛选');
  assert.equal(ws.pageSetup.orientation, 'landscape');
  assert.equal(ws.pageSetup.horizontalCentered, true);
  assert.equal(ws.pageSetup.printTitlesRow, '1:1');
});

test('applyExcelStyle:freezeCols=2 冻结前两列', () => {
  const ws = buildSheet(['序号', '客户组', '护照号码'], [[1, '张三组', 'M1']]);
  applyExcelStyle(ws, { freezeCols: 2 });
  assert.deepEqual(ws.views, [{ state: 'frozen', xSplit: 2, ySplit: 1 }]);
});

test('applyExcelStyle:保留调用方已设 autoFilter 范围(不打破 L1 断言)', () => {
  const ws = buildSheet(['a', 'b'], [['1', '2']]);
  ws.autoFilter = { from: 'A1', to: 'L1' };
  applyExcelStyle(ws);
  assert.equal(ws.autoFilter.to, 'L1', '既有 autoFilter 范围保留');
});

test('applyExcelStyle:保留调用方已设列宽,缺失才兜底', () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('数据');
  ws.columns = [{ header: '小票号', key: 'a', width: 18 }, { header: '备注', key: 'b' }];
  ws.addRow(['0012', 'x']);
  applyExcelStyle(ws);
  assert.equal(ws.getColumn(1).width, 18, '既有列宽保留');
  assert.equal(ws.getColumn(2).width, 32, '备注列缺宽→兜底 32');
});

test('applyExcelStyle:不改列序/列数/单元格值', () => {
  const ws = buildSheet(['中文姓名', '护照号码', '购买日期'], [['张三', 'M1', '2026-07-01']]);
  const before = ws.getRow(2).values.slice();
  applyExcelStyle(ws);
  assert.equal(ws.columnCount, 3);
  assert.deepEqual(ws.getRow(2).values.slice(), before, '单元格值不变');
  assert.equal(ws.getRow(1).getCell(1).value, '中文姓名');
});

test('applyExcelStyle:dataStartRow 支持表头前有标题行', () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('数据');
  ws.getRow(1).getCell(1).value = '标题';
  ws.getRow(2).values = ['中文姓名', '护照号码'];
  ws.getRow(3).values = ['张三', 'M1'];
  applyExcelStyle(ws, { headerRow: 2, columnCount: 2 });
  assert.equal(ws.getRow(2).getCell(1).fill.fgColor.argb, COLORS.headerBg);
  assert.deepEqual(ws.views, [{ state: 'frozen', xSplit: 0, ySplit: 2 }]);
});

// ── 流式版 ───────────────────────────────────────────────────────────────
test('styledColumnDefs:列级字体/对齐/文本格式,保留既有 numFmt', () => {
  const cols = styledColumnDefs([
    { header: '总卖出(￦)', key: 'a', style: { numFmt: '#,##0' } },
    { header: '小票号', key: 'b' },
    { header: '中文姓名', key: 'c' },
  ]);
  assert.equal(cols[0].style.numFmt, '#,##0', '既有 numFmt 保留');
  assert.equal(cols[0].style.alignment.horizontal, 'right');
  assert.equal(cols[0].style.font.name, FONT);
  assert.equal(cols[1].style.numFmt, '@', '小票号补文本格式');
  assert.equal(cols[2].style.alignment.horizontal, 'left');
});

test('styleHeaderRowInPlace / styleBodyRowInPlace:流式就地上样式', () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('数据');
  const columns = [{ header: '状态', key: 's' }, { header: '客人返点金额', key: 'a' }];
  ws.columns = styledColumnDefs(columns);
  const types = resolveColumnTypes(columns);
  styleHeaderRowInPlace(ws.getRow(1), columns.length);
  assert.equal(ws.getRow(1).getCell(1).fill.fgColor.argb, COLORS.headerBg);
  assert.equal(ws.getRow(1).height, HEIGHT_HEADER);

  const r = ws.addRow({ s: '异常', a: 500 });
  styleBodyRowInPlace(r, { types, dataIndex: 1, columnCount: columns.length });
  assert.equal(r.height, HEIGHT_BODY);
  assert.equal(r.getCell(1).fill.fgColor.argb, COLORS.statusError, '状态异常→淡红');
  assert.equal(r.getCell(2).alignment.horizontal, 'right', '金额右对齐');
});

test('statusColorFor:未知状态返回 null(不误上色)', () => {
  assert.equal(statusColorFor('随便什么'), null);
  assert.equal(statusColorFor(''), null);
  assert.equal(statusColorFor(null), null);
});

test('applyExcelStyle:实际可写盘并读回(往返不炸)', async () => {
  const ws = buildSheet(['中文姓名', '小票号', '状态'], [['张三', '00123', '已完成']]);
  const wb = ws.workbook;
  applyExcelStyle(ws);
  const buf = await wb.xlsx.writeBuffer();
  const wb2 = new ExcelJS.Workbook();
  await wb2.xlsx.load(buf);
  const ws2 = wb2.getWorksheet('明细');
  assert.equal(ws2.getRow(1).getCell(1).value, '中文姓名');
  assert.equal(ws2.getRow(2).getCell(2).value, '00123');
  assert.equal(ws2.getRow(2).getCell(2).numFmt, '@');
});
