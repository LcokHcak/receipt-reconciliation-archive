'use strict';

/**
 * 域2 边界测试(P0 缺口补齐,见 docs/边界测试设计.md「域2 · 操作4」):
 *   1. lotteChannelMode 分支矩阵零直测 → 釜山/号段268/P特殊/H·B·R团/PKG/济州/默认SG 全分支;
 *   2. modePriority 同团号去重未测 → 釜山(3) > 明确(2) > 默认SG(1),顺序无关(不被首尔行覆盖);
 *   3. applyRowToByTour 行过滤 → '无'/digitCore<4/空列 跳过(经 parseWorkbookTourModes 整链)。
 * 错桶病理源头(MEMORY 反复记载:首尔/釜山判错、70690、撞号136),纯断言不改源码。
 */

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');

const {
  lotteChannelMode,
  parseWorkbookTourModes,
} = require('../lib/monthly_pipeline/group_code_multisheet');

// ---- 临时目录:mkdtemp + afterEach 统一清理(失败也清) ----
const tmpDirs = [];
function mkTmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

// sheets: [{ name, rows: [[...], ...] }],rows 为 1-based 列的 addRow 数组(index0 → A列)
async function writeWorkbook(file, sheets) {
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    for (const r of s.rows) ws.addRow(r);
  }
  await wb.xlsx.writeFile(file);
}

const modeMapOf = ({ tourModes }) => new Map(tourModes.map((t) => [t.tourNo, t.mode]));

// 「乐天团号」sheet 配置:tour=col4 / agent=col5 / modeCol=col6
const HEADER_LT = [null, '截止', '入店公司', '团号', '代理', '入店公司'];
const rowLT = (tourNo, rawMode) => ['', '', '', tourNo, 'X', rawMode];
// 「乐天现场登记」sheet 配置:modeCol=col4 / tour=col5
const rowOnsite = (tourNo, rawMode) => ['', '', '', rawMode, tourNo];

// ---------------------------------------------------------------------------
// P0-1 · lotteChannelMode 分支矩阵
// ---------------------------------------------------------------------------
test('lotteChannelMode 分支矩阵:文字标签/号段268/优先级/字母团号数字投影', () => {
  const cases = [
    // [rawMode, tourNo, expected, note]
    ['釜山혜신', '26107001', '乐天釜山', '文字含釜山'],
    ['', '26800251', '乐天釜山', '模式列空 + 号段268 兜底'],
    ['P特殊', '26107001', '乐天釜山P特殊', '裸P特殊'],
    ['釜山P特殊', '26107001', '乐天釜山P特殊', '釜山+P特殊 → P特殊分支先于釜山'],
    ['釜山特殊P', '26107001', '乐天釜山P特殊', '釜山特殊P 变体'],
    ['H团혜신', '26107001', '乐天H团', 'H团'],
    ['B团조이앤', '26107001', '乐天B团', 'B团'],
    ['R团', '26107001', '乐天R团', 'R团'],
    ['PKG', '26107001', '乐天PKG', 'PKG'],
    ['pkg', '26107001', '乐天PKG', 'PKG 大小写不敏感(/i)'],
    ['济州조이앤', '26107001', '济州乐天', '济州前缀文字'],
    ['SG조이앤', '26107001', '乐天SG', 'SG조이앤 → 默认首尔SG'],
    ['蚕室', '26107001', '乐天SG', '蚕室 → 默认首尔SG'],
    ['', '26107001', '乐天SG', '261号段 + 空模式 → 默认首尔SG'],
    [null, null, '乐天SG', '全空入参 → 默认SG,不炸'],
    ['釜山 혜신', '26107001', '乐天釜山', '内部空白折叠后再判定'],
    // 分支顺序语义(以代码为准):号段268 的判定排在 H团/济州 等文字标签之前
    ['H团', '26800251', '乐天釜山', '号段268 先于 H团 文字(代码分支顺序)'],
    ['济州', '26800251', '乐天釜山', '号段268 先于 济州 文字(代码分支顺序)'],
    // 字母团号的数字投影(以代码为准:replace 非数字后 slice 前3位)
    ['', 'R26800251', '乐天釜山', 'R前缀字母团号 → 投影 26800251 → 268'],
    ['', '26V00041', '乐天SG', '中间字母团号 → 投影 2600041 → 260 → 默认SG'],
    // 观察记录:中间字母被剔除后后位数字左移拼出 268(26V80251 → 2680251 → '268')。
    // 当前实际行为=判为釜山;注释称比较投影为 A 类合法,此处按代码行为固化。
    ['', '26V80251', '乐天釜山', '中间字母投影位移拼出268(当前实际行为)'],
  ];
  for (const [rawMode, tourNo, expected, note] of cases) {
    assert.equal(
      lotteChannelMode(rawMode, tourNo),
      expected,
      `${note}: lotteChannelMode(${JSON.stringify(rawMode)}, ${JSON.stringify(tourNo)})`,
    );
  }
});

// ---------------------------------------------------------------------------
// P0-2 · modePriority 同团号去重(经 parseWorkbookTourModes 整链)
// ---------------------------------------------------------------------------
// 同一团号多处出现:釜山(3) > 明确非默认(2) > 默认乐天SG(1)。核心病理=釜山行被后出现的
// 首尔SG行覆盖 → 钱进错桶。正反两种行序 + 跨sheet 两种 sheet 序,结果必须一致(顺序无关)。
test('modePriority 同团号去重:釜山>明确>SG,正反行序/跨sheet序结果一致', async () => {
  const dir = mkTmpDir('gcms-prio-');

  // 「乐天团号」内的数据行(正序:低优先级行先出现,高优先级行后出现)
  const ltDataRows = [
    rowLT(26107001, 'SG조이앤'), // 首尔SG行(1)先出现
    rowLT(26107001, '釜山혜신'), // 釜山行(3)后出现 → 应胜出
    rowLT(26107002, 'SG조이앤'), // SG(1)
    rowLT(26107002, 'H团혜신'), //  明确模式(2)→ 应胜出
    rowLT(26107003, 'H团혜신'), //  明确模式(2)
    rowLT(26107003, '釜山혜신'), // 釜山(3)→ 应胜出
    rowLT(26200777, 'SG조이앤'), // 跨sheet:现场登记里同团号是釜山
  ];
  const onsiteRows = [rowOnsite(26200777, '釜山')];

  const forwardFile = path.join(dir, 'forward.xlsx');
  await writeWorkbook(forwardFile, [
    { name: '乐天团号', rows: [HEADER_LT, ...ltDataRows] },
    { name: '乐天现场登记', rows: onsiteRows },
  ]);
  // 反序:sheet 顺序与数据行顺序都倒过来(高优先级行先出现,低优先级行后到不得覆盖)
  const reverseFile = path.join(dir, 'reverse.xlsx');
  await writeWorkbook(reverseFile, [
    { name: '乐天现场登记', rows: onsiteRows },
    { name: '乐天团号', rows: [HEADER_LT, ...[...ltDataRows].reverse()] },
  ]);

  const expected = new Map([
    ['26107001', '乐天釜山'], // 釜山(3) 不被首尔SG(1) 覆盖
    ['26107002', '乐天H团'], //  明确(2) 不被SG(1) 覆盖
    ['26107003', '乐天釜山'], // 釜山(3) 不被明确(2) 覆盖
    ['26200777', '乐天釜山'], // 跨sheet 同团号:现场登记釜山 胜 团号表SG
  ]);

  for (const [label, file] of [['正序', forwardFile], ['反序', reverseFile]]) {
    const result = await parseWorkbookTourModes(file);
    const byTour = modeMapOf(result);
    // 去重:每团号只留一条
    assert.equal(result.tourModes.length, expected.size, `${label}:同团号去重后仅 ${expected.size} 条`);
    for (const [tourNo, mode] of expected) {
      assert.equal(byTour.get(tourNo), mode, `${label}:${tourNo} 应取 ${mode}(不被低优先级行覆盖)`);
    }
  }
});

// ---------------------------------------------------------------------------
// P0-3 · applyRowToByTour 行过滤(经 parseWorkbookTourModes 整链)
// ---------------------------------------------------------------------------
// 过滤规则:tourNo==='无' 跳过;数字投影 digitCore 为空或 <4 位跳过(数字投影只做行过滤,
// 不落库);表头行('团号' 无数字)同理被滤。4位数字是保留下限(边界)。
test('applyRowToByTour 过滤:无/digitCore<4/空列跳过,4位边界保留', async () => {
  const dir = mkTmpDir('gcms-filter-');
  const file = path.join(dir, 'filter.xlsx');
  await writeWorkbook(file, [
    {
      name: '乐天团号',
      rows: [
        HEADER_LT, //                  表头行:'团号' 无数字 → 滤掉
        rowLT('无', '釜山혜신'), //     机场票合法记号'无' → 跳过(即使模式列有值)
        rowLT(123, '釜山혜신'), //      3位数字 digitCore<4 → 跳过
        rowLT('', '釜山혜신'), //       团号列空 → 跳过
        rowLT('V123', '釜山혜신'), //   字母壳但数字投影仅3位 → 跳过(过滤看digitCore非字面长度)
        rowLT(1234, '釜山혜신'), //     恰好4位 → 保留(边界)
        rowLT(26107001, 'SG조이앤'), // 正常团号 → 保留(阳性对照)
      ],
    },
  ]);

  const result = await parseWorkbookTourModes(file);
  const byTour = modeMapOf(result);

  assert.equal(result.tourModes.length, 2, `只应留 2 行,实得:${JSON.stringify(result.tourModes)}`);
  assert.equal(byTour.get('1234'), '乐天釜山', '4位数字边界应保留且模式判定正常');
  assert.equal(byTour.get('26107001'), '乐天SG', '正常团号保留(阳性对照)');
  for (const gone of ['无', '123', '', 'V123', '团号']) {
    assert.ok(!byTour.has(gone), `${JSON.stringify(gone)} 应被过滤`);
  }
});
