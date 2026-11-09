'use strict';

/**
 * accuracy_acceptance.js — 4 桶 × 月度 全量准确率验收(商用前最后闸门)。
 *
 * 隔离 harness:临时 sqlite,服务层直调(不起 HTTP、不碰服务器/本地正式库),
 * 用 data_sample/N月 真实源数据走完整管线,对 4.最终数据√ 标准答案逐客户比对。
 *
 *   导入(团号/账单+品牌活动/收票台账) → seed 扣点 → tour_match → bill_match
 *     → merge → 按护照号聚合 customer_rebate_krw → 对答案(容差±1₩)
 *
 * 用法:
 *   node scripts/accuracy_acceptance.js --month 1 [--keep] [--json tmp/acc_1.json]
 *
 * 输出:每桶 客户数/命中/金额一致/差异clamp样例 + 总准确率;差异归因清单进 JSON。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openMonthlyDatabase } = require('../lib/storage/monthly_database');
const { createImportJobRepository } = require('../repositories/import_job_repository');
const { createGroupCodeRepository } = require('../repositories/group_code_repository');
const { createStoreBillRepository } = require('../repositories/store_bill_repository');
const { createMissingReceiptRepository } = require('../repositories/missing_receipt_repository');
const { createReceivedReceiptRepository } = require('../repositories/received_receipt_repository');
const { createDailyReceiptRepository } = require('../repositories/daily_receipt_repository');
const { createBrandActivityRepository } = require('../repositories/brand_activity_repository');
const { createPendingReviewRepository } = require('../repositories/pending_review_repository');
const { createErrorRecordRepository } = require('../repositories/error_record_repository');
const { createMatchBadcaseRepository } = require('../repositories/match_badcase_repository');
const { createBillMatchLogRepository } = require('../repositories/bill_match_log_repository');
const { createMonthlyDataRepository } = require('../repositories/monthly_data_repository');
const { createMonthlyWorkspaceRepository } = require('../repositories/monthly_workspace_repository');
const { createModeDeductConfigRepository } = require('../repositories/monthly/mode_deduct_config_repo');
const { createModeFolderMappingRepository } = require('../repositories/monthly/mode_folder_mapping_repo');
const { createImportService } = require('../services/monthly/import_service');
const { createTourMatchService } = require('../services/monthly/tour_match_service');
const { createBillMatchService } = require('../services/monthly/bill_match');
const { createMergeStreamingService } = require('../services/monthly/merge_streaming_service');
const ExcelJS = require('exceljs');

const SAMPLE_ROOT = path.resolve(__dirname, '..', '..', 'data_sample');

// 每月源文件与答案映射(文件名按 data_sample 实际命名)
const MONTHS = {
  1: {
    workspaceKey: '2026-01',
    groupCode: '1月/1.团号汇总/团号汇总.xlsx',
    dailyReceipt: '1月/2.收票汇总/收票汇总.xlsx',
    bills: [
      '1月/3.账单表/乐天SG+H团+釜山/1月乐天H 客人账单.xlsx',
      '1月/3.账单表/乐天SG+H团+釜山/乐天B团卖出1月-客人账单.xlsx',
      '1月/3.账单表/乐天SG+H团+釜山/乐天SG 1月客人账单.xlsx',
      '1月/3.账单表/乐天SG+H团+釜山/乐天釜山卖出1月-客人账单.xlsx',
      '1月/3.账单表/乐天SG+H团+釜山/1月品牌活动数据.xlsx',
      '1月/3.账单表/新罗V团+济州/2601月济州新罗V团客人账单数据.xlsx',
      '1月/3.账单表/爱宝客/1月爱宝客客人账单数据.xlsx',
    ],
    answers: {
      济州新罗V团: '1月/4.最终数据√/1月济州新罗V团数据√.xlsx',
      爱宝客: '1月/4.最终数据√/1月爱宝客数据.xlsx',
      乐天首尔: '1月/4.最终数据√/乐天首尔+釜山/1月乐天免税店数据√.xlsx',
      乐天釜山: '1月/4.最终数据√/乐天首尔+釜山/1月乐天釜山SG数据√.xlsx',
    },
  },
  2: {
    workspaceKey: '2026-02',
    groupCode: '2月/1.团号汇总/2026-2月 团号汇总.xlsx',
    dailyReceipt: [
      '2月/5.已收汇总/2月乐天B团小票.xlsx',
      '2月/5.已收汇总/2月乐天H团小票.xlsx',
      '2月/5.已收汇总/2月乐天SG小票(1).xlsx',
      '2月/5.已收汇总/2月乐天釜山SG小票.xlsx',
      '2月/5.已收汇总/2月济州新罗V团小票.xlsx',
      '2月/5.已收汇总/2月爱宝客PKG SG团小票(1).xlsx',
    ],
    bills: [
      '2月/3.账单原表/2月乐天H 客人账单.xlsx',
      '2月/3.账单原表/乐天B团卖出2月-客人账单.xlsx',
      '2月/3.账单原表/乐天SG 2月客人账单.xlsx',
      '2月/3.账单原表/乐天釜山卖出2月-客人账单.xlsx',
      '2月/3.账单原表/2月品牌活动数据.xlsx',
      '2月/3.账单原表/2602月济州新罗V团客人账单数据.xlsx',
      '2月/3.账单原表/2月爱宝客客人账单数据.xlsx',
    ],
    answers: {
      济州新罗V团: '2月/4.最终数据/2月济州新罗V团数据√.xlsx',
      爱宝客: '2月/4.最终数据/2月爱宝客PKG+SG数据√.xlsx',
      乐天首尔: '2月/4.最终数据/2月乐天免税店数据√.xlsx',
      乐天釜山: '2月/4.最终数据/2月乐天釜山数据√.xlsx',
    },
  },
  3: {
    workspaceKey: '2026-03',
    groupCode: '3月/1.团号汇总/2026-3月 团号汇总.xlsx',
    dailyReceipt: [
      '3月/5.已收汇总/3月乐天B团小票(2).xlsx',
      '3月/5.已收汇总/3月乐天H团小票(5).xlsx',
      '3月/5.已收汇总/3月乐天SG小票(7).xlsx',
      '3月/5.已收汇总/3月乐天釜山SG小票(2).xlsx',
      '3月/5.已收汇总/3月济州新罗V团小票(2).xlsx',
      '3月/5.已收汇总/3月爱宝客PKG SG团小票(5).xlsx',
    ],
    bills: [
      '3月/3.账单原表/3月乐天H 客人账单(3).xlsx',
      '3月/3.账单原表/乐天B团卖出3月-客人账单(1).xlsx',
      '3月/3.账单原表/乐天SG 3月客人账单(1).xlsx',
      '3月/3.账单原表/乐天釜山卖出3月-客人账单.xlsx',
      '3月/3.账单原表/3月品牌活动数据(1).xlsx',
      '3月/3.账单原表/2603月济州新罗V团客人账单数据(1).xlsx',
      '3月/3.账单原表/3月爱宝客客人账单数据(1).xlsx',
    ],
    answers: {
      济州新罗V团: '3月/4.最终数据/3月济州新罗V团数据√.xlsx',
      爱宝客: '3月/4.最终数据/3月爱宝客数据√.xlsx',
      乐天首尔: '3月/4.最终数据/3月乐天免税店数据√.xlsx',
      乐天釜山: '3月/4.最终数据/3月乐天釜山数据√.xlsx',
    },
  },
};

const DEDUCTS = [
  { modeFolder: '乐天首尔', deductValue: -0.005 },
  { modeFolder: '乐天釜山', deductValue: -0.005 },
  { modeFolder: '爱宝客', deductValue: -0.005 },
  { modeFolder: '济州新罗V团', deductValue: 0 },
];

function parseArgs(argv) {
  const args = { month: 1, keep: false, json: '', compareOnly: false };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--month') args.month = Number(argv[++i]);
    else if (argv[i] === '--keep') args.keep = true;
    else if (argv[i] === '--json') args.json = argv[++i];
    else if (argv[i] === '--compare-only') { args.compareOnly = true; args.keep = true; }
  }
  return args;
}

function cellScalar(v) {
  if (v == null) return null;
  if (typeof v === 'object') {
    if ('result' in v) return cellScalar(v.result);
    if ('text' in v) return cellScalar(v.text);
    if (Array.isArray(v.richText)) return v.richText.map((p) => p.text || '').join('');
  }
  return v;
}

// 答案文件:客户级聚合(姓名/护照号/出境日期/求和项:客人返点金额),表头行自动探测。
// 流式读(乐天答案 70MB,全量加载会 OOM):逐 sheet 扫,命中含答案表头的第一个 sheet。
async function loadAnswer(filePath) {
  const byPassport = new Map();
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {
    entries: 'emit', sharedStrings: 'cache', worksheets: 'emit', styles: 'ignore', hyperlinks: 'ignore',
  });
  let done = false;
  for await (const ws of reader) {
    if (done) continue; // 仍需消费迭代器,但不再处理
    let cols = null;
    let scanned = 0;
    for await (const row of ws) {
      const vals = [];
      const raw = row.values || [];
      for (let i = 1; i < raw.length; i += 1) vals[i] = String(cellScalar(raw[i]) ?? '').trim();
      if (!cols) {
        scanned += 1;
        if (scanned > 30) break; // 前30行找不到表头 → 非答案 sheet
        const pi = vals.findIndex((v) => /护照/.test(v || ''));
        const ri = vals.findIndex((v) => /求和项.*返点|客人返点金额/.test(v || ''));
        if (pi > 0 && ri > 0) cols = { passport: pi, rebate: ri };
        continue;
      }
      const passport = String(vals[cols.passport] || '').trim().toUpperCase();
      const rebate = Number(cellScalar(raw[cols.rebate]));
      if (!passport || !Number.isFinite(rebate)) continue;
      byPassport.set(passport, (byPassport.get(passport) || 0) + rebate);
    }
    if (cols && byPassport.size) done = true; // 第一个含答案表头的 sheet
  }
  return byPassport;
}

async function main() {
  const args = parseArgs(process.argv);
  const cfg = MONTHS[args.month];
  if (!cfg) { console.error(`month ${args.month} 未配置(目前支持: ${Object.keys(MONTHS).join(',')})`); process.exit(2); }
  const ws = cfg.workspaceKey;

  const dir = args.keep
    ? path.join(__dirname, '..', 'tmp', `acceptance_${args.month}`)
    : fs.mkdtempSync(path.join(os.tmpdir(), `acc-${args.month}-`));
  // compare-only 必须复用已有库,绝不能清目录(清了系统侧就是空库,比对全缺失)
  if (args.compareOnly) {
    if (!fs.existsSync(path.join(dir, 'monthly.sqlite'))) {
      console.error(`compare-only 需要已有库: ${dir}/monthly.sqlite 不存在,先跑一次完整模式(--keep)`);
      process.exit(2);
    }
  } else if (args.keep) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }
  const db = openMonthlyDatabase({ dbPath: path.join(dir, 'monthly.sqlite') });

  // ── 装配(最小 monthly 域)─────────────────────────────────
  const importJobRepo = createImportJobRepository({ db });
  const groupCodeRepo = createGroupCodeRepository({ db });
  const storeBillRepo = createStoreBillRepository({ db });
  const missingReceiptRepo = createMissingReceiptRepository({ db });
  const receivedReceiptRepo = createReceivedReceiptRepository({ db });
  const dailyReceiptRepo = createDailyReceiptRepository({ db });
  const brandActivityRepo = createBrandActivityRepository({ db });
  const pendingReviewRepo = createPendingReviewRepository({ db });
  const errorRecordRepo = createErrorRecordRepository({ db });
  const matchBadcaseRepo = createMatchBadcaseRepository({ db });
  const billMatchLogRepo = createBillMatchLogRepository({ db });
  const monthlyDataRepo = createMonthlyDataRepository({ db });
  const workspaceRepo = createMonthlyWorkspaceRepository({ db });
  const modeDeductConfigRepo = createModeDeductConfigRepository({ db });
  const modeFolderMappingRepo = createModeFolderMappingRepository({ db });

  function openWorkspace(key) {
    const m = /^(\d{4})-(\d{2})$/.exec(key) || [];
    const now = new Date().toISOString();
    workspaceRepo.upsert({
      workspaceKey: key, year: Number(m[1]) || 2026, month: Number(m[2]) || 1,
      status: 'open', createdAt: now, updatedAt: now,
    });
    return workspaceRepo.findByKey(key);
  }
  const workspaceService = {
    getOrThrow: (key) => workspaceRepo.findByKey(key) || openWorkspace(key),
    open: ({ workspaceKey }) => openWorkspace(workspaceKey),
  };

  const importService = createImportService({
    importJobRepo, groupCodeRepo, storeBillRepo, missingReceiptRepo,
    receivedReceiptRepo, dailyReceiptRepo, brandActivityRepo, workspaceService,
  });
  const tourMatchService = createTourMatchService({
    dailyReceiptRepo, groupCodeRepo, pendingReviewRepo, errorRecordRepo,
    matchBadcaseRepo, modeFolderMappingRepo,
  });
  const billMatchService = createBillMatchService({
    db, storeBillRepo, dailyReceiptRepo, billMatchLogRepo, pendingReviewRepo, matchBadcaseRepo,
  });
  const mergeService = createMergeStreamingService({
    db, dailyReceiptRepo, billMatchLogRepo, monthlyDataRepo, storeBillRepo,
    brandActivityRepo, modeDeductConfigRepo, modeFolderMappingRepo, workspaceRepo,
  });

  workspaceService.getOrThrow(ws);
  modeDeductConfigRepo.upsertRows({
    workspaceKey: ws, rows: DEDUCTS, updatedBy: 'acceptance', updatedAt: new Date().toISOString(),
  });

  const stamp = (label, extra = '') => console.log(`[${new Date().toISOString().slice(11, 19)}] ${label}${extra ? ' ' + extra : ''}`);

  // ── 导入 ────────────────────────────────────────────────
  const sample = (rel) => path.join(SAMPLE_ROOT, rel);
  let tm = null;
  let bm = null;
  let mg = null;
  if (args.compareOnly) {
    stamp('compare-only: 复用已有库,跳过导入/管线');
  } else {
  stamp('import group_code');
  const g = await importService.importGroupCode({ workspaceKey: ws, filePath: sample(cfg.groupCode), operator: 'acceptance' });
  stamp('  group_code done', `rows=${g.inserted ?? g.totalInserted ?? JSON.stringify(g).slice(0, 80)}`);

  for (const rel of cfg.bills) {
    stamp('import store_bill', path.basename(rel));
    const r = await importService.importStoreBill({ workspaceKey: ws, filePath: sample(rel), operator: 'acceptance' });
    stamp('  bill done', `inserted=${r.inserted ?? r.totalInserted ?? '?'} brand=${r.brandActivity ?? ''}`);
  }

  const dailyFiles = Array.isArray(cfg.dailyReceipt) ? cfg.dailyReceipt : [cfg.dailyReceipt];
  for (const rel of dailyFiles) {
    stamp('import daily_receipt(收票→台账)', path.basename(rel));
    const d = await importService.importDailyReceipt({ workspaceKey: ws, filePath: sample(rel), operator: 'acceptance' });
    stamp('  daily done', `inserted=${d.inserted ?? d.totalInserted ?? '?'}`);
  }

  // ── 管线 ────────────────────────────────────────────────
  stamp('tour_match');
  tm = await tourMatchService.run({ workspaceKey: ws, operator: 'acceptance' });
  stamp('  tour_match done', JSON.stringify({ scanned: tm.scanned, matched: tm.matched, notFound: tm.tourNotFound }));
  stamp('bill_match');
  bm = await billMatchService.run({ workspaceKey: ws });
  stamp('  bill_match done', JSON.stringify({ matched: bm.matched, unmatched: bm.unmatched ?? bm.unreceived }));
  stamp('merge');
  mg = await mergeService.run({ workspaceKey: ws });
  stamp('  merge done', JSON.stringify({ matched: mg.matched, refund: mg.refund, refundLinked: mg.refundLinked, brand: mg.brandActivity, unreceived: mg.unreceived }));
  } // end !compareOnly

  // ── 比对 ────────────────────────────────────────────────
  const sysStmt = db.prepare(`
    SELECT mode_folder AS folder, UPPER(TRIM(COALESCE(passport_no,''))) AS passport,
           SUM(COALESCE(customer_rebate_krw, 0)) AS rebate
    FROM monthly_data
    WHERE workspace_key = ? AND is_unmatched = 0
      AND (customer_rebate_krw IS NOT NULL OR customer_rebate_usd IS NOT NULL)
    GROUP BY mode_folder, passport
  `);
  const sysByFolder = new Map();
  for (const r of sysStmt.all(ws)) {
    if (!r.passport) continue;
    if (!sysByFolder.has(r.folder)) sysByFolder.set(r.folder, new Map());
    sysByFolder.get(r.folder).set(r.passport, r.rebate);
  }

  const TOL = 1;
  const report = { month: args.month, workspaceKey: ws, producedAt: new Date().toISOString(), pipeline: tm ? { tourMatch: tm, billMatch: { matched: bm?.matched }, merge: { matched: mg?.matched, refund: mg?.refund, refundLinked: mg?.refundLinked } } : 'compare-only(复用已有库)', buckets: {} };
  console.log('\n========== 准确率(按客户护照号,容差±1₩) ==========');
  for (const [folder, answerRel] of Object.entries(cfg.answers)) {
    const answerPath = sample(answerRel);
    if (!fs.existsSync(answerPath)) { console.log(`${folder}: 答案文件缺失 ${answerRel}`); continue; }
    const answer = await loadAnswer(answerPath);
    const sys = sysByFolder.get(folder) || new Map();
    let exact = 0;
    const diffs = [];
    const missing = [];
    for (const [passport, ansVal] of answer) {
      const sysVal = sys.get(passport);
      if (sysVal == null) { missing.push({ passport, answer: ansVal }); continue; }
      if (Math.abs(sysVal - ansVal) <= TOL) exact += 1;
      else diffs.push({ passport, system: Math.round(sysVal), answer: ansVal, delta: Math.round(sysVal - ansVal) });
    }
    const extra = [...sys.keys()].filter((p) => !answer.has(p));
    const total = answer.size;
    const rate = total ? ((exact / total) * 100).toFixed(1) : '0.0';
    console.log(`${folder}: 答案客户 ${total} | 金额一致 ${exact} (${rate}%) | 金额差异 ${diffs.length} | 系统缺失 ${missing.length} | 系统多出 ${extra.length}`);
    report.buckets[folder] = { totalCustomers: total, exact, rate: Number(rate), diffs: diffs.slice(0, 200), missing: missing.slice(0, 200), extraCount: extra.length, extra: extra.slice(0, 50) };
  }

  if (args.json) {
    fs.mkdirSync(path.dirname(path.resolve(args.json)), { recursive: true });
    fs.writeFileSync(args.json, JSON.stringify(report, null, 2), 'utf8');
    console.log(`\n报告: ${args.json}`);
  }
  if (args.keep) console.log(`库保留: ${dir}`);
  db.close?.();
  if (!args.keep) fs.rmSync(dir, { recursive: true, force: true });
}

main().catch((e) => { console.error('acceptance failed:', e); process.exit(1); });
