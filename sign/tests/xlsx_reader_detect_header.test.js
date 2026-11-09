'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');

const { streamRows } = require('../lib/monthly_pipeline/xlsx_reader');
const { isDailyLedgerHeaderRow } = require('../lib/monthly_pipeline/daily_receipt_mapper');

async function writeWorkbook(filePath, sheets) {
  const wb = new ExcelJS.Workbook();
  for (const { name, rows } of sheets) {
    const ws = wb.addWorksheet(name);
    for (const r of rows) ws.addRow(r);
  }
  await wb.xlsx.writeFile(filePath);
}

test('detectHeader: 表头在第2行(首行是标题)也能正确取列名', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xlsxhdr-'));
  const file = path.join(dir, 'ledger.xlsx');
  await writeWorkbook(file, [{
    name: '1号 张三',
    rows: [
      ['收票按照下面格式填信息'],                                   // 标题行
      ['收票日期', '购买日期', '小票号', '团号', '姓名', '护照号'],   // 真表头(第2行)
      ['2026-01-05', '2026-01-03', 'R001', 'T100', 'KIM', 'P1'],
      ['2026-01-06', '2026-01-04', 'R002', 'T100', 'LEE', 'P2'],
    ],
  }]);

  const seen = [];
  await streamRows(file, ({ asObject }) => { seen.push(asObject); },
    { sheetFilter: () => true, detectHeader: isDailyLedgerHeaderRow });

  assert.equal(seen.length, 2, '应只产出 2 行数据(标题行/表头行不算数据)');
  assert.equal(seen[0]['小票号'], 'R001');
  assert.equal(seen[0]['护照号'], 'P1');
  assert.equal(seen[1]['团号'], 'T100');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('detectHeader: 没有台账表头的汇总/备份页整张跳过', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xlsxhdr-'));
  const file = path.join(dir, 'mixed.xlsx');
  await writeWorkbook(file, [
    { name: '收票数统计', rows: [['星期', '姓名', '收票数量'], ['一', '王五', 10], ['二', '赵六', 20]] },
    { name: '团号汇总', rows: [['申请日期', '团号', '模式', '护照号'], ['x', 'T1', 'SG', 'P9']] },  // 有团号/护照号但无小票号 → 不是台账
    { name: '3号 李四', rows: [
      ['收票日期', '购买日期', '小票号', '团号', '姓名', '护照号'],
      ['2026-01-05', '2026-01-03', 'R900', 'T200', 'PARK', 'P3'],
    ] },
  ]);

  const sheetsSeen = new Set();
  let dataRows = 0;
  const sum = await streamRows(file, ({ sheetName }) => { sheetsSeen.add(sheetName); dataRows += 1; },
    { sheetFilter: () => true, detectHeader: isDailyLedgerHeaderRow });

  assert.equal(dataRows, 1, '只有台账页 1 行数据进入');
  assert.ok(sheetsSeen.has('3号 李四'));
  assert.ok(!sheetsSeen.has('收票数统计'));
  assert.ok(!sheetsSeen.has('团号汇总'));
  const skipped = sum.sheets.filter((s) => s.headerSkipped).map((s) => s.name);
  assert.ok(skipped.includes('收票数统计'));
  assert.ok(skipped.includes('团号汇总'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('isDailyLedgerHeaderRow: 判定规则', () => {
  assert.equal(isDailyLedgerHeaderRow(['收票日期', '购买日期', '小票号', '团号', '护照号']), true);
  assert.equal(isDailyLedgerHeaderRow(['小票号', '购买日期', '姓名']), true);   // 小票号 + 2 信号
  assert.equal(isDailyLedgerHeaderRow(['小票号']), false);                      // 只有小票号,信号不足
  assert.equal(isDailyLedgerHeaderRow(['申请日期', '团号', '模式', '护照号']), false); // 无小票号 → 团号页
  assert.equal(isDailyLedgerHeaderRow(['星期', '姓名', '收票数量']), false);     // 汇总页
  assert.equal(isDailyLedgerHeaderRow([]), false);
  assert.equal(isDailyLedgerHeaderRow(null), false);
});

test('detectHeader 不传时保持原行为:首行即表头', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xlsxhdr-'));
  const file = path.join(dir, 'plain.xlsx');
  await writeWorkbook(file, [{
    name: 'Sheet1',
    rows: [['团号', '模式'], ['T1', 'SG'], ['T2', 'PKG']],
  }]);
  const seen = [];
  await streamRows(file, ({ asObject }) => { seen.push(asObject); }, { sheetFilter: () => true });
  assert.equal(seen.length, 2);
  assert.equal(seen[0]['团号'], 'T1');
  fs.rmSync(dir, { recursive: true, force: true });
});
