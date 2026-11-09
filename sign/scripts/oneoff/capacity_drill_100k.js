#!/usr/bin/env node
/**
 * 容量验证脚本：往一个临时 SQLite 注入约 100k 条 group_code +
 * store_bill + daily_receipt 数据，跑完整 pipeline (tour-match →
 * bill-match → merge → second-pass → export)，记录每一步耗时和内存。
 *
 * 调用：
 *   node scripts/capacity_drill_100k.js
 *   node scripts/capacity_drill_100k.js --rows 50000
 *
 * 设计：
 *   - 用一次性 tmp DB，不动生产数据
 *   - 数据生成尽量贴近真实分布：
 *       80% 完美匹配（receipt + tour + name + passport 都一致）
 *       10% 字段冲突（receipt 一致，但 tour_no 不一致）
 *       5% ambiguous（同 receipt 出现 2 条 daily）
 *       5% unmatched bill（bill 无对应 daily）
 *   - 每个阶段跑完 sample heap usage，dump JSON 结果
 *   - 如果哪个阶段超过 5 分钟，记录但不中止（让我们知道极限）
 *
 * 输出 (stdout, jsonl)：
 *   {"stage":"seed","rows":100000,"ms":...,"rssMB":...,"heapMB":...}
 *   {"stage":"tour_match","ms":...,"matched":...,"badcase":...}
 *   ...
 *   {"stage":"summary","totalMs":...,"peakRssMB":...,"finalDbBytes":...}
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { openMonthlyDatabase } = require('../lib/storage/monthly_database');
const { createGroupCodeRepository } = require('../repositories/group_code_repository');
const { createStoreBillRepository } = require('../repositories/store_bill_repository');
const { createDailyReceiptRepository } = require('../repositories/daily_receipt_repository');
const { createBillMatchLogRepository } = require('../repositories/bill_match_log_repository');
const { createPendingReviewRepository } = require('../repositories/pending_review_repository');
const { createMonthlyDataRepository } = require('../repositories/monthly_data_repository');
const { createMatchBadcaseRepository } = require('../repositories/match_badcase_repository');
const { createMonthlyWorkspaceRepository } = require('../repositories/monthly_workspace_repository');
const { createTourMatchService } = require('../services/monthly/tour_match_service');
const { createBillMatchService } = require('../services/monthly/bill_match_service');
const { createMergeService } = require('../services/monthly/merge_service');
const { createSecondPassMissingService } = require('../services/monthly/second_pass_missing_service');
const { createMonthlyExportService } = require('../services/monthly/monthly_export_service');
const { createMonthlyWorkspaceService } = require('../services/monthly/workspace_service');
const { allRequiredModes } = require('../lib/monthly_pipeline/mode_folder_classifier');

const args = parseArgs(process.argv.slice(2));
const TARGET_ROWS = Number(args.rows || 100000);
const WORKSPACE_KEY = '2026-05';

let peakRssMB = 0;
const REQUIRED_MODES = allRequiredModes();

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok.startsWith('--')) {
      const key = tok.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) { out[key] = 'true'; }
      else { out[key] = next; i += 1; }
    }
  }
  return out;
}

function snapMem() {
  const m = process.memoryUsage();
  const rssMB = Math.round(m.rss / 1024 / 1024);
  if (rssMB > peakRssMB) peakRssMB = rssMB;
  return {
    rssMB,
    heapMB: Math.round(m.heapUsed / 1024 / 1024),
    externalMB: Math.round(m.external / 1024 / 1024),
  };
}

function logStage(stage, fields) {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    stage,
    ...fields,
    ...snapMem(),
  }));
}

function _randTourNo(i) { // 备用,_=有意保留未用
  // 真实 tour_no 格式参考: 71993, 26112260
  // 把所有 tour_no 限制在 1000 个范围内，保证 group_code 能覆盖到
  return String(70000 + (i % 1000));
}
function randAgent(tourIdx) {
  // 按 tour 索引选 agent，确保 group_code 和 daily 对应同一个 tour 时
  // agent 完全一致（不会触发 agent_mismatch noise）
  const agents = ['梓陌', '阿浩', '小白', '老王', '阿珍'];
  return agents[tourIdx % agents.length];
}
function randName(i) {
  const surnames = ['LI', 'WANG', 'ZHANG', 'LIU', 'CHEN', 'YANG', 'ZHAO'];
  const givens = ['MING', 'WEI', 'JING', 'HUA', 'QIANG', 'XIN', 'LIN'];
  return `${surnames[i % surnames.length]} ${givens[(i >> 3) % givens.length]}`;
}
function randPassport(i) {
  return `P${String(10000000 + i).padStart(8, '0')}`;
}
function randDate(i) {
  const day = 1 + (i % 27);
  return `2026-05-${String(day).padStart(2, '0')}`;
}
function randReceipt(i) {
  return `R${String(100000 + i).padStart(7, '0')}`;
}
function randRequiredMode(i) {
  return REQUIRED_MODES[i % REQUIRED_MODES.length];
}
function rowHash(parts) {
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex');
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capacity-drill-'));
  const dbPath = path.join(tmpDir, 'monthly.sqlite');
  const exportDir = path.join(tmpDir, 'exports');
  fs.mkdirSync(exportDir, { recursive: true });

  console.log(JSON.stringify({
    ts: new Date().toISOString(), stage: 'init',
    dbPath, targetRows: TARGET_ROWS,
  }));

  const db = openMonthlyDatabase({ dbPath });
  const workspaceRepo = createMonthlyWorkspaceRepository({ db });
  const groupCodeRepo = createGroupCodeRepository({ db });
  const storeBillRepo = createStoreBillRepository({ db });
  const dailyReceiptRepo = createDailyReceiptRepository({ db });
  const billMatchLogRepo = createBillMatchLogRepository({ db });
  const pendingReviewRepo = createPendingReviewRepository({ db });
  const monthlyDataRepo = createMonthlyDataRepository({ db });
  const matchBadcaseRepo = createMatchBadcaseRepository({ db });

  const workspaceService = createMonthlyWorkspaceService({ workspaceRepo });
  workspaceService.open({ workspaceKey: WORKSPACE_KEY, operator: 'capacity_drill' });

  // ── Seed group_code ──────────────────────────────────────
  let t0 = Date.now();
  // 覆盖 randTourNo 的整个 1000 个 tour 范围
  const TOUR_COUNT = 1000;
  const importedAt = new Date().toISOString();
  const gcs = [];
  for (let i = 0; i < TOUR_COUNT; i += 1) {
    const tour = String(70000 + i);
    const mode = randRequiredMode(i);
    gcs.push({
      workspaceKey: WORKSPACE_KEY, tourNo: tour,
      mode, modeNormalized: 'SG',
      agent: randAgent(i),
      applyDate: '2026-05-01', endDate: '2026-05-31',
      rowHash: rowHash(['gc', tour, String(i)]),
      importedAt,
    });
  }
  groupCodeRepo.insertMany(gcs);
  logStage('seed_group_code', { rows: TOUR_COUNT, ms: Date.now() - t0 });

  // ── Seed daily_receipt + store_bill ───────────────────────
  // 80% 完美匹配 / 10% conflict / 5% ambiguous / 5% unmatched bill
  t0 = Date.now();
  const dailies = [];
  const bills = [];
  for (let i = 0; i < TARGET_ROWS; i += 1) {
    const tourIdx = i % 1000;
    const tour = String(70000 + tourIdx);
    const agent = randAgent(tourIdx);   // 与 group_code 对齐
    const mode = randRequiredMode(tourIdx);
    const name = randName(i);
    const passport = randPassport(i);
    const purchaseDate = randDate(i);
    const receipt = randReceipt(i);
    const bucket = i % 100;

    // common daily row
    dailies.push({
      workspaceKey: WORKSPACE_KEY,
      receiptNo: receipt, tourNo: tour, agent, name, passportNo: passport,
      shop: '乐天免税店', purchaseDate, modeRaw: mode, modeNormalized: 'SG',
      rowHash: rowHash(['d', String(i)]),
      importedAt,
    });

    if (bucket < 80) {
      // 80% perfect match
      bills.push({
        workspaceKey: WORKSPACE_KEY, storeFamily: '乐天免税店',
        receiptNo: receipt, tourNo: tour, name, passportNo: passport,
        purchaseDate, isDetailSheet: true,
        rowHash: rowHash(['b', String(i)]), importedAt,
      });
    } else if (bucket < 90) {
      // 10% field_conflict: bill 的 tour_no 不同
      bills.push({
        workspaceKey: WORKSPACE_KEY, storeFamily: '乐天免税店',
        receiptNo: receipt, tourNo: `${tour}-X`, name, passportNo: passport,
        purchaseDate, isDetailSheet: true,
        rowHash: rowHash(['b', String(i), 'conflict']), importedAt,
      });
    } else if (bucket < 95) {
      // 5% ambiguous: 多塞一条同 receipt 的 daily
      dailies.push({
        workspaceKey: WORKSPACE_KEY,
        receiptNo: receipt, tourNo: tour, agent, name: randName(i + 9999),
        passportNo: randPassport(i + 9999),
        shop: '乐天免税店', purchaseDate,
        modeRaw: mode, modeNormalized: 'SG',
        rowHash: rowHash(['d', String(i), 'dup']),
        importedAt,
      });
      bills.push({
        workspaceKey: WORKSPACE_KEY, storeFamily: '乐天免税店',
        receiptNo: receipt, tourNo: tour, name, passportNo: passport,
        purchaseDate, isDetailSheet: true,
        rowHash: rowHash(['b', String(i)]), importedAt,
      });
    } else {
      // 5% unmatched bill (no daily for this receipt)
      bills.push({
        workspaceKey: WORKSPACE_KEY, storeFamily: '乐天免税店',
        receiptNo: `${receipt}-ORPHAN`, tourNo: tour, name, passportNo: passport,
        purchaseDate, isDetailSheet: true,
        rowHash: rowHash(['b', String(i), 'orphan']), importedAt,
      });
    }
  }
  dailyReceiptRepo.insertMany(dailies);
  storeBillRepo.insertMany(bills);
  logStage('seed_daily_bill', {
    dailyRows: dailies.length, billRows: bills.length,
    ms: Date.now() - t0,
  });

  // ── Pipeline ─────────────────────────────────────────────
  const tourMatchService = createTourMatchService({
    dailyReceiptRepo, groupCodeRepo, pendingReviewRepo, matchBadcaseRepo,
  });
  const billMatchService = createBillMatchService({
    storeBillRepo, dailyReceiptRepo, billMatchLogRepo, pendingReviewRepo, matchBadcaseRepo,
  });
  const mergeService = createMergeService({
    dailyReceiptRepo, billMatchLogRepo, monthlyDataRepo,
  });
  const secondPassService = createSecondPassMissingService({
    dailyReceiptRepo, storeBillRepo, pendingReviewRepo,
  });
  const exportService = createMonthlyExportService({
    monthlyDataRepo, pendingReviewRepo, db,
  });

  t0 = Date.now();
  const tourResult = await tourMatchService.run({ workspaceKey: WORKSPACE_KEY, operator: 'drill' });
  logStage('tour_match', {
    ms: Date.now() - t0,
    scanned: tourResult.scanned, matched: tourResult.matched,
    tourNotFound: tourResult.tourNotFound, agentMismatch: tourResult.agentMismatch,
    skippedModeNotRequired: tourResult.skippedModeNotRequired,
    folderBreakdown: tourResult.folderBreakdown,
  });

  t0 = Date.now();
  const billResult = await billMatchService.run({ workspaceKey: WORKSPACE_KEY });
  logStage('bill_match', {
    ms: Date.now() - t0,
    scanned: billResult.billsScanned, matched: billResult.matched,
    ambiguous: billResult.ambiguous, conflicts: billResult.conflicts,
    unmatched: billResult.unmatched,
  });

  t0 = Date.now();
  const mergeResult = await mergeService.run({ workspaceKey: WORKSPACE_KEY });
  logStage('merge', {
    ms: Date.now() - t0,
    inserted: mergeResult.inserted, matched: mergeResult.matched,
    unmatched: mergeResult.unmatched, skippedNoFolder: mergeResult.skippedNoFolder,
  });

  t0 = Date.now();
  const spResult = await secondPassService.run({ workspaceKey: WORKSPACE_KEY, dateWindowDays: 2 });
  logStage('second_pass', {
    ms: Date.now() - t0,
    scanned: spResult.scanned, promotedToReview: spResult.promotedToReview,
  });

  t0 = Date.now();
  const expResult = await exportService.run({ workspaceKey: WORKSPACE_KEY, outputDir: exportDir });
  logStage('export', {
    ms: Date.now() - t0,
    fileCount: expResult.files.length,
    totalBytes: expResult.files.reduce((s, f) => s + (fs.statSync(f.path).size || 0), 0),
  });

  // ── Summary ──────────────────────────────────────────────
  const dbStat = fs.statSync(dbPath);
  logStage('summary', {
    targetRows: TARGET_ROWS,
    peakRssMB,
    finalDbBytes: dbStat.size,
    finalDbMB: Math.round(dbStat.size / 1024 / 1024),
    tmpDir,
  });

  db.close();
  // 演练目录留给调用方决定是否清理；默认清理
  if (String(args.keep || 'false') !== 'true') {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } else {
    console.log(JSON.stringify({ ts: new Date().toISOString(), stage: 'kept', tmpDir }));
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    ts: new Date().toISOString(), stage: 'fatal',
    err: String(error?.message || error),
    stack: error?.stack,
  }));
  process.exit(1);
});
