'use strict';

/**
 * xlsx 完整性守卫不许把「图表页」当成漏读的数据页(2026-08-01)。
 *
 * 背景:lib/monthly_pipeline/xlsx_reader 有一道守卫 ——
 *   `streamed.sheets.length < expected.length` → 认为流式漏了 sheet,
 *   降级成整本 workbook.readFile 重来一遍。
 * 这道守卫本身是对的(丢一整张 sheet = 几千行团号/账单凭空消失,而任务照样 done)。
 *
 * 错在**两边数的不是同一种东西**:
 *   expected 来自 xl/workbook.xml 的 <sheets>,那里列的是**全部**表 ——
 *     图表页(chartsheet)、对话页、宏表,和数据页长得一模一样,
 *     类型只写在 xl/_rels/workbook.xml.rels 的 Relationship Type 上;
 *   streamed 只统计 exceljs WorkbookReader 迭代到的 **worksheet**。
 *
 * 于是**只要源文件里有一张图表页,守卫就恒成立**,后果两条:
 *   ① 每次导入都白跑一遍整本载入(xlsx_reader 自己的注释记着实测内存放大约 360 倍,
 *      8.8MB → 3.15GB heap);
 *   ② 超过 WORKBOOK_FALLBACK_MAX_MB(默认 20MB)直接抛 413 ——
 *      本来能成功的 48MB 收票汇总 / 98MB SMG 总账导入**变成失败**。
 * 五条导入路径全走这个守卫(老版团号表 / 店铺账单 / 未收清单 / 收票台账迁移 / received_receipt)。
 *
 * 为什么一直没被发现:所有 xlsx 夹具都是 exceljs 现场生成的,**exceljs 造不出图表页**,
 * 所以本机和 CI 都测不到。这条测试因此手工拼一个含 chartsheet 的 xlsx。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const JSZip = require('jszip');
const ExcelJS = require('exceljs');

const { readWorkbookSheetNames } = require('../../lib/monthly_pipeline/xlsx_sheet_names');

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/chartsheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.chartsheet+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

// 关键:两个 <sheet> 在 workbook.xml 里**完全同形**,分不出谁是图表页
const WORKBOOK = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="数据" sheetId="1" r:id="rId1"/><sheet name="图表" sheetId="2" r:id="rId2"/></sheets>
</workbook>`;

const WB_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chartsheet" Target="chartsheets/sheet1.xml"/>
</Relationships>`;

const SHEET1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>团号</t></is></c></row>
<row r="2"><c r="A2" t="inlineStr"><is><t>T-0001</t></is></c></row>
</sheetData></worksheet>`;

const CHARTSHEET = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<chartsheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetPr/><sheetViews><sheetView workbookViewId="0"/></sheetViews></chartsheet>`;

async function buildXlsx(dir, { withChartsheet }) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', withChartsheet
    ? CONTENT_TYPES
    : CONTENT_TYPES.replace(/<Override PartName="\/xl\/chartsheets[^>]*\/>\n?/, ''));
  zip.file('_rels/.rels', ROOT_RELS);
  zip.file('xl/workbook.xml', withChartsheet
    ? WORKBOOK
    : WORKBOOK.replace('<sheet name="图表" sheetId="2" r:id="rId2"/>', ''));
  zip.file('xl/_rels/workbook.xml.rels', withChartsheet
    ? WB_RELS
    : WB_RELS.replace(/<Relationship Id="rId2"[^>]*\/>\n?/, ''));
  zip.file('xl/worksheets/sheet1.xml', SHEET1);
  if (withChartsheet) zip.file('xl/chartsheets/sheet1.xml', CHARTSHEET);
  const file = path.join(dir, withChartsheet ? 'with_chart.xlsx' : 'plain.xlsx');
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  return file;
}

async function streamedSheetCount(file) {
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(file, {
    worksheets: 'emit', sharedStrings: 'cache',
  });
  let n = 0;
  for await (const ws of reader) {
    n += 1;
    // 不把行读干净,reader 不会前进
     
    for await (const _row of ws) { /* drain */ }
  }
  return n;
}

test('⭐图表页不算进期望 sheet 数(否则完整性守卫恒成立→每次导入都整本载入)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chartsheet_'));
  try {
    const file = await buildXlsx(dir, { withChartsheet: true });
    const expected = readWorkbookSheetNames(file);
    const streamed = await streamedSheetCount(file);

    assert.deepEqual(expected, ['数据'],
      `期望值必须只含能读出数据的表,实际 ${JSON.stringify(expected)}`);
    assert.equal(streamed, 1, '前提校验:exceljs 只迭代 worksheet');
    assert.ok(!(streamed < expected.length),
      `守卫会误触发(streamed=${streamed} < expected=${expected.length})`
      + ' → 每次导入白跑整本载入,>20MB 的文件直接 413 失败');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('没有图表页时行为不变(别为了修这条把正常文件也改坏)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chartsheet_'));
  try {
    const file = await buildXlsx(dir, { withChartsheet: false });
    assert.deepEqual(readWorkbookSheetNames(file), ['数据']);
    assert.equal(await streamedSheetCount(file), 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('读不到 rels 时保持原行为返回全部(宁可多跑一次兜底,也别漏掉真的丢表)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chartsheet_'));
  try {
    // 造一个缺 xl/_rels/workbook.xml.rels 的包:类型无从判断
    const zip = new JSZip();
    zip.file('[Content_Types].xml', CONTENT_TYPES);
    zip.file('_rels/.rels', ROOT_RELS);
    zip.file('xl/workbook.xml', WORKBOOK);
    zip.file('xl/worksheets/sheet1.xml', SHEET1);
    const file = path.join(dir, 'no_rels.xlsx');
    fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));

    assert.deepEqual(readWorkbookSheetNames(file), ['数据', '图表'],
      '解析不出类型时必须保守:全部返回,让守卫照旧兜底');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('守卫本身还在(这条修的是它的判据,不是把它拆了)', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'lib', 'monthly_pipeline', 'xlsx_reader.js'), 'utf8',
  );
  assert.match(src, /streamed\.sheets\.length < expected\.length/,
    '丢整张 sheet 的兜底不许拆掉 —— 那是"几千行凭空消失"的唯一防线');
});
