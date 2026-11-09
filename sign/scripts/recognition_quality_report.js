'use strict';

/**
 * recognition_quality_report — 识别质量周报(金标对账,2026-07-15,只读)。
 *
 * 立意:每张**人工审核过**的票,天然是一条零成本金标——Auto(模型吐的)vs Final(审核员确认/改的)。
 * 全量对账 → 字段 × 文档类型 × 店家 × 模式 的错误率矩阵 + 真错样本(可回溯原图)。
 * 用途:①持续量化识别精度(改 prompt/换模型跑一遍看退步)②错误聚类反哺规则/prompt ③喂给审核台高危标红。
 *
 * ⭐三个诚实分层(不做=错误率虚高或虚低):
 *   1. 归一化噪声:票号去杠/日期格式/大小写差异不是模型错——复用审核台同一套归一化,分两档统计
 *      (raw 一致率 vs 归一化后一致率;两者之差=格式噪声,归一化后仍不同=真错)。
 *   2. 弱金标:审核员只锁锚字段(护照/姓名/日期/店),票号不逐字核对——票号一致率标注"偏乐观"。
 *   3. 幸存者偏差:Final==Auto 既可能模型对、也可能审核员没细看——一致率是**上界**;
 *      用"审核员改过≥1字段的票占比"佐证金标可信度;SLIM 免审车道票单列不计入。
 *
 * 用法:node scripts/recognition_quality_report.js [--root <代码根>] [--batches <批次目录>]
 *                                                 [--out <报告.md>] [--days N] [--samples K]
 */

const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const args = { root: '.', batches: '', out: '', days: 0, samples: 12 };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--root') args.root = argv[++i];
    else if (a === '--batches') args.batches = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--days') args.days = Number(argv[++i]) || 0;
    else if (a === '--samples') args.samples = Number(argv[++i]) || 12;
  }
  args.root = path.resolve(args.root); // require 相对路径必须绝对,否则被当包名找不到→静默退化 trim
  if (!args.batches) args.batches = path.join(args.root, 'passport_review_workbench', 'storage', 'batches');
  return args;
}

// 复用审核台同源归一化(--root 下 require;缺失则退化为 trim,不炸)。
function loadNormalizers(root) {
  const req = (rel) => {
    try { return require(path.join(root, rel)); } catch { return {}; }
  };
  const fn = req('lib/workbench_field_normalizer');
  const fr = req('lib/validation/field_rules');
  // 自检:归一化器若 require 失败会退化成 trim → 票号去杠等格式噪声被误判真错,数字全废。必须可见。
  const diag = {
    receiptNo: typeof fn.normalizeReceiptNoDigits === 'function',
    groupNo: typeof fn.normalizeGroupNo === 'function',
    date: typeof fn.normalizeOcrDate === 'function',
    name: typeof fn.normalizePassportEnglishName === 'function',
    store: typeof fr.validateStoreFamily === 'function',
  };
  const trim = (v) => String(v ?? '').trim();
  const digits = (v) => String(v ?? '').replace(/[^0-9]/g, '');
  const upperAlnum = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const storeCanon = (v) => {
    const raw = trim(v);
    if (!raw) return '';
    // 先审核台 canonical(现代/新世界/乐天等),失败退大写去符号
    try {
      const c = fr.validateStoreFamily ? fr.validateStoreFamily(raw) : null;
      if (c && c.ok) return c.canonical;
    } catch { /* fall through */ }
    return String(raw).toUpperCase().replace(/[\s()（）]/g, '');
  };
  // 字段名(去 Auto/Final 后)→ 归一化器。缺省 trim。
  return {
    extractedName: (v) => (fn.normalizePassportEnglishName ? fn.normalizePassportEnglishName(v) : String(v ?? '').toUpperCase().replace(/\s+/g, ' ').trim()),
    passportNo: upperAlnum,
    receiptStore: storeCanon,
    // 对账用 digits 版(去分隔符)——normalizeReceiptNo 按店保留杠,会把"去杠"误判真错;
    // 对账只问"票号数字对不对",分隔符是格式噪声。
    receiptNo: (v) => (fn.normalizeReceiptNoDigits ? fn.normalizeReceiptNoDigits(v) : digits(v)),
    groupNo: (v) => (fn.normalizeGroupNo ? fn.normalizeGroupNo(v) : upperAlnum(v)),
    purchaseDate: (v) => (fn.normalizeOcrDate ? fn.normalizeOcrDate(v) : trim(v)),
    departureDate: (v) => (fn.normalizeOcrDate ? fn.normalizeOcrDate(v) : trim(v)),
    receiptAmount: digits,
    branch: digits,
    brand: trim,
    upstream: trim,
    __trim: trim,
    __diag: diag,
  };
}

const FIELD_LABELS = {
  extractedName: '护照姓名', passportNo: '护照号', receiptStore: '店家',
  receiptNo: '小票号/交易编号', groupNo: '团号', purchaseDate: '购买日期',
  departureDate: '出境日期', receiptAmount: '交易金额', branch: '门店编号',
  brand: '品牌', upstream: '上家',
};
// 弱金标字段(审核员不逐字核对)——一致率偏乐观,报告标注
const WEAK_GOLD = new Set(['receiptNo']);
// 非纯 OCR 字段:值来源含团号表/预匹配,Auto≠Final 多为"以表为准"的改写而非视觉识别错——错误率不代表 OCR 精度
const NON_OCR = new Set(['groupNo']);
// 各文档类型下"有意义"的对账字段(数据本身也会用 both-empty 排除,这里只为报告分区)
const FIELDS_BY_DOC = {
  passport: ['extractedName', 'passportNo'],
  receipt: ['receiptStore', 'receiptNo', 'groupNo', 'purchaseDate', 'departureDate'],
  dept: ['receiptStore', 'receiptNo', 'receiptAmount', 'branch', 'brand', 'upstream', 'purchaseDate', 'passportNo', 'extractedName'],
};
const ALL_FIELDS = Object.keys(FIELD_LABELS);

function dayOf(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t + 8 * 3600e3).toISOString().slice(0, 10) : '';
}
const isDeptStore = (s) => /_DEPT$/.test(String(s || '').trim().toUpperCase())
  || /백화점|百货|DEPT|DEPARTMENT/i.test(String(s || ''));

function docKindOf(task) {
  const doc = String(task.docTypeFinal || task.docTypeAuto || '');
  if (doc === 'passport') return 'passport';
  if (doc === 'receipt') return isDeptStore(task.receiptStoreFinal || task.receiptStoreAuto) ? 'dept' : 'receipt';
  return 'other';
}

// SLIM 免审车道票:审核员可能没逐字看,金标含金量低 → 单列不计入对账。
// 生产 SLIM 灰度默认关(WORKBENCH_SLIM_MODES 空),这里按"团号确认盖章 + 全字段零改动"保守识别嫌疑票。
function isSlimSuspect(task, changedCount) {
  return Boolean(task.tourConfirmedAt) && changedCount === 0
    && docKindOf(task) !== 'passport'; // 护照必审,永不 SLIM
}

function newCell() {
  return { denom: 0, rawMatch: 0, normOnly: 0, trueErr: 0, missing: 0, spurious: 0 };
}

function main() {
  const args = parseArgs(process.argv);
  const N = loadNormalizers(args.root);
  const diagBad = Object.entries(N.__diag).filter(([, ok]) => !ok).map(([k]) => k);
  if (diagBad.length) console.error(`⚠️ 归一化器未加载(退化 trim,数字失真):${diagBad.join(', ')} —— 检查 --root`);
  else console.error('☑ 归一化器全部加载(票号/团号/日期/姓名/店家 与审核台同源)');
  const cutoff = args.days ? new Date(Date.now() + 8 * 3600e3 - args.days * 86400e3).toISOString().slice(0, 10) : '';

  const dirs = fs.readdirSync(args.batches).filter((d) => {
    try { return fs.statSync(path.join(args.batches, d, 'batch.json')).isFile(); } catch { return false; }
  });

  // 累加器:byField[docKind][field] / byStore[store][field] / byMode[mode][field]
  const byField = {}; const byStore = {}; const byMode = {};
  const samples = {}; // field -> [{auto,final,batchId,taskId,store,mode}]
  const cell = (bag, k1, k2) => {
    bag[k1] ??= {}; bag[k1][k2] ??= newCell(); return bag[k1][k2];
  };

  let reviewedTasks = 0; let slimSuspect = 0; let editedTasks = 0;
  const docCount = { passport: 0, receipt: 0, dept: 0, other: 0 };

  for (const dir of dirs) {
    let batch;
    try { batch = JSON.parse(fs.readFileSync(path.join(args.batches, dir, 'batch.json'), 'utf8')); } catch { continue; }
    for (const task of Array.isArray(batch.tasks) ? batch.tasks : []) {
      if (!task || !task.reviewed) continue;
      if (cutoff && dayOf(task.reviewedAt) && dayOf(task.reviewedAt) < cutoff) continue;
      const docKind = docKindOf(task);
      if (docKind === 'other') continue;

      // 先算这张票审核员改过几个字段(幸存者偏差佐证 + SLIM 嫌疑判定)
      let changed = 0;
      const evals = [];
      for (const field of ALL_FIELDS) {
        const aRaw = N.__trim(task[`${field}Auto`]);
        const fRaw = N.__trim(task[`${field}Final`]);
        if (!aRaw && !fRaw) continue; // 该票无此字段
        const norm = N[field] || N.__trim;
        let na;
        let nf;
        try { na = norm(aRaw); } catch { na = aRaw; }
        try { nf = norm(fRaw); } catch { nf = fRaw; }
        let kind;
        if (!aRaw && fRaw) kind = 'missing';
        else if (aRaw && !fRaw) kind = 'spurious';
        else if (aRaw === fRaw) kind = 'rawMatch';
        else if (na === nf) kind = 'normOnly';
        else kind = 'trueErr';
        if (kind === 'trueErr' || kind === 'missing') changed += 1;
        else if (kind === 'normOnly') changed += 1; // 审核员规整过=看过
        evals.push({ field, aRaw, fRaw, kind });
      }

      reviewedTasks += 1;
      docCount[docKind] += 1;
      if (changed > 0) editedTasks += 1;
      if (isSlimSuspect(task, changed)) { slimSuspect += 1; continue; } // SLIM 嫌疑票不计入对账

      const store = N.receiptStore(task.receiptStoreFinal || task.receiptStoreAuto) || '(空店)';
      const mode = String(task.modeRawPre || '').trim() || '(无模式)';
      for (const e of evals) {
        for (const bag of [cell(byField, docKind, e.field), cell(byStore, store, e.field), cell(byMode, mode, e.field)]) {
          bag.denom += 1; bag[e.kind] += 1;
        }
        if (e.kind === 'trueErr') {
          samples[e.field] ??= [];
          if (samples[e.field].length < args.samples) {
            samples[e.field].push({ auto: e.aRaw.slice(0, 30), final: e.fRaw.slice(0, 30), batchId: batch.id, taskId: task.id, store, mode });
          }
        }
      }
    }
  }

  writeReport(args, { byField, byStore, byMode, samples, reviewedTasks, slimSuspect, editedTasks, docCount, cutoff, batchCount: dirs.length, diag: N.__diag });
}

const pct = (n, d) => (d ? (100 * n / d).toFixed(1) + '%' : '—');
const accNorm = (c) => pct(c.rawMatch + c.normOnly, c.denom - c.missing - c.spurious); // 值对不对(该填且填了)

function fieldTable(bag, order) {
  const lines = ['| 字段 | 对账数 | 归一化准确率 | 真错率 | 格式噪声 | 漏识别 | 多识别 |', '|---|---|---|---|---|---|---|'];
  for (const field of order) {
    const c = bag[field];
    if (!c || !c.denom) continue;
    const valid = c.denom - c.missing - c.spurious;
    const label = FIELD_LABELS[field]
      + (WEAK_GOLD.has(field) ? ' ⚠弱金标' : '')
      + (NON_OCR.has(field) ? ' ⚠非纯OCR' : '')
      + (c.missing / c.denom > 0.5 ? ' ⚠模型基本不识别(样本小)' : '');
    lines.push(`| ${label} | ${c.denom} | ${accNorm(c)} | ${pct(c.trueErr, valid)} | ${pct(c.normOnly, valid)} | ${pct(c.missing, c.denom)} | ${pct(c.spurious, c.denom)} |`);
  }
  return lines.join('\n');
}

function writeReport(args, R) {
  const L = [];
  const stamp = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
  L.push(`# 识别质量周报(金标对账)`);
  L.push('');
  L.push(`生成时刻 ${stamp}(UTC+8)· 扫描批次 ${R.batchCount} 个 · ${R.cutoff ? `仅统计 ${R.cutoff} 起审核的票` : '全量已审票'}`);
  L.push('');
  L.push('## 一、样本与金标可信度');
  L.push('');
  L.push(`- **已审票**:${R.reviewedTasks} 张(护照 ${R.docCount.passport} / 免税店小票 ${R.docCount.receipt} / 百货 ${R.docCount.dept})`);
  L.push(`- **审核员改过≥1字段的票**:${R.editedTasks} 张(${pct(R.editedTasks, R.reviewedTasks)})——占比越高,金标越可信(证明审核员在逐字段看,而非扫一眼放过)`);
  L.push(`- **SLIM 免审嫌疑票**:${R.slimSuspect} 张(已确认盖章且零改动)——已**排除出对账**,不计入准确率(避免"没人看"当"模型对")`);
  L.push('');
  L.push('> ⚠️ 三条读数纪律:');
  L.push('> 1. **归一化准确率** = 归一化后 Auto==Final 的占比(在"该字段有值且审核员保留了值"的分母上)。它是**上界**——Final==Auto 也可能是审核员没细看。');
  L.push('> 2. **真错率** = 归一化后仍不同(模型真认错了);**格式噪声** = 仅去杠/格式/大小写不同(不是模型错,是审核员顺手规整)。');
  L.push('> 3. **票号是弱金标**:审核员只锁护照/姓名/日期/店,票号不逐字核对——票号一致率偏乐观,硬结论看月度账单对账。');
  L.push('');
  L.push('## 二、字段 × 文档类型 错误率矩阵');
  for (const [doc, label] of [['passport', '护照票'], ['receipt', '免税店小票'], ['dept', '百货票']]) {
    if (!R.byField[doc]) continue;
    L.push('');
    L.push(`### ${label}`);
    L.push('');
    L.push(fieldTable(R.byField[doc], FIELDS_BY_DOC[doc]));
    if (doc === 'dept') {
      L.push('');
      L.push('> ⚠️ 百货读法:漏识别率普遍 95%+ = **模型对百货票几乎不做字段识别,全靠审核员从档案手填**(百货接入设计如此)。');
      L.push('> 因此准确率的有效分母只有个位到十几张,门店/品牌"100%"是小样本假象,不可作精度结论——只有护照/店家/金额勉强有参考性。');
      L.push('> 想让百货也自动识别,需要专门给百货票做 OCR 适配(当前是空白)。');
    }
  }
  L.push('');
  L.push('## 三、店家维度(关键字段真错率——回答"哪家店拖后腿")');
  L.push('');
  L.push('> ⚠️ 综合真错率=该店所有字段混合(含团号/票号等高错或非OCR字段),会被拉高;精读某店某字段看第二节矩阵。「对账字段数」=字段×票,非票数。');
  L.push('');
  const storeRows = Object.entries(R.byStore)
    .map(([store, fields]) => {
      const total = Object.values(fields).reduce((s, c) => s + c.denom, 0);
      const err = Object.values(fields).reduce((s, c) => s + c.trueErr, 0);
      const valid = Object.values(fields).reduce((s, c) => s + (c.denom - c.missing - c.spurious), 0);
      return { store, total, errRate: valid ? err / valid : 0, err, valid };
    })
    .filter((r) => r.total >= 20)
    .sort((a, b) => b.errRate - a.errRate);
  L.push('| 店家(按 Final 归类) | 对账字段数 | 综合真错率 | 真错数 |', '|---|---|---|---|');
  for (const r of storeRows) L.push(`| ${r.store} | ${r.total} | ${pct(r.err, r.valid)} | ${r.err} |`);
  L.push('');
  L.push('## 四、真错样本 TOP(可回溯原图 batchId/taskId)');
  for (const field of ALL_FIELDS) {
    const s = R.samples[field];
    if (!s || !s.length) continue;
    L.push('');
    L.push(`### ${FIELD_LABELS[field]}(${s.length} 例)`);
    L.push('');
    L.push('| 模型识别 → | 审核改成 | 店家 | batch/task |', '|---|---|---|---|');
    for (const x of s) L.push(`| \`${x.auto || '(空)'}\` | \`${x.final || '(空)'}\` | ${x.store} | ${x.batchId}/${x.taskId} |`);
  }
  L.push('');
  L.push('## 五、口径与局限');
  L.push('- 分母:仅 `reviewed=true` 的票;每字段仅在 Auto/Final 至少一方非空时计入(排除"该票无此字段")。');
  L.push('- 归一化复用审核台同源函数(票号 normalizeReceiptNo / 团号 normalizeGroupNo / 日期 normalizeOcrDate / 姓名 normalizePassportEnglishName / 店家 validateStoreFamily)。');
  L.push('- 幸存者偏差不可从数据消除,准确率均为上界;台账交叉验证天花板此前实测(小票~65%/护照~89%可自动对上),此报告是"人审后"口径,数字更高属正常。');
  const badDiag = Object.entries(R.diag || {}).filter(([, ok]) => !ok).map(([k]) => k);
  L.push(`- 归一化器加载:${badDiag.length ? '⚠️ 失败 ' + badDiag.join('/') + '(数字失真,勿信)' : '✓ 全部与审核台同源'}。`);
  L.push('- 下一步可做:①错误样本按"店×字段×错误形态"聚类反哺 prompt/规则;②历史错误率喂审核台高危字段标红+高危票排序(不自动放行)。');

  const out = args.out || path.join(args.root, 'docs', `识别质量周报_${stamp.slice(0, 10)}.md`);
  fs.writeFileSync(out, L.join('\n'), 'utf8');
  // 控制台摘要
  console.log(`已审票 ${R.reviewedTasks}(护照${R.docCount.passport}/小票${R.docCount.receipt}/百货${R.docCount.dept})· 审核员改过字段占比 ${pct(R.editedTasks, R.reviewedTasks)} · SLIM嫌疑排除 ${R.slimSuspect}`);
  for (const [doc, label] of [['passport', '护照'], ['receipt', '小票'], ['dept', '百货']]) {
    if (!R.byField[doc]) continue;
    for (const field of FIELDS_BY_DOC[doc]) {
      const c = R.byField[doc][field];
      if (c && c.denom >= 20) console.log(`  ${label}·${FIELD_LABELS[field]}: 归一化准确率 ${accNorm(c)} 真错率 ${pct(c.trueErr, c.denom - c.missing - c.spurious)} (n=${c.denom})`);
    }
  }
  console.log(`报告 → ${out}`);
}

main();
