'use strict';

// 全系统所有 Excel 导出的**唯一**样式规范与实现(交付修改:统一美化)。
// 设计铁律:只加「视觉层」——字体/表头色/隔行填充/细边框/行高/对齐/文本格式/冻结/
// 自动筛选/打印设置。**绝不**改动列序、列数、单元格值、表头行号、以及调用方已显式
// 设置的 numFmt / 列宽 / autoFilter 范围。这样既满足统一美化,又不打破既有值断言。
//
// 两条集成路径(共用同一套常量与判定,保证所有导出观感一致):
//   ① 内存版 applyExcelStyle(worksheet, opts):new ExcelJS.Workbook() 且 addRow 完毕后一次性上样式。
//   ② 流式版 styledColumnDefs / styleHeaderRowInPlace / styleBodyRowInPlace:
//      ExcelJS.stream.xlsx.WorkbookWriter 逐行 commit 场景,列级样式 + 每行 commit 前就地上样式。

const FONT = '微软雅黑';
const SIZE_BODY = 10;
const SIZE_HEADER = 11;
const HEIGHT_BODY = 22;
const HEIGHT_HEADER = 28;

// ARGB 配色(克制:表头深蓝灰 + 白字;正文白/极浅灰蓝隔行;细灰边框;状态浅色)
const COLORS = Object.freeze({
  headerBg: 'FF44546A', // 深蓝灰
  headerFont: 'FFFFFFFF', // 白
  stripe: 'FFF3F6FA', // 极浅灰蓝(隔行)
  border: 'FFD9D9D9', // 浅灰细边框
  statusDone: 'FFE2EFDA', // 淡绿(已完成)
  statusPending: 'FFFFF2CC', // 淡黄(待处理)
  statusError: 'FFF8D7DA', // 淡红(异常)
  statusMuted: 'FFEDEDED', // 浅灰(已取消/无需处理)
});

// 字段类型 → 水平对齐(需求 6)
const TYPE_ALIGN = Object.freeze({
  name: 'left', // 姓名/代理/店名/上家/品牌/备注类文本
  id_text: 'center', // 护照/小票/客户编号(强制文本)
  tour: 'center', // 团号(强制文本 + 居中)
  amount: 'right', // 金额/返点/点数
  date: 'center', // 日期
  status: 'center', // 状态
  mode: 'center', // 模式
  count: 'center', // 数量
  note: 'left', // 备注/异常原因(左 + 换行)
  other: 'left',
});

// 字段类型缺省列宽(需求 11:不全依赖自动列宽;仅当调用方未给宽度时兜底)
const DEFAULT_WIDTH = Object.freeze({
  name: 18, id_text: 20, tour: 16, amount: 14, date: 14,
  status: 12, mode: 22, count: 10, note: 32, other: 14,
});

const TEXT_TYPES = new Set(['id_text', 'tour']); // 需求 7:强制文本格式,防前导零丢失/科学计数
const WRAP_TYPES = new Set(['note']); // 需求 10:仅备注/异常原因自动换行

// 表头文本 → 字段类型推断(可被调用方 fieldTypeByHeader / fieldTypes 覆盖)
function inferFieldType(header = '') {
  const h = String(header || '');
  if (/护照|小票号|票号|客户编号|客户号|交易编号|交易号|序号|系统.*ID|台账ID|账单ID|行号/i.test(h)) return 'id_text';
  if (/团号/.test(h)) return 'tour';
  if (/模式/.test(h)) return 'mode'; // 「返点模式」等要先于金额判定(含「返点」二字但本质是模式列)
  if (/金额|返点|点数|卖出|单价|价格|费用|折扣(?!率)|￦|美元|韩元|\bKRW\b|\bUSD\b|\(￦\)|\(\$\)/i.test(h)) return 'amount';
  if (/日期|时间|出境|离境|入境/.test(h)) return 'date';
  if (/状态/.test(h)) return 'status';
  if (/数量|张数|件数|笔数|个数/.test(h)) return 'count';
  if (/备注|异常|原因|说明|注释|摘要/.test(h)) return 'note';
  if (/姓名|代理|店|上家|品牌|门店|负责人|名称|收货|地址|供应商|客户组/.test(h)) return 'name';
  return 'other';
}

// 状态文本 → 浅色底色(需求 13;仅对该单元格,不整行;需求 14)
function statusColorFor(value) {
  const t = String(value == null ? '' : value).trim();
  if (!t) return null;
  if (/已完成|完成|已通过|通过|已收|已结算|已交付|正常|成功|matched/i.test(t)) return COLORS.statusDone;
  if (/待处理|待收|待确认|待|处理中|进行中|在途|排队|pending/i.test(t)) return COLORS.statusPending;
  if (/异常|错误|失败|冲突|缺|漏|驳回|error|fail|reject/i.test(t)) return COLORS.statusError;
  if (/已取消|取消|无需|无须|不用|忽略|作废|跳过|cancel|skip/i.test(t)) return COLORS.statusMuted;
  return null;
}

function thinSide() {
  return { style: 'thin', color: { argb: COLORS.border } };
}
function allBorders() {
  return { top: thinSide(), left: thinSide(), right: thinSide(), bottom: thinSide() };
}

// ── 单元格级(就地)——内存版与流式版共用 ────────────────────────────────
function styleHeaderCell(cell) {
  cell.font = { name: FONT, size: SIZE_HEADER, bold: true, color: { argb: COLORS.headerFont } };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.headerBg } };
  cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  cell.border = allBorders();
}

function styleBodyCell(cell, type = 'other', zebra = false) {
  const t = TYPE_ALIGN[type] ? type : 'other';
  cell.font = { name: FONT, size: SIZE_BODY };
  cell.alignment = { horizontal: TYPE_ALIGN[t], vertical: 'middle', wrapText: WRAP_TYPES.has(t) };
  cell.border = allBorders();
  // 隔行底色;状态列条件底色优先覆盖
  let fillArgb = zebra ? COLORS.stripe : null;
  if (t === 'status') {
    const s = statusColorFor(cell.value);
    if (s) fillArgb = s;
  }
  if (fillArgb) {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fillArgb } };
  }
  // 数字格式:仅在调用方未显式设过 numFmt 时兜底(保护 monthly 的 #,##0 / #,##0.00 / 0.00% 锁)
  if (!cell.numFmt) {
    if (TEXT_TYPES.has(t)) cell.numFmt = '@';
    else if (t === 'amount' && typeof cell.value === 'number') cell.numFmt = '#,##0';
    else if (t === 'date' && cell.value instanceof Date) cell.numFmt = 'yyyy-mm-dd';
  }
}

// 每列字段类型解析(fieldTypes 数组 > fieldTypeByHeader > 表头推断)
function resolveTypes(worksheet, headerRow, columnCount, options) {
  const byIndex = Array.isArray(options.fieldTypes) ? options.fieldTypes : null;
  const byHeader = options.fieldTypeByHeader || {};
  const hr = worksheet.getRow(headerRow);
  const types = [];
  for (let c = 1; c <= columnCount; c += 1) {
    if (byIndex && byIndex[c - 1]) {
      types.push(byIndex[c - 1]);
      continue;
    }
    const header = String(hr.getCell(c).value == null ? '' : hr.getCell(c).value);
    types.push(byHeader[header] || inferFieldType(header));
  }
  return types;
}

function applyColumnWidths(worksheet, columnCount, types) {
  for (let c = 1; c <= columnCount; c += 1) {
    const col = worksheet.getColumn(c);
    const w = Number(col.width);
    // exceljs 对未显式设宽的列返回 ~8.43 默认值,故 <=10 视为"未设/过窄"→按字段类型兜底预设宽度
    // (需求 11:不全依赖自动列宽;调用方显式设的 >10 宽度一律保留,含 monthly 的锁)。
    if (!Number.isFinite(w) || w <= 10) {
      col.width = DEFAULT_WIDTH[types[c - 1]] || DEFAULT_WIDTH.other;
    }
  }
}

function applyPrintSetup(worksheet, headerRow) {
  worksheet.pageSetup = {
    ...(worksheet.pageSetup || {}),
    orientation: 'landscape', // 需求 15:横向
    horizontalCentered: true, // 水平居中
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    margins: { left: 0.3, right: 0.3, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 }, // 窄边距
  };
  worksheet.pageSetup.printTitlesRow = `${headerRow}:${headerRow}`; // 表头每页重复
}

/**
 * 内存版:worksheet 已 addRow 完毕后一次性上样式。
 * options:
 *   headerRow=1 表头所在行
 *   freezeCols=0 额外冻结左侧列数(需求 8:有序号/客户组时传 2)
 *   fieldTypes / fieldTypeByHeader 覆盖字段类型推断
 *   columnCount 显式列数(默认取 worksheet.columnCount)
 *   dataStartRow 数据起始行(默认 headerRow+1;用于表头前有标题行的表)
 *   skipEmptyRows=true 跳过 cellCount=0 的空行(隔行计数不含空行)
 */
function applyExcelStyle(worksheet, options = {}) {
  const headerRow = options.headerRow || 1;
  const freezeCols = options.freezeCols || 0;
  const columnCount = options.columnCount
    || worksheet.columnCount
    || worksheet.getRow(headerRow).cellCount
    || 0;
  if (!columnCount) return worksheet;

  const types = resolveTypes(worksheet, headerRow, columnCount, options);
  applyColumnWidths(worksheet, columnCount, types);

  // 表头
  const hr = worksheet.getRow(headerRow);
  hr.height = HEIGHT_HEADER;
  for (let c = 1; c <= columnCount; c += 1) styleHeaderCell(hr.getCell(c));

  // 正文(隔行计数只数非空数据行)
  const dataStart = options.dataStartRow || headerRow + 1;
  const lastRow = worksheet.rowCount;
  let dataIdx = 0;
  for (let r = dataStart; r <= lastRow; r += 1) {
    const row = worksheet.getRow(r);
    if (options.skipEmptyRows !== false && row.cellCount === 0) continue;
    dataIdx += 1;
    row.height = HEIGHT_BODY;
    const zebra = dataIdx % 2 === 0;
    for (let c = 1; c <= columnCount; c += 1) styleBodyCell(row.getCell(c), types[c - 1], zebra);
  }

  // 冻结首行(+左侧关键列)(需求 8)
  worksheet.views = [{ state: 'frozen', xSplit: freezeCols, ySplit: headerRow }];
  // 自动筛选(需求 9;保留调用方已设范围,避免打破既有断言)
  if (!worksheet.autoFilter) {
    worksheet.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: headerRow, column: columnCount } };
  }
  applyPrintSetup(worksheet, headerRow);
  return worksheet;
}

// ── 流式版:逐行 commit 场景 ─────────────────────────────────────────────
/**
 * 建列定义:width + 列级 font/alignment/文本格式,保留调用方已给的 style(尤其 numFmt)。
 * columns: [{ header, key, width?, style?, fieldType? }]
 */
function styledColumnDefs(columns = [], options = {}) {
  const byHeader = options.fieldTypeByHeader || {};
  return columns.map((col) => {
    const type = col.fieldType || byHeader[col.header] || inferFieldType(col.header);
    const width = col.width || DEFAULT_WIDTH[type] || DEFAULT_WIDTH.other;
    const style = {
      ...(col.style || {}),
      font: { name: FONT, size: SIZE_BODY },
      alignment: { horizontal: TYPE_ALIGN[type] || 'left', vertical: 'middle', wrapText: WRAP_TYPES.has(type) },
    };
    if (!style.numFmt && TEXT_TYPES.has(type)) style.numFmt = '@';
    return { header: col.header, key: col.key, width, style };
  });
}

// 流式表头行就地上样式(sheet.columns 设完、加数据行之前调)
function styleHeaderRowInPlace(row, columnCount) {
  const n = columnCount || row.cellCount;
  row.height = HEIGHT_HEADER;
  for (let c = 1; c <= n; c += 1) styleHeaderCell(row.getCell(c));
}

// 流式正文行就地上样式(addRow 之后、commit 之前调);dataIndex 从 1 起决定隔行
function styleBodyRowInPlace(row, { types = [], dataIndex = 1, columnCount } = {}) {
  const n = columnCount || types.length || row.cellCount;
  row.height = HEIGHT_BODY;
  const zebra = dataIndex % 2 === 0;
  for (let c = 1; c <= n; c += 1) styleBodyCell(row.getCell(c), types[c - 1] || 'other', zebra);
}

// 供流式调用方按同一口径解析每列类型
function resolveColumnTypes(columns = [], options = {}) {
  const byHeader = options.fieldTypeByHeader || {};
  return columns.map((col) => col.fieldType || byHeader[col.header] || inferFieldType(col.header));
}

module.exports = {
  FONT,
  COLORS,
  applyExcelStyle,
  styledColumnDefs,
  styleHeaderRowInPlace,
  styleBodyRowInPlace,
  resolveColumnTypes,
  inferFieldType,
  statusColorFor,
  // 常量导出便于测试与个别微调
  SIZE_BODY,
  SIZE_HEADER,
  HEIGHT_BODY,
  HEIGHT_HEADER,
};
