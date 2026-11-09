'use strict';

/**
 * 白盒对账准确率比对工具(Step 2 的统一标尺)。
 *
 * 口径:按「护照号」聚合「客人返点金额(￦)」,与人工核对过的答案(4.最终数据√)逐客人比对。
 *   - 系统导出(月度交付/月度数据 xlsx)是按行明细 → 按护照号求和。
 *   - 答案文件是按客人聚合的「求和项:客人返点金额」→ 同护照号若多行也求和。
 *   - 逐护照号比对返点总额,容差默认 1 ￦(四舍五入)。
 *
 * 用法:
 *   node scripts/accuracy_compare.js --system <系统导出.xlsx> --answer <答案.xlsx> [--tol 1] [--json out.json]
 *   可多次 --system 传同一桶的多个导出文件(合并求和)。
 *
 * 退出码:0 = 全部一致;1 = 有差异/缺失;2 = 参数或读取错误。
 */

const fs = require('node:fs');
const ExcelJS = require('exceljs');

const PASSPORT_ALIASES = ['护照号', '护照号码', 'passport', 'passportNo', 'PassportNo'];
const REBATE_ALIASES = [
  '客人返点金额(￦)', '客人返点金额（￦）', '客人返点金额', '求和项:客人返点金额',
  '求和项:客人返点金额(￦)', '求和项：客人返点金额', '客人返点', 'customer_rebate_krw',
];

function parseArgs(argv) {
  const args = { system: [], answer: null, tol: 1, json: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--system') args.system.push(argv[++i]);
    else if (a === '--answer') args.answer = argv[++i];
    else if (a === '--tol') args.tol = Number(argv[++i]);
    else if (a === '--json') args.json = argv[++i];
  }
  return args;
}

function cellText(v) {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (typeof v.text === 'string') return v.text;
    if (Array.isArray(v.richText)) return v.richText.map((p) => p.text).join('');
    if (v.result !== undefined) return String(v.result);
    return '';
  }
  return String(v);
}

function normPassport(s) {
  return cellText(s).trim().toUpperCase().replace(/\s+/g, '');
}

function toNumber(v) {
  const t = cellText(v).replace(/[, ￦]/g, '').trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function findColumnIndex(headerRow, aliases) {
  const cells = headerRow.map((c) => cellText(c).trim());
  for (let i = 0; i < cells.length; i += 1) {
    if (aliases.includes(cells[i])) return i;
  }
  // 宽松:去括号/全半角差异再比一次
  const loose = (s) => cellText(s).replace(/[（）()\s]/g, '').replace('：', ':');
  const wanted = aliases.map(loose);
  for (let i = 0; i < cells.length; i += 1) {
    if (wanted.includes(loose(cells[i]))) return i;
  }
  return -1;
}

/**
 * 流式扫一个 xlsx 的所有工作表,在每张表里自动找含护照号+返点列的表头行,
 * 之后按护照号累加返点。返回 Map<passport, sumRebate>。
 */
async function aggregateByPassport(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`文件不存在: ${filePath}`);
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {
    worksheets: 'emit', sharedStrings: 'cache', entries: 'emit', styles: 'ignore', hyperlinks: 'ignore',
  });
  // 每张工作表独立聚合,最后只取「有效数据行最多」的那张表。
  // 原因:① 答案文件常有多个 sheet(求和项/明细/做账单)含同一份数据,跨 sheet 累加=重复计数;
  //       ② 「生成说明」之类的词典页也含「护照号/客人返点金额」字样,会被简单的「首个匹配表」误选。
  // 取数据行最多的表两者都能避开(明细 vs 求和 → 同客人合计相等;数据表 110 行 > 说明页)。
  const perSheet = [];
  for await (const ws of reader) {
    if (/说明|legend|图例|字段/i.test(ws.name)) { for await (const _r of ws) { void _r; } continue; }
    let passIdx = -1;
    let rebIdx = -1;
    let headerFound = false;
    let scan = 0;
    const sheetSums = new Map();
    let sheetRows = 0;
    for await (const row of ws) {
      const values = (row.values || []).slice(1); // exceljs 1-based
      if (!headerFound) {
        scan += 1;
        const p = findColumnIndex(values, PASSPORT_ALIASES);
        const r = findColumnIndex(values, REBATE_ALIASES);
        if (p >= 0 && r >= 0) { passIdx = p; rebIdx = r; headerFound = true; }
        else if (scan >= 30) break;
        continue;
      }
      const passport = normPassport(values[passIdx]);
      if (!passport || !/[A-Z0-9]{5,}/.test(passport)) continue; // 过滤词典/标题里的非护照值
      const reb = toNumber(values[rebIdx]);
      if (reb == null) continue;
      sheetSums.set(passport, (sheetSums.get(passport) || 0) + reb);
      sheetRows += 1;
    }
    if (sheetRows > 0) perSheet.push({ name: ws.name, sums: sheetSums, rows: sheetRows });
  }
  perSheet.sort((a, b) => b.rows - a.rows);
  const best = perSheet[0] || { name: null, sums: new Map(), rows: 0 };
  return { sums: best.sums, rowsCounted: best.rows, usedSheet: best.name };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.system.length || !args.answer) {
    console.error('用法: node scripts/accuracy_compare.js --system <xlsx>... --answer <xlsx> [--tol 1] [--json out.json]');
    process.exit(2);
  }

  // 系统侧:可能多个导出文件,合并求和
  const sys = new Map();
  let sysRows = 0;
  for (const f of args.system) {
    const { sums, rowsCounted } = await aggregateByPassport(f);
    for (const [k, v] of sums) sys.set(k, (sys.get(k) || 0) + v);
    sysRows += rowsCounted;
  }
  const { sums: ans, rowsCounted: ansRows } = await aggregateByPassport(args.answer);

  const allPassports = new Set([...sys.keys(), ...ans.keys()]);
  const tol = Number.isFinite(args.tol) ? args.tol : 1;
  const mismatches = [];
  const onlySystem = [];
  const onlyAnswer = [];
  let exact = 0;
  for (const p of allPassports) {
    const s = sys.get(p);
    const a = ans.get(p);
    if (s == null) { onlyAnswer.push({ passport: p, answer: a }); continue; }
    if (a == null) { onlySystem.push({ passport: p, system: s }); continue; }
    if (Math.abs(s - a) <= tol) exact += 1;
    else mismatches.push({ passport: p, system: Math.round(s), answer: Math.round(a), diff: Math.round(s - a) });
  }

  const answerCount = ans.size;
  const accuracy = answerCount ? (exact / answerCount) : 0;
  const report = {
    systemFiles: args.system,
    answerFile: args.answer,
    tolerance: tol,
    systemRows: sysRows,
    answerRows: ansRows,
    systemCustomers: sys.size,
    answerCustomers: answerCount,
    exactMatch: exact,
    mismatchCount: mismatches.length,
    onlySystemCount: onlySystem.length,
    onlyAnswerCount: onlyAnswer.length,
    accuracyVsAnswer: Number((accuracy * 100).toFixed(2)),
    mismatches: mismatches.slice(0, 100),
    onlySystem: onlySystem.slice(0, 100),
    onlyAnswer: onlyAnswer.slice(0, 100),
  };

  console.log('==== 对账准确率(按护照号·客人返点金额￦) ====');
  console.log(`系统文件: ${args.system.length} 个,明细 ${sysRows} 行,客人 ${sys.size}`);
  console.log(`答案文件: ${args.answer}`);
  console.log(`答案客人 ${answerCount},明细 ${ansRows} 行,容差 ±${tol}￦`);
  console.log(`完全一致 ${exact} / ${answerCount}  → 准确率 ${report.accuracyVsAnswer}%`);
  console.log(`返点不符 ${mismatches.length},仅系统有 ${onlySystem.length},仅答案有 ${onlyAnswer.length}`);
  if (mismatches.length) {
    console.log('\n-- 返点不符(前 20) 护照 | 系统 | 答案 | 差 --');
    for (const m of mismatches.slice(0, 20)) console.log(`  ${m.passport} | ${m.system} | ${m.answer} | ${m.diff}`);
  }
  if (onlyAnswer.length) {
    console.log(`\n-- 仅答案有(系统漏, 前 20) --`);
    for (const m of onlyAnswer.slice(0, 20)) console.log(`  ${m.passport} | 答案 ${Math.round(m.answer)}`);
  }
  if (onlySystem.length) {
    console.log(`\n-- 仅系统有(多出, 前 20) --`);
    for (const m of onlySystem.slice(0, 20)) console.log(`  ${m.passport} | 系统 ${Math.round(m.system)}`);
  }

  if (args.json) {
    fs.writeFileSync(args.json, JSON.stringify(report, null, 2));
    console.log(`\n详细报告 → ${args.json}`);
  }

  const clean = mismatches.length === 0 && onlySystem.length === 0 && onlyAnswer.length === 0;
  process.exit(clean ? 0 : 1);
}

main().catch((e) => { console.error('[accuracy_compare] ERROR', e.message); process.exit(2); });
