'use strict';

const fs = require('node:fs');

const ExcelJS = require('exceljs');
// 权威 sheet 名单(直接读 workbook.xml),用于流式完整性守卫
const { readWorkbookSheetNames } = require('./xlsx_sheet_names');

// ⭐0729 生产数据发现:一次 smg_ledger 导入读到 1 048 574 行,而 xlsx 单表上限是 1 048 576。
// 也就是说这张表**是被塞满的** —— 几乎可以肯定源文件在给到我们之前就已经被 Excel 截断:
// 有人把超过一百万行的数据另存为 xlsx,Excel 悄悄切掉了尾巴,而我们照单全收、
// 导入任务显示成功。这是比"流式丢 sheet"更早一步的数据丢失,且完全在我们系统之外发生,
// 我们能做的只有一件事:**认出它并说出来**,否则没人会知道账少了一截。
// 阈值留 8 行余量:不同导出工具对表头/空行的处理差一两行,卡死在等号上会漏报。
const XLSX_MAX_ROWS = 1048576;
// ⚠️0729 当天自我修正:第一版拿 rowCount(迭代行数)判定,**在生产上是误报**。
// 实测 job22「工作簿1.xlsx」7.5MB:总迭代 1 048 574 行,真实数据只有 15 204 行,
// 另外 103 万行全是空行 —— 这种文件是"整列套了格式"导致 Excel 认为整表都有行,
// 很常见,而且完全正常。拿它报「账会少一截」纯属吓人,正是"提醒在健康数据上会亮"
// 这条判据要拦下的东西。
// 正确口径:只数**有内容的行**。真被截断的文件,是一百万行**实数据**顶到天花板。
function atExcelRowLimit(dataRowCount) {
  return Number(dataRowCount) >= XLSX_MAX_ROWS - 8;
}

// 兜底整本载入的体积闸(2026-07-28 审计LOW):workbook.xlsx.readFile 整本载入实测
// 内存放大 ~360×(团号表事故 8.8MB → 3.15GB heap),生产堆上限 3072MB 且 pm2 单实例,
// OOM=全站宕。超阈值的文件宁可抛清晰错误让操作员「另存为」修复文件结构后重走流式,
// 也绝不进整本载入(98MB SMG 总账走到这个兜底必死,且此刻旧总账行已被替换语义清掉)。
const WORKBOOK_FALLBACK_MAX_MB = Number(process.env.XLSX_WORKBOOK_FALLBACK_MAX_MB) || 20;

/**
 * Stream an xlsx file row by row. Uses exceljs stream reader to avoid
 * loading the whole workbook into memory (accounts for the 48MB 收票汇总.xlsx).
 *
 * @param {string} filePath
 * @param {(row: {
 *   sheetName: string,
 *   sheetIndex: number,
 *   rowNumber: number,
 *   headers: string[],
 *   values: Array<*>,
 *   asObject: Record<string, *>,
 * }) => Promise<void> | void} onRow
 * @param {{
 *   sheetFilter?: (name: string, index: number) => boolean,
 *   detectHeader?: (values: Array<*>) => boolean,
 *   headerScanLimit?: number,
 * }} [opts]
 *   detectHeader: 表头行不一定在首行(如操作员收票工作簿首行是标题)。提供它后,
 *     reader 会逐行扫描,直到某行被判为表头才用其作列名;在 headerScanLimit(默认 25)
 *     行内找不到表头的工作表整张跳过(用于自动过滤汇总页/备份页)。不提供则首行=表头(原行为)。
 * @returns {Promise<{ sheets: Array<{ name: string, rowCount: number }> }>}
 */
async function streamRows(filePath, onRow, opts = {}) {
  try {
    // ⭐0729 完整性守卫(补齐):exceljs 的流式 WorkbookReader 对某些 zip entry 顺序的文件
    // **会静默丢掉整个 sheet** —— 不抛错,只是结果残缺。这个 bug 已被实测记录,并且在
    // group_code_multisheet(新版团号表)和 SMG 总账两处**各自**做过守卫,
    // 但共享的 streamRows 一直没有 —— 而老版团号表 / 店铺账单 / 未收清单 / 收票台账迁移 /
    // received_receipt 这 5 条导入路径全走它。丢一整张 sheet = 几十到几千行团号或账单凭空消失,
    // 而导入任务照样 status=done、只是行数变小,前端只显示"读到多少行",没人能发现。
    // 对未收/收票这两张表尤其致命:它们本身就是"哪些票已收/未收"的判定依据。
    const streamed = await streamRowsWithWorkbookReader(filePath, onRow, opts);
    const expected = readWorkbookSheetNames(filePath);
    if (expected.length && streamed.sheets.length < expected.length) {
      // 流式漏了 sheet → 降级整本读取重来一遍(体积闸仍然守着,超大文件照旧抛清晰错误)。
      // 宁可慢一次,也不能让整张 sheet 悄悄消失。
      assertWorkbookFallbackSafe(filePath);
      const full = await readRowsWithWorkbook(filePath, onRow, opts);
      full.recoveredFromStreamSheetLoss = {
        expectedSheets: expected.length, streamedSheets: streamed.sheets.length,
        missing: expected.filter((n) => !streamed.sheets.some((s) => s.name === n)),
      };
      return full;
    }
    return streamed;
  } catch (error) {
    if (!shouldFallbackToWorkbookReader(error)) {
      throw error;
    }
    assertWorkbookFallbackSafe(filePath);
    return readRowsWithWorkbook(filePath, onRow, opts);
  }
}

async function streamRowsWithWorkbookReader(filePath, onRow, opts = {}) {
  const options = {
    entries: 'emit',
    sharedStrings: 'cache',
    hyperlinks: 'ignore',
    styles: 'ignore',
    worksheets: 'emit',
  };
  const workbookReader = new ExcelJS.stream.xlsx.WorkbookReader(filePath, options);
  const sheets = [];
  let sheetIndex = 0;
  for await (const worksheet of workbookReader) {
    sheetIndex += 1;
    const sheetName = worksheet.name || `Sheet${sheetIndex}`;
    if (opts.sheetFilter && !opts.sheetFilter(sheetName, sheetIndex)) {
      for await (const _row of worksheet) { void _row; }
      sheets.push({ name: sheetName, rowCount: 0, skipped: true });
      continue;
    }
    const scanLimit = opts.headerScanLimit || 25;
    let headers = [];
    let headerTaken = false;
    let headerScan = 0;
    let skipSheet = false;
    let rowCount = 0;
    // 有内容的数据行数(空行不算)—— 截断判定只能用它,详见 atExcelRowLimit 上方注释
    let dataRowCount = 0;
    for await (const row of worksheet) {
      if (skipSheet) continue;            // 没找到表头的工作表 → 廉价排空剩余行
      const values = extractValues(row);
      if (!headerTaken) {
        if (opts.detectHeader) {
          headerScan += 1;
          if (opts.detectHeader(values)) {
            headers = values.map((v) => String(v ?? '').trim());
            headerTaken = true;
            rowCount += 1;
          } else if (headerScan >= scanLimit) {
            skipSheet = true;             // 前 scanLimit 行都不是表头 → 整张跳过(汇总/备份页)
          }
          continue;
        }
        headers = values.map((v) => String(v ?? '').trim());
        headerTaken = true;
        rowCount += 1;
        continue;
      }
      const asObject = {};
      for (let i = 0; i < headers.length; i += 1) {
        if (headers[i]) asObject[headers[i]] = values[i];
      }
      await onRow({
        sheetName,
        sheetIndex,
        rowNumber: row.number,
        headers,
        values,
        asObject,
      });
      rowCount += 1;
      // 至少一格有值才算数据行:整列套格式产生的空行必须排除(否则截断判定必误报)
      if (values.some((v) => v !== null && v !== undefined && String(v).trim() !== '')) dataRowCount += 1;
    }
    // 用了 detectHeader 但整张没找到表头 → 标记跳过(含短于 scanLimit 的汇总/备份页)
    const headerSkipped = (opts.detectHeader && !headerTaken) || undefined;
    sheets.push({ name: sheetName, rowCount, dataRowCount, headerSkipped, atExcelRowLimit: atExcelRowLimit(dataRowCount) || undefined });
  }
  return { sheets };
}

async function readRowsWithWorkbook(filePath, onRow, opts = {}) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  const sheets = [];
  for (let i = 0; i < workbook.worksheets.length; i += 1) {
    const worksheet = workbook.worksheets[i];
    const sheetIndex = i + 1;
    const sheetName = worksheet.name || `Sheet${sheetIndex}`;
    if (opts.sheetFilter && !opts.sheetFilter(sheetName, sheetIndex)) {
      sheets.push({ name: sheetName, rowCount: 0, skipped: true });
      continue;
    }

    const scanLimit = opts.headerScanLimit || 25;
    let headers = [];
    let headerTaken = false;
    let headerScan = 0;
    let skipSheet = false;
    let rowCount = 0;
    // 有内容的数据行数(空行不算)—— 截断判定只能用它,详见 atExcelRowLimit 上方注释
    let dataRowCount = 0;
    for (let rowNumber = 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
      if (skipSheet) break;
      const row = worksheet.getRow(rowNumber);
      if (!row.hasValues) continue;
      const values = extractValues(row);
      if (!headerTaken) {
        if (opts.detectHeader) {
          headerScan += 1;
          if (opts.detectHeader(values)) {
            headers = values.map((v) => String(v ?? '').trim());
            headerTaken = true;
            rowCount += 1;
          } else if (headerScan >= scanLimit) {
            skipSheet = true;
          }
          continue;
        }
        headers = values.map((v) => String(v ?? '').trim());
        headerTaken = true;
        rowCount += 1;
        continue;
      }
      const asObject = {};
      for (let j = 0; j < headers.length; j += 1) {
        if (headers[j]) asObject[headers[j]] = values[j];
      }
      await onRow({
        sheetName,
        sheetIndex,
        rowNumber: row.number,
        headers,
        values,
        asObject,
      });
      rowCount += 1;
      // 至少一格有值才算数据行:整列套格式产生的空行必须排除(否则截断判定必误报)
      if (values.some((v) => v !== null && v !== undefined && String(v).trim() !== '')) dataRowCount += 1;
    }
    const headerSkipped = (opts.detectHeader && !headerTaken) || undefined;
    sheets.push({ name: sheetName, rowCount, dataRowCount, headerSkipped, atExcelRowLimit: atExcelRowLimit(dataRowCount) || undefined });
  }
  return { sheets };
}

// 只在流式解析已失败、准备整本载入前调用。stat 不到(路径错/被并发清理)不在这兜,
// 让 readFile 自己抛出真实的 IO 错误。maxMb 可注入仅为测试,生产走 env/默认 20MB。
function assertWorkbookFallbackSafe(filePath, { maxMb = WORKBOOK_FALLBACK_MAX_MB } = {}) {
  let sizeBytes;
  try {
    sizeBytes = fs.statSync(filePath).size;
  } catch {
    return;
  }
  if (sizeBytes <= maxMb * 1024 * 1024) return;
  const sizeMb = (sizeBytes / 1024 / 1024).toFixed(1);
  const err = new Error(
    `文件流式解析失败,且体积过大(${sizeMb}MB,整本载入上限 ${maxMb}MB),已拒绝整本载入以免耗尽内存拖垮全站。`
    + '请用 Excel 打开该文件「另存为 .xlsx」修复内部结构后重试'
  );
  err.statusCode = 413;
  err.code = 'xlsx_fallback_too_large';
  throw err;
}

function shouldFallbackToWorkbookReader(error) {
  const message = error?.message || '';
  const stack = error?.stack || '';
  return (
    message.includes("Cannot read properties of undefined (reading 'sheets')") ||
    stack.includes('exceljs\\lib\\stream\\xlsx\\workbook-reader') ||
    stack.includes('exceljs/lib/stream/xlsx/workbook-reader')
  );
}

function extractValues(row) {
  const out = [];
  const raw = row.values;
  if (!Array.isArray(raw)) return out;
  for (let i = 1; i < raw.length; i += 1) {
    out.push(flatten(raw[i]));
  }
  return out;
}

function flatten(v) {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v !== 'object') return v;
  if (typeof v.text === 'string') return v.text;
  if (Array.isArray(v.richText)) return v.richText.map((p) => p.text).join('');
  if (v.result !== undefined) return flatten(v.result);
  if (v.formula !== undefined && v.sharedFormula === undefined) return null;
  if (v.hyperlink && typeof v.text === 'string') return v.text;
  // 未知对象单元格(富文本/公式残留等):绝不把对象原样返回,否则下游 String(obj)
  // 会得到 "[object Object]" 被当成真实值(曾导致出现 [object Object] 的"模式")。当空处理。
  return null;
}

module.exports = {
  streamRows,
  atExcelRowLimit, // 0729:源文件被 Excel 行数上限截断的判定(供直测与上层告警)
  XLSX_MAX_ROWS,
  assertWorkbookFallbackSafe,
};
