'use strict';

/**
 * End-to-end monthly package rehearsal for the 2026-05-18 release check.
 *
 * What it simulates:
 * 1. Read real rows from data_sample/新建文件夹/2.收票汇总/收票汇总.xlsx.
 * 2. Create 200 workbench-origin ledger rows, with customer folders and images.
 * 3. Create a controlled store-bill workbook containing:
 *    - exact matches
 *    - field conflicts
 *    - fuzzy candidates
 *    - ambiguous duplicate-receipt candidates
 *    - unmatched store-bill rows
 * 4. Run the same monthly services used by the app:
 *    group-code import, store-bill import, bill matching, merge, exports,
 *    received-receipt summary.
 * 5. Write operator-readable logs and a final delivery package to Desktop.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ExcelJS = require('exceljs');

const { streamRows } = require('../lib/monthly_pipeline/xlsx_reader');
const {
  mapReceivedReceiptRow,
  isReceiptWorkerSheet,
} = require('../lib/monthly_pipeline/receipt_mapper');
const { hashRow } = require('../lib/monthly_pipeline/row_hasher');
const { classifyModeFolder } = require('../lib/monthly_pipeline/mode_folder_classifier');
const { openMonthlyDatabase } = require('../lib/storage/monthly_database');
const { ensureDir } = require('../lib/workbench_utils');

const { createMonthlyWorkspaceRepository } = require('../repositories/monthly_workspace_repository');
const { createImportJobRepository } = require('../repositories/import_job_repository');
const { createGroupCodeRepository } = require('../repositories/group_code_repository');
const { createStoreBillRepository } = require('../repositories/store_bill_repository');
const { createMissingReceiptRepository } = require('../repositories/missing_receipt_repository');
const { createReceivedReceiptRepository } = require('../repositories/received_receipt_repository');
const { createDailyReceiptRepository } = require('../repositories/daily_receipt_repository');
const { createBillMatchLogRepository } = require('../repositories/bill_match_log_repository');
const { createPendingReviewRepository } = require('../repositories/pending_review_repository');
const { createMonthlyDataRepository } = require('../repositories/monthly_data_repository');
const { createCustomerLibraryRepository } = require('../repositories/customer_library_repository');

const { createMonthlyWorkspaceService } = require('../services/monthly/workspace_service');
const { createImportService } = require('../services/monthly/import_service');
const { createBillMatchService } = require('../services/monthly/bill_match_service');
const { createMergeService } = require('../services/monthly/merge_service');
const { createSecondPassMissingService } = require('../services/monthly/second_pass_missing_service');
const { createMonthlyExportService } = require('../services/monthly/monthly_export_service');
const { createReceivedReceiptExportService } = require('../services/monthly/received_receipt_export_service');
const { createStageLogService } = require('../services/monthly/stage_log_service');

const WORKSPACE_KEY = '2026-01';
const CUSTOMER_WORKSPACE_KEY = '20260518_E2E200';
const OPERATOR = 'reviewer_a';
const TARGET_ROOT = path.join(os.homedir(), 'Desktop', 'e2e_200_0518');
const DATA_SAMPLE_ROOT = path.resolve(__dirname, '..', '..', 'data_sample');
const SAMPLE_ROOT = path.join(DATA_SAMPLE_ROOT, '新建文件夹');
const SAMPLE_IMAGE_ROOT = path.join(DATA_SAMPLE_ROOT, '2026-1月济州新罗文件夹 385');

const RECEIVED_RECEIPT_FILE = path.join(SAMPLE_ROOT, '2.收票汇总', '收票汇总.xlsx');
const GROUP_CODE_FILE = path.join(SAMPLE_ROOT, '1.团号汇总', '团号汇总.xlsx');

const REVIEWERS = [
  { id: 1, username: 'reviewer_a', display_name: '审核员A', agent_code: '9', is_active: 1 },
  { id: 2, username: 'reviewer_b', display_name: '审核员B', agent_code: '10', is_active: 1 },
  { id: 3, username: 'reviewer_c', display_name: '审核员C', agent_code: '11', is_active: 1 },
];

const MODE_CASES = [
  {
    modeRaw: '济州新罗V团-本司',
    shop: 'THE SHILLA',
    branch: '新罗济州',
    agentFallback: '济州代理',
  },
  {
    modeRaw: '爱宝客SG-本司',
    shop: 'SHILLA IPARK',
    branch: '爱宝客',
    agentFallback: '爱宝客代理',
  },
  {
    modeRaw: '乐天SG-本司',
    shop: 'LOTTE',
    branch: '乐天明洞',
    agentFallback: '乐天首尔代理',
  },
  {
    modeRaw: '乐天釜山SG-本司',
    shop: 'LOTTE',
    branch: '乐天釜山',
    agentFallback: '乐天釜山代理',
  },
];

const BILL_HEADERS = [
  '返点模式', '免税店', '免税分店', '团号', '购买日期', '原日期', '出境日期',
  '姓名', '完整姓名', '护照号', '小票号', '原小票号', '品牌', 'SKU',
  'REF NO', '分类', '数量', '总卖出($)', '总卖出(￦)', '纯卖出($)', '纯卖出(￦)',
  '客人点数', '客人返点金额',
];

const DAILY_PREVIEW_HEADERS = [
  '场景', '客户ID', '收票日期', '代理', '负责人账号', '购买日期', '小票号',
  '团号', '姓名', '护照号', '出境日期', '模式', '免税店', '分店', '入月状态',
];

async function main() {
  resetTarget();
  const dirs = createDirs();
  assertInputs();

  const sourceRows = await readReceivedReceiptRows();
  const imagePool = collectImagePool();
  const built = buildWorkbenchRows(sourceRows);
  await createCustomerLibrary({ dirs, rows: built.dailyRows, imagePool });
  await createBlockedCustomerFolders({ dirs, imagePool });
  await writeDailyPreviewWorkbook(path.join(dirs.input, '审核台入账数据_200条.xlsx'), built.dailyRows);

  const billPlan = buildStoreBills(built.dailyRows);
  const storeBillFile = path.join(dirs.input, '模拟店铺账单_210条.xlsx');
  await writeStoreBillWorkbook(storeBillFile, billPlan.billRows);
  await writeExpectationWorkbook(path.join(dirs.reports, '匹配期望_210条.xlsx'), billPlan.expectations);

  const runResult = await runProgramFlow({
    dirs,
    dailyRows: built.dailyRows,
    storeBillFile,
  });

  await writeActualMatchWorkbook({
    filePath: path.join(dirs.reports, '匹配期望与实际核对.xlsx'),
    expectations: billPlan.expectations,
    db: runResult.db,
  });

  const checks = collectChecks({
    db: runResult.db,
    dirs,
    dailyInsert: runResult.dailyInsert,
    dailyReinsert: runResult.dailyReinsert,
    firstStoreImport: runResult.firstStoreImport,
    secondStoreImport: runResult.secondStoreImport,
    matchResult: runResult.matchResult,
    mergeResult: runResult.mergeResult,
    mergeAgainResult: runResult.mergeAgainResult,
    secondPassResult: runResult.secondPassResult,
    exportResult: runResult.exportResult,
    receiptSummaryResult: runResult.receiptSummaryResult,
  });
  await writeChecksWorkbook(path.join(dirs.reports, '自动检查结果.xlsx'), checks);
  writeRunReport({
    dirs,
    sourceRowsCount: sourceRows.length,
    built,
    billPlan,
    runResult,
    checks,
  });
  copyLogsToRoot(dirs);
  writeSourceIndex(dirs);

  const stdout = {
    targetRoot: TARGET_ROOT,
    workspaceKey: WORKSPACE_KEY,
    sourceRowsRead: sourceRows.length,
    dailyRowsAttempted: built.dailyRows.length,
    dailyInsert: runResult.dailyInsert,
    dailyReinsert: runResult.dailyReinsert,
    storeBillRows: billPlan.billRows.length,
    firstStoreImport: pickImportStats(runResult.firstStoreImport),
    secondStoreImport: pickImportStats(runResult.secondStoreImport),
    matchResult: runResult.matchResult,
    mergeResult: runResult.mergeResult,
    mergeAgainResult: runResult.mergeAgainResult,
    exportFiles: runResult.exportResult.files.map((file) => ({
      name: path.basename(file.path),
      rows: file.rows,
      kind: file.kind,
    })),
    customerEvidence: runResult.exportResult.customerEvidence,
    receiptSummary: runResult.receiptSummaryResult,
    reports: fs.readdirSync(dirs.reports),
    logs: fs.readdirSync(dirs.logs).filter((name) => name.endsWith('.log')),
  };

  if (typeof runResult.db.close === 'function') runResult.db.close();
  console.log(JSON.stringify(stdout, null, 2));
}

function resetTarget() {
  const expected = path.resolve(os.homedir(), 'Desktop', 'e2e_200_0518');
  const actual = path.resolve(TARGET_ROOT);
  if (actual !== expected) {
    throw new Error(`Refusing to reset unexpected target: ${actual}`);
  }
  fs.rmSync(actual, { recursive: true, force: true });
}

function createDirs() {
  const dirs = {
    root: TARGET_ROOT,
    input: path.join(TARGET_ROOT, '01_输入数据'),
    logs: path.join(TARGET_ROOT, '02_匹配过程日志'),
    delivery: path.join(TARGET_ROOT, '03_最终交付包'),
    reports: path.join(TARGET_ROOT, '04_测试报告'),
    customerLibrary: path.join(TARGET_ROOT, '05_模拟客户工作区'),
    db: path.join(TARGET_ROOT, '06_测试数据库'),
  };
  for (const dir of Object.values(dirs)) ensureDir(dir);
  return dirs;
}

function assertInputs() {
  for (const filePath of [RECEIVED_RECEIPT_FILE, GROUP_CODE_FILE]) {
    if (!fs.existsSync(filePath)) throw new Error(`Missing input file: ${filePath}`);
  }
  if (!fs.existsSync(SAMPLE_IMAGE_ROOT)) {
    throw new Error(`Missing sample image root: ${SAMPLE_IMAGE_ROOT}`);
  }
}

async function readReceivedReceiptRows() {
  const rows = [];
  const importedAt = new Date().toISOString();
  await streamRows(
    RECEIVED_RECEIPT_FILE,
    ({ sheetName, rowNumber, asObject }) => {
      const mapped = mapReceivedReceiptRow({
        asObject,
        workspaceKey: WORKSPACE_KEY,
        sheetName,
        sourceFile: path.basename(RECEIVED_RECEIPT_FILE),
        sourceRow: rowNumber,
        importedAt,
        importJobId: 0,
      });
      if (!mapped) return;
      if (!mapped.receiptNo || !mapped.name) return;
      rows.push(mapped);
    },
    { sheetFilter: (name) => isReceiptWorkerSheet(name) },
  );
  if (rows.length < 200) {
    throw new Error(`Need at least 200 received rows, got ${rows.length}`);
  }
  return rows;
}

function buildWorkbenchRows(sourceRows) {
  const dailyRows = [];
  const usedBusinessKeys = new Set();
  let cursor = 0;
  const importedAt = new Date().toISOString();

  while (dailyRows.length < 200) {
    const source = sourceRows[cursor % sourceRows.length];
    const i = dailyRows.length;
    const modeCase = MODE_CASES[i % MODE_CASES.length];
    const reviewer = REVIEWERS[i % REVIEWERS.length];
    const customerId = `CL20260518-${String(i + 1).padStart(3, '0')}`;
    const scenario = scenarioForDailyIndex(i);
    const sourceReceipt = normalizeReceiptNo(source.receiptNo) || `E2E${String(i + 1).padStart(10, '0')}`;
    let receiptNo = sourceReceipt;
    let purchaseDate = source.purchaseDate || janDate((i % 28) + 1);
    if (i >= 190 && i < 200) {
      const base = dailyRows[i - 190];
      receiptNo = base.receiptNo;
      purchaseDate = shiftDate(base.purchaseDate, 1);
    }
    let key = `${receiptNo}|${modeCase.shop}|${purchaseDate}`;
    if (usedBusinessKeys.has(key)) {
      receiptNo = mutateReceiptNo(receiptNo, i);
      key = `${receiptNo}|${modeCase.shop}|${purchaseDate}`;
    }
    usedBusinessKeys.add(key);

    const name = normalizeName(source.name) || `E2E GUEST ${String(i + 1).padStart(3, '0')}`;
    const passportNo = normalizePassport(source.passportNo) || `E2E${String(1000000 + i)}`;
    const agent = String(source.agent || modeCase.agentFallback || `代理${(i % 7) + 1}`).trim();
    const modeFolder = classifyModeFolder({ modeRaw: modeCase.modeRaw });
    const row = {
      workspaceKey: WORKSPACE_KEY,
      sourceCustomerId: customerId,
      stmtDate: source.receiptDate || '2026-05-18',
      statementDate: source.receiptDate || '2026-05-18',
      paymentMode: '手工审核导入',
      modeRaw: modeCase.modeRaw,
      modeNormalized: null,
      shop: modeCase.shop,
      branch: modeCase.branch,
      upstream: '本司',
      entryCompany: 'E2E入店公司',
      tourGuide: '',
      agent,
      originalDate: purchaseDate,
      purchaseDate,
      tourNo: normalizeTourNo(source.tourNo) || tourNoFor(i, modeCase),
      name,
      passportNo,
      departureDate: source.departureDate || shiftDate(purchaseDate, 1),
      receiptNo,
      originalReceiptNo: receiptNo,
      category: '测试分类',
      brand: 'E2E BRAND',
      sku: `SKU-${String(i + 1).padStart(4, '0')}`,
      productName: 'E2E测试商品',
      refNo: `REF-${String(i + 1).padStart(4, '0')}`,
      qty: 1,
      grossUsd: 100 + (i % 50),
      grossKrw: 130000 + i,
      netUsd: 90 + (i % 40),
      netKrw: 120000 + i,
      customerPoints: 1,
      customerRebate: 10,
      storeBasePoints: 1,
      storeBaseRebate: 5,
      storeFinalRebate: 5,
      categorySecondary: 'E2E',
      remark: `E2E200；${scenario}；来源sheet=${source.sourceSheet || ''}；来源行=${source.sourceRow || ''}`,
      billMatchStatus: 'unmatched',
      billMatchPriority: null,
      modeFolder,
      tourMatchStatus: 'matched',
      sourceFile: path.basename(RECEIVED_RECEIPT_FILE),
      sourceSheet: source.sourceSheet || '',
      sourceRow: source.sourceRow || i + 2,
      rawPayload: source.rawPayload || {},
      rowHash: hashRow({
        workspaceKey: WORKSPACE_KEY,
        customerId,
        receiptNo,
        shop: modeCase.shop,
        purchaseDate,
        scenario,
      }),
      importedAt,
      importJobId: null,
      receiptDate: source.receiptDate || '2026-05-18',
      agentId: reviewer.id,
      agentCode: reviewer.agent_code,
      sourceType: 'workbench',
      sourceBatchId: 'batch_e2e_200_0518',
      sourceTaskId: `task_${String(i + 1).padStart(4, '0')}`,
      modifiedBy: reviewer.username,
      ledgerStatus: 'posted',
      postedAt: importedAt,
      postedBy: reviewer.username,
      _scenario: scenario,
      _reviewerName: reviewer.display_name,
    };
    dailyRows.push(row);
    cursor += 1;
  }

  return {
    dailyRows,
    scenarioBreakdown: dailyRows.reduce((acc, row) => {
      acc[row._scenario] = (acc[row._scenario] || 0) + 1;
      return acc;
    }, {}),
  };
}

function scenarioForDailyIndex(i) {
  if (i < 10) return '歧义候选-同小票不同日期';
  if (i < 140) return '匹配成功';
  if (i < 160) return '字段冲突-需人工确认';
  if (i < 180) return '模糊候选-需人工确认';
  if (i < 190) return '匹配成功';
  return '歧义候选-辅助重复台账';
}

function buildStoreBills(dailyRows) {
  const billRows = [];
  const expectations = [];

  function pushBill({ daily, scenario, expected, mutate = null }) {
    const bill = dailyToBillRow(daily);
    if (mutate) mutate(bill, daily);
    billRows.push(bill);
    expectations.push({
      billIndex: billRows.length,
      expected,
      scenario,
      dailyCustomerId: daily?.sourceCustomerId || '',
      dailyReceiptNo: daily?.receiptNo || '',
      billReceiptNo: bill['小票号'],
      name: bill['姓名'],
      passportNo: bill['护照号'],
      purchaseDate: bill['购买日期'],
      modeRaw: bill['返点模式'],
      shop: bill['免税店'],
    });
  }

  for (let i = 0; i < 10; i += 1) {
    pushBill({
      daily: dailyRows[i],
      scenario: '同一小票号命中多条台账，进入人工确认',
      expected: 'ambiguous',
    });
  }
  for (let i = 10; i < 140; i += 1) {
    pushBill({
      daily: dailyRows[i],
      scenario: '小票号唯一且字段一致，进入正式月度数据',
      expected: 'matched',
    });
  }
  for (let i = 140; i < 160; i += 1) {
    pushBill({
      daily: dailyRows[i],
      scenario: '小票号命中，但护照号冲突，进入人工确认',
      expected: 'conflict',
      mutate: (bill) => {
        bill['护照号'] = `CONFLICT${String(100000 + i)}`;
      },
    });
  }
  for (let i = 160; i < 180; i += 1) {
    pushBill({
      daily: dailyRows[i],
      scenario: '小票号末位变动且姓名/护照改写，只能作为模糊候选',
      expected: 'fuzzy',
      mutate: (bill) => {
        bill['小票号'] = makeFuzzyReceiptNo(String(bill['小票号'] || ''), i);
        bill['姓名'] = `${bill['姓名']} TEST`;
        bill['完整姓名'] = bill['姓名'];
        bill['护照号'] = `FUZZY${String(100000 + i)}`;
      },
    });
  }
  for (let i = 180; i < 190; i += 1) {
    pushBill({
      daily: dailyRows[i],
      scenario: '补充一组正常匹配样本，覆盖尾部数据',
      expected: 'matched',
    });
  }
  for (let i = 0; i < 20; i += 1) {
    const modeCase = MODE_CASES[i % MODE_CASES.length];
    const bill = {
      '返点模式': modeCase.modeRaw,
      '免税店': modeCase.shop,
      '免税分店': modeCase.branch,
      '团号': `UM${String(80000 + i)}`,
      '购买日期': janDate((i % 28) + 1),
      '原日期': janDate((i % 28) + 1),
      '出境日期': janDate(((i + 1) % 28) + 1),
      '姓名': `UNMATCHED GUEST ${String(i + 1).padStart(2, '0')}`,
      '完整姓名': `UNMATCHED GUEST ${String(i + 1).padStart(2, '0')}`,
      '护照号': `UM${String(900000 + i)}`,
      '小票号': `UMR${String(900000000 + i)}`,
      '原小票号': `UMR${String(900000000 + i)}`,
      '品牌': 'UNMATCHED BRAND',
      'SKU': `UM-SKU-${i + 1}`,
      'REF NO': `UM-REF-${i + 1}`,
      '分类': '未收测试',
      '数量': 1,
      '总卖出($)': 88,
      '总卖出(￦)': 118000,
      '纯卖出($)': 80,
      '纯卖出(￦)': 110000,
      '客人点数': 1,
      '客人返点金额': 8,
    };
    billRows.push(bill);
    expectations.push({
      billIndex: billRows.length,
      expected: 'unmatched',
      scenario: '店铺账单有，但审核台没有收到小票，进入未收小票账单',
      dailyCustomerId: '',
      dailyReceiptNo: '',
      billReceiptNo: bill['小票号'],
      name: bill['姓名'],
      passportNo: bill['护照号'],
      purchaseDate: bill['购买日期'],
      modeRaw: bill['返点模式'],
      shop: bill['免税店'],
    });
  }

  return { billRows, expectations };
}

function dailyToBillRow(row) {
  return {
    '返点模式': row.modeRaw,
    '免税店': row.shop,
    '免税分店': row.branch,
    '团号': row.tourNo,
    '购买日期': row.purchaseDate,
    '原日期': row.originalDate || row.purchaseDate,
    '出境日期': row.departureDate,
    '姓名': row.name,
    '完整姓名': row.name,
    '护照号': row.passportNo,
    '小票号': row.receiptNo,
    '原小票号': row.originalReceiptNo || row.receiptNo,
    '品牌': row.brand || 'E2E BRAND',
    'SKU': row.sku || '',
    'REF NO': row.refNo || '',
    '分类': row.category || '测试分类',
    '数量': row.qty || 1,
    '总卖出($)': row.grossUsd || 100,
    '总卖出(￦)': row.grossKrw || 130000,
    '纯卖出($)': row.netUsd || 90,
    '纯卖出(￦)': row.netKrw || 120000,
    '客人点数': row.customerPoints || 1,
    '客人返点金额': row.customerRebate || 10,
  };
}

async function runProgramFlow({ dirs, dailyRows, storeBillFile }) {
  const dbPath = path.join(dirs.db, 'monthly_e2e_200.sqlite');
  const db = openMonthlyDatabase({ dbPath });
  const workspaceRepo = createMonthlyWorkspaceRepository({ db });
  const importJobRepo = createImportJobRepository({ db });
  const groupCodeRepo = createGroupCodeRepository({ db });
  const storeBillRepo = createStoreBillRepository({ db });
  const missingReceiptRepo = createMissingReceiptRepository({ db });
  const receivedReceiptRepo = createReceivedReceiptRepository({ db });
  const dailyReceiptRepo = createDailyReceiptRepository({ db });
  const billMatchLogRepo = createBillMatchLogRepository({ db });
  const pendingReviewRepo = createPendingReviewRepository({ db });
  const monthlyDataRepo = createMonthlyDataRepository({ db });
  const customerLibraryRepository = createCustomerLibraryRepository({
    defaultRoot: dirs.customerLibrary,
    settingsPath: path.join(dirs.customerLibrary, 'settings.json'),
  });

  const workspaceService = createMonthlyWorkspaceService({ workspaceRepo });
  workspaceService.open({ workspaceKey: WORKSPACE_KEY, operator: OPERATOR });

  const importService = createImportService({
    importJobRepo,
    groupCodeRepo,
    storeBillRepo,
    missingReceiptRepo,
    receivedReceiptRepo,
    dailyReceiptRepo,
  });
  const stageLogService = createStageLogService({ exportRoot: dirs.root });

  const dailyInsert = dailyReceiptRepo.insertMany(dailyRows);
  const dailyReinsert = dailyReceiptRepo.insertMany(dailyRows.slice(0, 25));
  writeDirectLedgerImportLog({
    stageLogService,
    dailyInsert,
    dailyReinsert,
    dailyRows,
  });

  const groupImport = await importService.importGroupCode({
    workspaceKey: WORKSPACE_KEY,
    filePath: GROUP_CODE_FILE,
    operator: OPERATOR,
  });
  stageLogService.writeStageSummary({
    workspaceKey: WORKSPACE_KEY,
    stage: 'import_group_code',
    stageJobId: groupImport.id,
    operator: OPERATOR,
    result: pickImportStats(groupImport),
  });

  const firstStoreImport = await importService.importStoreBill({
    workspaceKey: WORKSPACE_KEY,
    filePath: storeBillFile,
    operator: OPERATOR,
  });
  stageLogService.writeStageSummary({
    workspaceKey: WORKSPACE_KEY,
    stage: 'import_store_bill',
    stageJobId: firstStoreImport.id,
    operator: OPERATOR,
    result: {
      文件: path.basename(storeBillFile),
      ...pickImportStats(firstStoreImport),
    },
  });

  const secondStoreImport = await importService.importStoreBill({
    workspaceKey: WORKSPACE_KEY,
    filePath: storeBillFile,
    operator: OPERATOR,
  });
  stageLogService.writeStageSummary({
    workspaceKey: WORKSPACE_KEY,
    stage: 'import_store_bill_duplicate_check',
    stageJobId: secondStoreImport.id,
    operator: OPERATOR,
    result: {
      说明: '重复导入同一个店铺账单，用来验证不会新增重复账单明细。',
      文件: path.basename(storeBillFile),
      ...pickImportStats(secondStoreImport),
    },
  });

  const billMatchService = createBillMatchService({
    storeBillRepo,
    dailyReceiptRepo,
    billMatchLogRepo,
    pendingReviewRepo,
  });
  const matchResult = await billMatchService.run({
    workspaceKey: WORKSPACE_KEY,
    stageJobId: firstStoreImport.id,
    stageLogService,
  });

  const mergeService = createMergeService({
    dailyReceiptRepo,
    billMatchLogRepo,
    monthlyDataRepo,
    storeBillRepo,
  });
  const mergeResult = await mergeService.run({ workspaceKey: WORKSPACE_KEY });
  stageLogService.writeStageSummary({
    workspaceKey: WORKSPACE_KEY,
    stage: 'merge',
    operator: OPERATOR,
    result: toOperatorMergeResult(mergeResult),
  });

  const mergeAgainResult = await mergeService.run({ workspaceKey: WORKSPACE_KEY });
  stageLogService.writeStageSummary({
    workspaceKey: WORKSPACE_KEY,
    stage: 'merge_duplicate_check',
    operator: OPERATOR,
    result: {
      说明: '重复点击“合并月度数据”，用于验证 monthly_data 不会重复生成。',
      ...toOperatorMergeResult(mergeAgainResult),
    },
  });

  const secondPassService = createSecondPassMissingService({
    storeBillRepo,
    missingReceiptRepo,
    dailyReceiptRepo,
    pendingReviewRepo,
  });
  const secondPassResult = await secondPassService.run({ workspaceKey: WORKSPACE_KEY });
  stageLogService.writeStageSummary({
    workspaceKey: WORKSPACE_KEY,
    stage: 'second_pass',
    operator: OPERATOR,
    result: secondPassResult,
  });

  const monthlyExportService = createMonthlyExportService({
    monthlyDataRepo,
    pendingReviewRepo,
    db,
    customerLibraryRepository,
  });
  const exportResult = await monthlyExportService.run({
    workspaceKey: WORKSPACE_KEY,
    outputDir: dirs.delivery,
  });
  stageLogService.writeStageSummary({
    workspaceKey: WORKSPACE_KEY,
    stage: 'export',
    operator: OPERATOR,
    result: toOperatorExportResult(exportResult),
  });

  const receiptSummaryService = createReceivedReceiptExportService({
    db,
    userService: {
      async listUsers() {
        return REVIEWERS;
      },
    },
  });
  const receiptSummaryResult = await receiptSummaryService.run({
    workspaceKey: WORKSPACE_KEY,
    outputDir: dirs.delivery,
  });
  stageLogService.writeStageSummary({
    workspaceKey: WORKSPACE_KEY,
    stage: 'received_receipt_export',
    operator: OPERATOR,
    result: receiptSummaryResult,
  });

  return {
    db,
    dailyInsert,
    dailyReinsert,
    groupImport,
    firstStoreImport,
    secondStoreImport,
    matchResult,
    mergeResult,
    mergeAgainResult,
    secondPassResult,
    exportResult,
    receiptSummaryResult,
  };
}

function writeDirectLedgerImportLog({ stageLogService, dailyInsert, dailyReinsert, dailyRows }) {
  const startedAt = new Date().toISOString();
  const log = stageLogService.createRunLog({
    workspaceKey: WORKSPACE_KEY,
    stage: 'import_daily_receipt',
    stageJobId: 2000518,
    startedAt,
  });
  log.writeLine('审核台导入台账日志');
  log.writeLine(`工作区：${WORKSPACE_KEY}`);
  log.writeLine(`本次模拟操作员：${OPERATOR}`);
  log.writeLine('输入：来自收票汇总抽样的 200 条审核通过小票，附带客户目录、图片、账单文件。');
  log.writeLine('处理：写入 daily_receipt_export，source_type=workbench，ledger_status=posted。');
  log.writeLine('');
  log.writeLine(`首次写入：新增 ${dailyInsert.inserted} 条，跳过 ${dailyInsert.skipped} 条。`);
  log.writeLine(`重复写入前 25 条：新增 ${dailyReinsert.inserted} 条，跳过 ${dailyReinsert.skipped} 条。`);
  log.writeLine('重复判断口径：同一工作区 + 小票号 + 免税店 + 购买日期相同，则不会重复入台账。');
  log.writeLine('');
  log.writeLine('负责人写入规则：代理字段来自建客户文件夹时的代理；负责人来自处理该客户的审核员账号 modified_by。');
  const owners = dailyRows.reduce((acc, row) => {
    acc[row.modifiedBy] = (acc[row.modifiedBy] || 0) + 1;
    return acc;
  }, {});
  log.writeJson('负责人分布', owners);
  log.finish({ result: { 首次写入: dailyInsert, 重复写入检查: dailyReinsert } });
}

async function createCustomerLibrary({ dirs, rows, imagePool }) {
  const repo = createCustomerLibraryRepository({
    defaultRoot: dirs.customerLibrary,
    settingsPath: path.join(dirs.customerLibrary, 'settings.json'),
  });
  repo.ensureWorkspace(CUSTOMER_WORKSPACE_KEY);
  const nowIso = new Date().toISOString();

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const customer = repo.createCustomerFolder({
      workspaceKey: CUSTOMER_WORKSPACE_KEY,
      customerId: row.sourceCustomerId,
      agentName: row.agent,
      images: [],
      template: { finalOutputPath: 'template/账单.xlsx', filledAt: nowIso },
    });
    const customerDir = repo.customerDir(CUSTOMER_WORKSPACE_KEY, row.sourceCustomerId);
    const images = copyImagesForCustomer({
      customerDir,
      imagePool,
      index: i,
      count: i % 17 === 0 ? 2 : 1,
    });
    await writeCustomerBillWorkbook({
      filePath: path.join(customerDir, 'template', '账单.xlsx'),
      row,
    });
    repo.saveCustomer({
      ...customer,
      status: 'in_review',
      images,
      displayName: row.name,
      passportNumber: row.passportNo,
    });
    repo.saveCustomer({
      ...repo.loadCustomer(CUSTOMER_WORKSPACE_KEY, row.sourceCustomerId),
      status: 'approved',
      review: {
        lastBatchId: row.sourceBatchId,
        lastSourceGroupId: row.sourceCustomerId,
        approvedAt: nowIso,
      },
    });
    repo.saveCustomer({
      ...repo.loadCustomer(CUSTOMER_WORKSPACE_KEY, row.sourceCustomerId),
      status: 'template_generated',
      template: {
        ...repo.loadCustomer(CUSTOMER_WORKSPACE_KEY, row.sourceCustomerId).template,
        finalOutputPath: 'template/账单.xlsx',
        filledAt: nowIso,
      },
    });
  }
}

async function createBlockedCustomerFolders({ dirs, imagePool }) {
  const repo = createCustomerLibraryRepository({
    defaultRoot: dirs.customerLibrary,
    settingsPath: path.join(dirs.customerLibrary, 'settings.json'),
  });
  const cases = [
    ['CL20260518-901', '缺护照：审核台应标记重拍，不进入台账'],
    ['CL20260518-902', '多护照：同一客户组两个护照，应标记重拍，不进入台账'],
    ['CL20260518-903', '无小票：客户组没有小票，应停留补拍，不进入台账'],
    ['CL20260518-904', '图片不清晰：需要重拍，不进入台账'],
  ];
  for (let i = 0; i < cases.length; i += 1) {
    const [customerId, note] = cases[i];
    const customer = repo.createCustomerFolder({
      workspaceKey: CUSTOMER_WORKSPACE_KEY,
      customerId,
      agentName: '边界测试代理',
      images: [],
    });
    const customerDir = repo.customerDir(CUSTOMER_WORKSPACE_KEY, customerId);
    const images = copyImagesForCustomer({ customerDir, imagePool, index: 300 + i, count: i === 1 ? 2 : 1 });
    repo.saveCustomer({
      ...customer,
      status: 'needs_rephoto',
      images,
      displayName: `BLOCKED CASE ${i + 1}`,
      passportNumber: i === 0 ? '' : `BLOCK${i + 1}`,
      review: {
        ...customer.review,
        note,
      },
    });
  }
  fs.writeFileSync(
    path.join(dirs.reports, '审核前边界客户目录说明.md'),
    [
      '# 审核前边界客户目录说明',
      '',
      '本次额外创建 4 个客户目录，但故意不写入台账，用来验证审核前边界应该被挡住：',
      '',
      '- CL20260518-901：缺护照，应重拍/补拍，不入台账。',
      '- CL20260518-902：多护照，同一客户组只能一个护照，应重拍，不入台账。',
      '- CL20260518-903：无小票，不能生成月度小票数据。',
      '- CL20260518-904：图片不清晰，应重拍，不入台账。',
      '',
      '这些目录位于 `05_模拟客户工作区/20260518_E2E200`，月度库中不应出现这 4 个客户 ID。',
      '',
    ].join('\n'),
    'utf8',
  );
}

function copyImagesForCustomer({ customerDir, imagePool, index, count }) {
  const imagesDir = path.join(customerDir, 'images');
  ensureDir(imagesDir);
  const images = [];
  for (let j = 0; j < count; j += 1) {
    const sourcePath = imagePool[(index + j) % imagePool.length];
    const ext = path.extname(sourcePath) || '.jpg';
    const fileName = `${String(j + 1).padStart(2, '0')}-sample${ext}`;
    const targetPath = path.join(imagesDir, fileName);
    fs.copyFileSync(sourcePath, targetPath);
    images.push({
      imageId: `img_${String(j + 1).padStart(3, '0')}`,
      originalFileName: path.basename(sourcePath),
      relativePath: `images/${fileName}`,
      fileName,
      sortOrder: j + 1,
      reviewStatus: 'accepted',
      reviewSource: 'e2e_200_fixture',
      reviewedAt: new Date().toISOString(),
    });
  }
  return images;
}

async function writeCustomerBillWorkbook({ filePath, row }) {
  ensureDir(path.dirname(filePath));
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('客户账单');
  sheet.columns = [
    { header: '姓名', key: 'name', width: 18 },
    { header: '护照号', key: 'passportNo', width: 16 },
    { header: '小票号', key: 'receiptNo', width: 20 },
    { header: '团号', key: 'tourNo', width: 14 },
    { header: '购买日期', key: 'purchaseDate', width: 12 },
    { header: '免税店', key: 'shop', width: 16 },
    { header: '代理', key: 'agent', width: 14 },
    { header: '负责人账号', key: 'owner', width: 14 },
  ];
  sheet.addRow({
    name: row.name,
    passportNo: row.passportNo,
    receiptNo: row.receiptNo,
    tourNo: row.tourNo,
    purchaseDate: row.purchaseDate,
    shop: row.shop,
    agent: row.agent,
    owner: row.modifiedBy,
  });
  await workbook.xlsx.writeFile(filePath);
}

function collectImagePool() {
  const exts = new Set(['.jpg', '.jpeg', '.png', '.webp']);
  const out = [];
  walk(SAMPLE_IMAGE_ROOT, (filePath) => {
    if (exts.has(path.extname(filePath).toLowerCase())) {
      const stat = fs.statSync(filePath);
      out.push({ filePath, size: stat.size });
    }
  });
  out.sort((a, b) => a.size - b.size);
  if (out.length < 20) throw new Error(`Not enough sample images: ${out.length}`);
  return out.slice(0, 260).map((item) => item.filePath);
}

function walk(dir, onFile) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(fullPath, onFile);
    else if (entry.isFile()) onFile(fullPath);
  }
}

async function writeStoreBillWorkbook(filePath, billRows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sheet1');
  sheet.addRow(BILL_HEADERS);
  for (const row of billRows) {
    sheet.addRow(BILL_HEADERS.map((header) => row[header] ?? ''));
  }
  await workbook.xlsx.writeFile(filePath);
}

async function writeDailyPreviewWorkbook(filePath, rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('审核台账输入');
  sheet.addRow(DAILY_PREVIEW_HEADERS);
  for (const row of rows) {
    sheet.addRow([
      row._scenario,
      row.sourceCustomerId,
      row.receiptDate,
      row.agent,
      row.modifiedBy,
      row.purchaseDate,
      row.receiptNo,
      row.tourNo,
      row.name,
      row.passportNo,
      row.departureDate,
      row.modeRaw,
      row.shop,
      row.branch,
      row.ledgerStatus,
    ]);
  }
  await workbook.xlsx.writeFile(filePath);
}

async function writeExpectationWorkbook(filePath, expectations) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('期望');
  sheet.columns = [
    { header: '账单行序号', key: 'billIndex', width: 10 },
    { header: '期望结果', key: 'expected', width: 14 },
    { header: '场景说明', key: 'scenario', width: 42 },
    { header: '客户ID', key: 'dailyCustomerId', width: 16 },
    { header: '台账小票号', key: 'dailyReceiptNo', width: 20 },
    { header: '账单小票号', key: 'billReceiptNo', width: 20 },
    { header: '姓名', key: 'name', width: 18 },
    { header: '护照号', key: 'passportNo', width: 16 },
    { header: '购买日期', key: 'purchaseDate', width: 12 },
    { header: '模式', key: 'modeRaw', width: 20 },
    { header: '免税店', key: 'shop', width: 16 },
  ];
  expectations.forEach((item) => sheet.addRow(item));
  await workbook.xlsx.writeFile(filePath);
}

async function writeActualMatchWorkbook({ filePath, expectations, db }) {
  const logs = db.prepare(`
    SELECT l.store_bill_id, l.daily_receipt_id, l.match_priority, l.match_status, l.match_key,
           l.conflict_fields, b.receipt_no AS bill_receipt_no, b.name AS bill_name,
           b.passport_no AS bill_passport_no, b.purchase_date AS bill_purchase_date
    FROM bill_match_log l
    LEFT JOIN store_bill b ON b.id = l.store_bill_id
    WHERE l.workspace_key = ?
    ORDER BY l.store_bill_id, l.id
  `).all(WORKSPACE_KEY);
  const logByBillRow = new Map();
  for (const log of logs) {
    if (!logByBillRow.has(Number(log.store_bill_id))) {
      logByBillRow.set(Number(log.store_bill_id), log);
    }
  }
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('期望与实际');
  sheet.columns = [
    { header: '账单行序号', key: 'billIndex', width: 10 },
    { header: '期望结果', key: 'expected', width: 14 },
    { header: '实际结果', key: 'actual', width: 14 },
    { header: '是否符合', key: 'ok', width: 10 },
    { header: '命中规则', key: 'priority', width: 12 },
    { header: '匹配键', key: 'matchKey', width: 36 },
    { header: '命中台账ID', key: 'dailyReceiptId', width: 12 },
    { header: '场景说明', key: 'scenario', width: 42 },
    { header: '账单小票号', key: 'billReceiptNo', width: 20 },
    { header: '冲突字段', key: 'conflictFields', width: 50 },
  ];
  for (const item of expectations) {
    const actual = logByBillRow.get(item.billIndex);
    const actualStatus = actualStatusFor(actual?.match_status);
    sheet.addRow({
      billIndex: item.billIndex,
      expected: item.expected,
      actual: actualStatus,
      ok: expectedMatchesActual(item.expected, actualStatus) ? '是' : '否',
      priority: actual?.match_priority || '',
      matchKey: actual?.match_key || '',
      dailyReceiptId: actual?.daily_receipt_id || '',
      scenario: item.scenario,
      billReceiptNo: item.billReceiptNo,
      conflictFields: actual?.conflict_fields || '',
    });
  }
  await workbook.xlsx.writeFile(filePath);
}

function collectChecks({
  db,
  dirs,
  dailyInsert,
  dailyReinsert,
  firstStoreImport,
  secondStoreImport,
  matchResult,
  mergeResult,
  mergeAgainResult,
  secondPassResult,
  exportResult,
  receiptSummaryResult,
}) {
  const duplicateBusinessRows = db.prepare(`
    SELECT receipt_no, shop, purchase_date, COUNT(1) AS n
    FROM daily_receipt_export
    WHERE workspace_key = ? AND source_type = 'workbench'
    GROUP BY receipt_no, shop, purchase_date
    HAVING COUNT(1) > 1
  `).all(WORKSPACE_KEY);
  const blockedRows = db.prepare(`
    SELECT COUNT(1) AS n
    FROM daily_receipt_export
    WHERE workspace_key = ?
      AND source_customer_id IN ('CL20260518-901', 'CL20260518-902', 'CL20260518-903', 'CL20260518-904')
  `).get(WORKSPACE_KEY)?.n || 0;
  const matchBreakdown = db.prepare(`
    SELECT match_status AS status, match_priority AS priority, COUNT(1) AS n
    FROM bill_match_log
    WHERE workspace_key = ?
    GROUP BY match_status, match_priority
    ORDER BY status, priority
  `).all(WORKSPACE_KEY);
  const pendingBreakdown = db.prepare(`
    SELECT reason_type AS reason, COUNT(1) AS n
    FROM pending_review
    WHERE workspace_key = ? AND status = 'open'
    GROUP BY reason_type
    ORDER BY reason_type
  `).all(WORKSPACE_KEY);
  const monthlyBreakdown = db.prepare(`
    SELECT mode_folder AS folder, is_unmatched, COUNT(1) AS n
    FROM monthly_data
    WHERE workspace_key = ?
    GROUP BY mode_folder, is_unmatched
    ORDER BY folder, is_unmatched
  `).all(WORKSPACE_KEY);
  const receiptSummaryExists = fs.existsSync(receiptSummaryResult.outputPath);
  const evidenceRoot = exportResult.customerEvidence?.outputDir || '';
  const customerEvidenceExists = evidenceRoot && fs.existsSync(evidenceRoot);
  const allDeliveryFiles = fs.readdirSync(dirs.delivery, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);

  return [
    ['台账首次写入', dailyInsert.inserted === 200, `新增 ${dailyInsert.inserted}，跳过 ${dailyInsert.skipped}`],
    ['台账重复写入防重', dailyReinsert.inserted === 0 && dailyReinsert.skipped === 25, `新增 ${dailyReinsert.inserted}，跳过 ${dailyReinsert.skipped}`],
    ['店铺账单首次导入', firstStoreImport.rowsInserted === 210, `新增 ${firstStoreImport.rowsInserted}，跳过 ${firstStoreImport.rowsSkipped}`],
    ['店铺账单重复导入防重', secondStoreImport.rowsInserted === 0 && secondStoreImport.rowsSkipped === 210, `新增 ${secondStoreImport.rowsInserted}，跳过 ${secondStoreImport.rowsSkipped}`],
    ['账单匹配统计', matchResult.matched === 140 && matchResult.conflicts === 20 && matchResult.fuzzy === 20 && matchResult.ambiguous === 10 && matchResult.unmatched === 20, JSON.stringify(matchResult)],
    ['月度合并首次生成', mergeResult.inserted > 0 && mergeResult.matched === 140 && mergeResult.unreceived === 20, JSON.stringify(mergeResult)],
    ['月度合并重复防重', mergeAgainResult.inserted === 0, `第二次合并新增 ${mergeAgainResult.inserted}，跳过 ${mergeAgainResult.skipped}`],
    ['台账业务键无重复', duplicateBusinessRows.length === 0, duplicateBusinessRows.length ? JSON.stringify(duplicateBusinessRows) : '无重复'],
    ['审核前边界未入台账', Number(blockedRows) === 0, `边界客户入台账数量 ${blockedRows}`],
    ['收票汇总已生成', receiptSummaryExists, receiptSummaryResult.outputPath],
    ['客户资料包已生成', Boolean(customerEvidenceExists) && exportResult.customerEvidence.customerCount === 200, JSON.stringify(exportResult.customerEvidence)],
    ['导出文件已生成', allDeliveryFiles.includes('收票汇总.xlsx') && allDeliveryFiles.some((name) => /未收/.test(name)), allDeliveryFiles.join('；')],
    ['匹配分布', true, JSON.stringify(matchBreakdown)],
    ['人工确认分布', true, JSON.stringify(pendingBreakdown)],
    ['月度数据分布', true, JSON.stringify(monthlyBreakdown)],
    ['二次扫漏结果', true, JSON.stringify(secondPassResult)],
  ].map(([name, passed, detail]) => ({ name, passed: Boolean(passed), detail: String(detail || '') }));
}

async function writeChecksWorkbook(filePath, checks) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('检查结果');
  sheet.columns = [
    { header: '检查项', key: 'name', width: 28 },
    { header: '是否通过', key: 'passed', width: 12 },
    { header: '详情', key: 'detail', width: 100 },
  ];
  for (const check of checks) {
    sheet.addRow({
      name: check.name,
      passed: check.passed ? '通过' : '失败',
      detail: check.detail,
    });
  }
  await workbook.xlsx.writeFile(filePath);
}

function writeRunReport({
  dirs,
  sourceRowsCount,
  built,
  billPlan,
  runResult,
  checks,
}) {
  const failed = checks.filter((check) => !check.passed);
  const lines = [
    '# E2E 200 条月度流程测试报告',
    '',
    `生成时间：${new Date().toISOString()}`,
    `测试目录：${dirs.root}`,
    `月度工作区：${WORKSPACE_KEY}`,
    '',
    '## 本次模拟的真实操作顺序',
    '',
    '1. 从样例收票汇总读取真实收票数据。',
    '2. 模拟审核员把 200 条客户小票写入台账，并生成客户目录、图片、客户账单。',
    '3. 导入团号表。',
    '4. 导入店铺账单，并重复导入一次验证不产生重复账单明细。',
    '5. 点击账单匹配，生成逐条中文匹配日志。',
    '6. 合并月度数据，并重复合并一次验证正式月度表不重复。',
    '7. 执行二次扫漏。',
    '8. 导出最终交付包、客户资料包、收票汇总。',
    '',
    '## 数据规模',
    '',
    `- 收票汇总源数据读取：${sourceRowsCount} 条可用行`,
    `- 本次入台账：${built.dailyRows.length} 条`,
    `- 店铺账单：${billPlan.billRows.length} 条`,
    `- 台账场景分布：${JSON.stringify(built.scenarioBreakdown)}`,
    '',
    '## 核心结果',
    '',
    `- 台账首次写入：新增 ${runResult.dailyInsert.inserted}，跳过 ${runResult.dailyInsert.skipped}`,
    `- 台账重复写入检查：新增 ${runResult.dailyReinsert.inserted}，跳过 ${runResult.dailyReinsert.skipped}`,
    `- 店铺账单首次导入：新增 ${runResult.firstStoreImport.rowsInserted}，跳过 ${runResult.firstStoreImport.rowsSkipped}`,
    `- 店铺账单重复导入检查：新增 ${runResult.secondStoreImport.rowsInserted}，跳过 ${runResult.secondStoreImport.rowsSkipped}`,
    `- 账单匹配：成功 ${runResult.matchResult.matched}，字段冲突 ${runResult.matchResult.conflicts}，模糊候选 ${runResult.matchResult.fuzzy}，歧义候选 ${runResult.matchResult.ambiguous}，未收 ${runResult.matchResult.unmatched}`,
    `- 月度合并：正式 ${runResult.mergeResult.matched}，未收 ${runResult.mergeResult.unreceived}，新增 ${runResult.mergeResult.inserted}`,
    `- 重复合并：新增 ${runResult.mergeAgainResult.inserted}，跳过 ${runResult.mergeAgainResult.skipped}`,
    `- 客户资料包：${JSON.stringify(runResult.exportResult.customerEvidence)}`,
    '',
    '## 检查结论',
    '',
    failed.length === 0 ? '所有自动检查通过。' : `发现 ${failed.length} 个失败项：${failed.map((item) => item.name).join('、')}`,
    '',
    '## 重点查看文件',
    '',
    '- `02_匹配过程日志/`：账单匹配逐条中文日志，以及每个按钮的阶段日志。',
    '- `03_最终交付包/收票汇总.xlsx`：确认代理和负责人是否符合预期。',
    '- `03_最终交付包/客户资料/`：每个客户英文名/客户名文件夹，含账单、图片、台账明细、客户信息。',
    '- `04_测试报告/匹配期望与实际核对.xlsx`：每条店铺账单的期望结果与程序实际结果。',
    '- `04_测试报告/自动检查结果.xlsx`：自动检查项汇总。',
    '',
  ];
  fs.writeFileSync(path.join(dirs.reports, 'E2E_200条月度流程测试报告.md'), lines.join('\n'), 'utf8');
}

function copyLogsToRoot(dirs) {
  const workspaceLogs = path.join(dirs.root, WORKSPACE_KEY, 'logs');
  if (!fs.existsSync(workspaceLogs)) return;
  ensureDir(dirs.logs);
  for (const entry of fs.readdirSync(workspaceLogs, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    fs.copyFileSync(path.join(workspaceLogs, entry.name), path.join(dirs.logs, entry.name));
  }
}

function writeSourceIndex(dirs) {
  fs.writeFileSync(
    path.join(dirs.input, '源文件索引.md'),
    [
      '# 源文件索引',
      '',
      `- 收票汇总源文件：${RECEIVED_RECEIPT_FILE}`,
      `- 团号汇总源文件：${GROUP_CODE_FILE}`,
      `- 样例图片源目录：${SAMPLE_IMAGE_ROOT}`,
      '',
      '为避免复制 40MB+ 原始文件，本目录保留生成后的 200 条台账输入镜像和 210 条模拟店铺账单。',
      '',
    ].join('\n'),
    'utf8',
  );
}

function pickImportStats(job) {
  return {
    id: job.id,
    status: job.status,
    rowsTotal: job.rowsTotal,
    rowsInserted: job.rowsInserted,
    rowsSkipped: job.rowsSkipped,
    sourceFile: job.sourceFile,
  };
}

function toOperatorMergeResult(result) {
  return {
    正式月度数据: result.matched,
    未收小票账单: result.unreceived,
    本次新增: result.inserted,
    已存在跳过: result.skipped,
    跳过无模式: result.skippedNoFolder,
    文件夹分布: result.folderBreakdown,
  };
}

function toOperatorExportResult(result) {
  return {
    输出目录: result.outputDir,
    文件: result.files.map((file) => ({
      文件名: path.basename(file.path),
      类型: file.kind,
      行数: file.rows,
      分类: file.folder || '',
    })),
    客户资料包: result.customerEvidence,
  };
}

function actualStatusFor(status) {
  if (status === 'matched') return 'matched';
  if (status === 'conflict') return 'conflict';
  if (status === 'unmatched') return 'unmatched';
  if (status === 'pending_review') return 'ambiguous_or_fuzzy';
  return status || '';
}

function expectedMatchesActual(expected, actual) {
  if (expected === actual) return true;
  if ((expected === 'ambiguous' || expected === 'fuzzy') && actual === 'ambiguous_or_fuzzy') return true;
  return false;
}

function normalizeReceiptNo(value) {
  return String(value || '').trim().replace(/\s+/g, '');
}

function normalizeName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function normalizePassport(value) {
  return String(value || '').trim().replace(/\s+/g, '').toUpperCase();
}

function normalizeTourNo(value) {
  return String(value || '').trim().replace(/\s+/g, '');
}

function tourNoFor(i, modeCase) {
  if (/LOTTE/.test(modeCase.shop) || /乐天/.test(modeCase.branch)) return String(71990000 + i);
  return String(71000 + (i % 900));
}

function janDate(day) {
  return `2026-01-${String(Math.max(1, Math.min(28, day))).padStart(2, '0')}`;
}

function shiftDate(dateText, days) {
  const base = new Date(`${String(dateText || '2026-01-01').slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) return '2026-01-02';
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

function mutateReceiptNo(receiptNo, index) {
  const base = String(receiptNo || '').replace(/[^0-9A-Za-z]/g, '') || 'R';
  return `${base}${String(index).padStart(3, '0')}`.slice(-18);
}

function makeFuzzyReceiptNo(receiptNo, index) {
  const text = String(receiptNo || '').trim();
  if (!text) return `FUZZY${index}`;
  const prefix = text.length > 10 ? text.slice(0, 10) : text.slice(0, Math.max(1, text.length - 1));
  const next = `${prefix}FZ${String(index).padStart(4, '0')}`;
  return next === text ? `${prefix}FZ${String(index + 1000)}` : next;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
