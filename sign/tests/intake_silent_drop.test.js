'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');

// ── A1:重识别回灌批次失败,前端一处都不消费 ───────────────────────────────
// 后端注释原话:「报 batchAppendError 让操作员用『补图/追加』自愈」—— 意图就是给人看的。
// 但前端拿到 payload 后只读无关字段,不管成败都弹「客户预处理已提交」。
// 后果:重识别新切出的图(可能正是那张漏切的护照)留在客户库,永远不会变成审核任务
// —— 不进审核台、不被识别、不进交付、不参与结算,而操作员看到的是"成功"。
// 这正是 2026-07-22「缺护照」生产事故的复现路径,触发点换成了"回灌本身失败"。
test('重识别:回灌失败必须说出来,且说清图还留在哪、怎么自愈', () => {
  const src = fs.readFileSync(path.join(__dirname, '../frontend/src/stores/customer.js'), 'utf8');
  assert.match(src, /payload\?\.batchAppendError/, '必须消费后端给的错误');
  assert.match(src, /没能进回审核批次/, '说清后果');
  assert.match(src, /还留在客户库里/, '说清图在哪(不是丢了)');
  assert.match(src, /补图/, '给出自愈动作');
  assert.match(src, /不会进审核台/, '说清不处理的下场');
  // 成功路径也要说清补进了几张,否则操作员无从判断重识别到底改变了什么
  assert.match(src, /payload\?\.batchAppend\?\.appendedTasks > 0/);
  // 旧的"不管成败都说已提交"必须下线
  assert.doesNotMatch(src, /const payload = await preprocessCustomerApi\([^)]*\)\s*\r?\n[\s\S]{0,200}this\.setMessage\('客户预处理已提交'\)\s*\r?\n\s*return payload/);
});

// ── A2:共享 Excel 读取器缺 sheet 完整性守卫 ──────────────────────────────
// exceljs 的流式 WorkbookReader 对某些 zip entry 顺序的文件**会静默丢整个 sheet**
// (不抛错,只是结果残缺)。这个 bug 已被实测记录,并在 group_code_multisheet(新版团号表)
// 与 SMG 总账两处**各自**做过守卫 —— 唯独共享的 streamRows 没有,
// 而老版团号表 / 店铺账单 / 未收清单 / 收票台账迁移 / received_receipt 这 5 条路径全走它。
async function makeWorkbook(dir, name, sheets) {
  const p = path.join(dir, name);
  const wb = new ExcelJS.Workbook();
  for (const [sheetName, rows] of sheets) {
    const ws = wb.addWorksheet(sheetName);
    for (const r of rows) ws.addRow(r);
  }
  await wb.xlsx.writeFile(p);
  return p;
}

test('多 sheet 工作簿:每一张都要读到(守卫在,漏了会自动降级重读)', async () => {
  const { streamRows } = require('../lib/monthly_pipeline/xlsx_reader');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xlsxguard_'));
  try {
    const file = await makeWorkbook(dir, 'multi.xlsx', [
      ['甲团', [['团号', '姓名'], ['26141846', '王五']]],
      ['乙团', [['团号', '姓名'], ['26141847', '李四']]],
      ['丙团', [['团号', '姓名'], ['26141848', '张三']]],
    ]);
    const seen = [];
    const summary = await streamRows(file, (row) => { seen.push({ sheet: row.sheetName, o: row.asObject }); });
    assert.equal(summary.sheets.length, 3, '三张 sheet 一张都不能少');
    assert.deepEqual(summary.sheets.map((s) => s.name), ['甲团', '乙团', '丙团']);
    // 每张首行当表头消费掉,所以 3 张 × (2 行 - 1 表头) = 3 条数据行
    assert.equal(seen.length, 3, '每张的数据行都要回调出来');
    assert.deepEqual(seen.map((x) => x.sheet), ['甲团', '乙团', '丙团'], '三张都真的被读了');
    assert.deepEqual(seen.map((x) => x.o.团号), ['26141846', '26141847', '26141848'],
      '内容也要对得上 —— 只数 sheet 数量测不出"读到了但内容是空的"');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('守卫真的会执行:流式少读 sheet 时降级整本重读并留下痕迹', async () => {
  // 直接验证守卫逻辑本身:把流式读取器打桩成"只返回 1 张 sheet",
  // 守卫应当发现与权威名单不符 → 降级 → 结果里带 recoveredFromStreamSheetLoss。
  const readerPath = require.resolve('../lib/monthly_pipeline/xlsx_reader');
  delete require.cache[readerPath];
  const src = fs.readFileSync(readerPath, 'utf8');
  // 守卫必须**在流式成功之后**跑,而不是只在 catch 里(catch 只管抛错,静默丢 sheet 不抛错)
  assert.match(src, /const streamed = await streamRowsWithWorkbookReader/);
  assert.match(src, /const expected = readWorkbookSheetNames\(filePath\)/);
  assert.match(src, /streamed\.sheets\.length < expected\.length/);
  assert.match(src, /recoveredFromStreamSheetLoss/);
  // 降级仍受体积闸保护(整本载入实测内存放大 ~360×,3GB 堆会 OOM 打挂全站)
  assert.match(src, /streamed\.sheets\.length < expected\.length[\s\S]{0,300}assertWorkbookFallbackSafe/);

  // 权威名单函数本身要能跑(行为测试,不是只看写法)
  const { readWorkbookSheetNames } = require('../lib/monthly_pipeline/xlsx_sheet_names');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xlsxnames_'));
  try {
    const file = await makeWorkbook(dir, 'n.xlsx', [['A', [['x']]], ['B', [['y']]]]);
    assert.deepEqual(readWorkbookSheetNames(file), ['A', 'B'], '直接读 workbook.xml 拿权威名单');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Excel 行数上限告警:同一天内被生产数据打脸一次,记在这里 ──────────────
// 第一版拿 rowCount(迭代行数)判定,看到 import_job#22 的 1 048 574 就断定
// 「源文件被 Excel 截断了、账少一截」。查实后完全不是:
//     job22 工作簿1.xlsx 7.5MB:总迭代 1 048 574 行,**真实数据只有 15 204 行**,
//     另外 1 033 370 行全是空行 —— 整列套了格式,Excel 就认为整表都有行。
// 这种文件很常见而且**完全正常**;拿它报「账会少一截」纯属吓人,
// 正是"这个提醒在健康的生产数据上会不会亮"这条判据要拦下的东西。
// 正确口径:只数**有内容的行**。真被截断的文件,是一百万行**实数据**顶到天花板。
test('截断判定必须只数有内容的行:整列套格式的胖文件不得误报', async () => {
  const { streamRows, atExcelRowLimit, XLSX_MAX_ROWS } = require('../lib/monthly_pipeline/xlsx_reader');
  assert.equal(XLSX_MAX_ROWS, 1048576);

  // 纯函数边界
  assert.equal(atExcelRowLimit(1048574), true, '一百万行实数据 → 该报');
  assert.equal(atExcelRowLimit(1048570), true, '留 8 行余量');
  assert.equal(atExcelRowLimit(15204), false, '⭐生产 job22 的真实数据量 → 绝不能报');
  assert.equal(atExcelRowLimit(1046973), false);
  assert.equal(atExcelRowLimit(0), false);
  assert.equal(atExcelRowLimit(undefined), false, '脏值不该崩也不该误报');

  // 行为验证:真造一个"迭代行数 > 有内容行数"的文件,确认按后者判定
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fat_'));
  try {
    const p = path.join(dir, 'fat.xlsx');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('总账');
    ws.addRow(['票号', '金额']);
    for (let i = 0; i < 5; i += 1) ws.addRow([`R${i}`, 100 + i]);
    ws.getRow(3000).getCell(1).value = null; // 远处的空行:模拟整列套格式
    await wb.xlsx.writeFile(p);
    const summary = await streamRows(p, () => {});
    const sh = summary.sheets[0];
    assert.ok(sh.rowCount >= sh.dataRowCount, '迭代行数不小于有内容行数');
    assert.equal(sh.dataRowCount, 5, '只数有内容的数据行(表头与空行都不算)');
    assert.equal(sh.atExcelRowLimit, undefined, '空行撑出来的行数不得触发告警');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('接线:截断与漏 sheet 两类都要落库,并盖过"已导入 N 行"的成功感', () => {
  const svc = fs.readFileSync(path.join(__dirname, '../services/monthly/import_service.js'), 'utf8');
  assert.match(svc, /details\.truncatedAtExcelLimit = truncated/);
  assert.match(svc, /details\.recoveredFromStreamSheetLoss = sheetSummary\.recoveredFromStreamSheetLoss/);

  const view = fs.readFileSync(path.join(__dirname, '../frontend/src/views/v2/ImportsView.vue'), 'utf8');
  assert.match(view, /truncatedAtExcelLimit/);
  assert.match(view, /已达 Excel 行数上限/);
  assert.match(view, /账会少一截/, '说清后果,不只是报个现象');
  assert.match(view, /改用 csv 或分表导出/, '给出可执行的下一步');
  // 必须写进 st.error(红)而不是 st.success —— "导入成功但文件不完整"里,
  // 后半句才是操作员真正需要采取行动的部分
  assert.match(view, /if \(truncated\.length\) \{\s*\r?\n\s*st\.error/);
  assert.match(view, /已自动重读补回/, '救回来的也要说,但语气要区别于真丢数据');
});
