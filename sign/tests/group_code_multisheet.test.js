'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');

const {
  extractMultisheetGroupCode,
  isMultisheetWorkbook,
  __getParseWorkerStats,
} = require('../lib/monthly_pipeline/group_code_multisheet');

async function writeWorkbook(file) {
  const wb = new ExcelJS.Workbook();
  // 爱宝客SG:左右双块(团号在 col1 和 col6)
  const ab = wb.addWorksheet('爱宝客SG');
  ab.addRow(['爱宝客SG', null, null, null, null, '爱宝客PKG']);
  ab.addRow(['团号', '代理', null, null, null, '团号', '代理']);
  ab.addRow([32000, 'AAA', null, null, null, 33000, 'Andy']);
  ab.addRow([32001, 'BBB', null, null, null, 33001, 'Cindy']);
  // 乐天团号:团号 col4, 代理 col5
  const lt = wb.addWorksheet('乐天团号');
  lt.addRow([null, '截止', '入店公司', '团号', '代理']);
  lt.addRow(['', '', '新琪', 26107001, 'XFG']);
  // 纯导游 sheet:应被跳过
  const guide = wb.addWorksheet('乐天导游');
  guide.addRow(['入店导游', '电话', '团号']);
  guide.addRow(['김성국', '010', 99999]);
  await wb.xlsx.writeFile(file);
}

test('extractMultisheetGroupCode: 双块都抽到 + 跳过非团号sheet', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcms-'));
  const file = path.join(dir, 'group.xlsx');
  try {
    await writeWorkbook(file);
    const { rows, sheetNames } = await extractMultisheetGroupCode({ filePath: file, workspaceKey: '2026-02' });
    const tours = new Set(rows.map((r) => r.tourNo));
    // 爱宝客SG 左块 + 右块都抽到
    assert.ok(tours.has('32000') && tours.has('32001'), '爱宝客SG 左块');
    assert.ok(tours.has('33000') && tours.has('33001'), '爱宝客PKG 右块');
    // 乐天团号
    assert.ok(tours.has('26107001'), '乐天团号');
    // 乐天导游(99999)不在配置 → 不抽
    assert.ok(!tours.has('99999'), '导游sheet应跳过');
    // 模式来自团号表 → 操作员在「模式归类」选模式→桶;代理留空(团号表代理口径与收票不一致)
    const modeByTour = new Map(rows.map((r) => [r.tourNo, r.mode]));
    assert.equal(modeByTour.get('32000'), '爱宝客SG', '爱宝客左块=爱宝客SG');
    assert.equal(modeByTour.get('33000'), '爱宝客PKG', '爱宝客右块=爱宝客PKG');
    assert.equal(modeByTour.get('26107001'), '乐天SG', '乐天团号列6空+261号段→乐天SG');
    assert.ok(rows.every((r) => r.mode), '模式都有值(来自团号表)');
    assert.ok(rows.every((r) => r.agent == null), '代理应留空');
    assert.ok(isMultisheetWorkbook(sheetNames));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('解析结果按文件内容缓存:二次导入跳过解析、行一致;异 workspaceKey 命中缓存但 rowHash 随之变', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcms-cache-'));
  const file = path.join(dir, 'group.xlsx');
  try {
    await writeWorkbook(file);
    const a = await extractMultisheetGroupCode({ filePath: file, workspaceKey: '2026-02' });
    const b = await extractMultisheetGroupCode({ filePath: file, workspaceKey: '2026-02' });
    // 同一份文件 + 同 workspaceKey:两次结果逐字段一致(缓存不改变输出)
    const fp = (rows) => rows.map((r) => `${r.tourNo}:${r.mode}:${r.rowHash}`).sort().join('|');
    assert.equal(fp(a.rows), fp(b.rows), '二次导入(缓存命中)行集合完全一致');

    // 异 workspaceKey:tour/mode 集合相同(内容缓存命中),但 rowHash 依赖 workspaceKey 必须不同
    const c = await extractMultisheetGroupCode({ filePath: file, workspaceKey: '2026-07' });
    assert.equal(
      a.rows.map((r) => `${r.tourNo}:${r.mode}`).sort().join('|'),
      c.rows.map((r) => `${r.tourNo}:${r.mode}`).sort().join('|'),
      '异 workspaceKey 的 tour/mode 集合相同',
    );
    const aHash = a.rows.find((r) => r.tourNo === '32000')?.rowHash;
    const cHash = c.rows.find((r) => r.tourNo === '32000')?.rowHash;
    assert.ok(aHash && cHash && aHash !== cHash, '异 workspaceKey 同团号的 rowHash 必须不同');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('并发闸:N 个不同文件同时解析,峰值 worker 数不超过上限', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcms-sem-'));
  try {
    // 6 份内容互不相同的小表(变一个 cell → hash 不同 → 不会被去重合并)
    const files = [];
    for (let i = 0; i < 6; i += 1) {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('爱宝客SG');
      ws.addRow(['爱宝客SG']);
      ws.addRow(['团号', '代理']);
      ws.addRow([32000 + i, `A${i}`]);
      const f = path.join(dir, `g${i}.xlsx`);
      await wb.xlsx.writeFile(f);
      files.push(f);
    }
    const results = await Promise.all(
      files.map((f, i) => extractMultisheetGroupCode({ filePath: f, workspaceKey: `ws-${i}` })),
    );
    const stats = __getParseWorkerStats();
    assert.ok(stats.peak <= stats.max, `峰值 ${stats.peak} 不应超过上限 ${stats.max}`);
    assert.equal(stats.active, 0, '全部结束后并发数应归 0');
    assert.ok(results.every((r) => r.rows.length === 1), '每份各抽到 1 个团号');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('并发去重:同一份新表 N 个并发只解析一次,结果全部一致', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcms-conc-'));
  const file = path.join(dir, 'group.xlsx');
  try {
    await writeWorkbook(file);
    const N = 8;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        extractMultisheetGroupCode({ filePath: file, workspaceKey: `ws-${i}` })),
    );
    const baseTours = results[0].rows.map((r) => r.tourNo).sort().join('|');
    for (const r of results) {
      assert.equal(r.rows.map((x) => x.tourNo).sort().join('|'), baseTours, '并发结果团号集合一致');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// F1 完整性守卫(2026-07-21 复核 CRITICAL):流式 WorkbookReader 对某些 zip entry 顺序会静默丢
// 整个 sheet(不抛错但结果残缺)。守卫对照 workbook.xml 权威 sheet 数,少读则降级 readFile。
// readWorkbookSheetCount 是守卫依据——直接解 xlsx(zip)的 workbook.xml 数 <sheet> 声明。
test('readWorkbookSheetCount:正确数出 workbook.xml 声明的 sheet 数(守卫依据)', async () => {
  const { readWorkbookSheetCount } = require('../lib/monthly_pipeline/group_code_multisheet');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcsc-'));
  const file = path.join(dir, 'wb.xlsx');
  try {
    const wb = new ExcelJS.Workbook();
    ['乐天团号', '新罗 首尔&济州', '爱宝客SG', '乐天导游'].forEach((n) => {
      wb.addWorksheet(n).addRow(['x']);
    });
    await wb.xlsx.writeFile(file);
    assert.equal(readWorkbookSheetCount(file), 4, '4 个 sheet 全部数到');
    assert.equal(readWorkbookSheetCount(path.join(dir, 'nope.xlsx')), 0, '文件不存在 → 0(守卫不介入,不阻断)');
    // 非 zip(纯文本)→ 0,守卫退回原行为
    const txt = path.join(dir, 'plain.txt'); fs.writeFileSync(txt, 'not a zip');
    assert.equal(readWorkbookSheetCount(txt), 0, '非 zip → 0');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
