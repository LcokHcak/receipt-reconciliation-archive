'use strict';

/**
 * Builds a small operator-facing monthly test package on Desktop/test0517.
 *
 * It intentionally runs the same service layer used by the app:
 * 1. generate a diverse subset from the provided sample xlsx files
 * 2. import daily ledger + store bills into an isolated sqlite database
 * 3. run bill matching, merge, second-pass scan, monthly export, and receipt summary
 * 4. copy logs and generated xlsx files into an easy-to-check folder
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ExcelJS = require('exceljs');

const { streamRows } = require('../lib/monthly_pipeline/xlsx_reader');
const { mapDailyReceiptRow, FIELD_ALIASES: DAILY_ALIASES } = require('../lib/monthly_pipeline/daily_receipt_mapper');
const { mapStoreBillRow, FIELD_ALIASES: BILL_ALIASES } = require('../lib/monthly_pipeline/bill_mapper');
const { openMonthlyDatabase } = require('../lib/storage/monthly_database');
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
const { createMonthlyWorkspaceService } = require('../services/monthly/workspace_service');
const { createImportService } = require('../services/monthly/import_service');
const { createBillMatchService } = require('../services/monthly/bill_match_service');
const { createMergeService } = require('../services/monthly/merge_service');
const { createSecondPassMissingService } = require('../services/monthly/second_pass_missing_service');
const { createMonthlyExportService } = require('../services/monthly/monthly_export_service');
const { createReceivedReceiptExportService } = require('../services/monthly/received_receipt_export_service');
const { createStageLogService } = require('../services/monthly/stage_log_service');

const WORKSPACE_KEY = '2026-01';
const OPERATOR = 'test0517';
const TARGET_ROOT = path.join(os.homedir(), 'Desktop', 'test0517');
const SAMPLE_ROOT = path.resolve('D:/JIN HAIMIN/self/ticket/data_sample/新建文件夹');

const SOURCE_SETS = [
  {
    label: '乐天首尔',
    daily: path.join(SAMPLE_ROOT, '4.最终数据√', '乐天首尔+釜山', '1月乐天免税店数据√.xlsx'),
    bill: path.join(SAMPLE_ROOT, '3.账单表', '乐天SG+H团+釜山', '乐天SG 1月客人账单.xlsx'),
  },
  {
    label: '乐天釜山',
    daily: path.join(SAMPLE_ROOT, '4.最终数据√', '乐天首尔+釜山', '1月乐天釜山SG数据√.xlsx'),
    bill: path.join(SAMPLE_ROOT, '3.账单表', '乐天SG+H团+釜山', '乐天釜山卖出1月-客人账单.xlsx'),
  },
  {
    label: '爱宝客',
    daily: path.join(SAMPLE_ROOT, '4.最终数据√', '1月爱宝客数据.xlsx'),
    bill: path.join(SAMPLE_ROOT, '3.账单表', '爱宝客', '1月爱宝客客人账单数据.xlsx'),
  },
  {
    label: '济州新罗V团',
    daily: path.join(SAMPLE_ROOT, '4.最终数据√', '1月济州新罗V团数据√.xlsx'),
    bill: path.join(SAMPLE_ROOT, '3.账单表', '新罗V团+济州', '2601月济州新罗V团客人账单数据.xlsx'),
  },
];

const DAILY_COLUMNS = [
  ['stmtDate', DAILY_ALIASES.stmtDate[0]],
  ['statementDate', DAILY_ALIASES.statementDate[0]],
  ['paymentMode', DAILY_ALIASES.paymentMode[0]],
  ['modeRaw', DAILY_ALIASES.modeRaw[0]],
  ['shop', DAILY_ALIASES.shop[0]],
  ['branch', DAILY_ALIASES.branch[0]],
  ['upstream', DAILY_ALIASES.upstream[0]],
  ['entryCompany', DAILY_ALIASES.entryCompany[0]],
  ['tourGuide', DAILY_ALIASES.tourGuide[0]],
  ['agent', DAILY_ALIASES.agent[0]],
  ['originalDate', DAILY_ALIASES.originalDate[0]],
  ['purchaseDate', DAILY_ALIASES.purchaseDate[0]],
  ['tourNo', DAILY_ALIASES.tourNo[0]],
  ['name', DAILY_ALIASES.name[0]],
  ['passportNo', DAILY_ALIASES.passportNo[0]],
  ['departureDate', DAILY_ALIASES.departureDate[0]],
  ['receiptNo', DAILY_ALIASES.receiptNo[0]],
  ['originalReceiptNo', DAILY_ALIASES.originalReceiptNo[0]],
  ['category', DAILY_ALIASES.category[0]],
  ['brand', DAILY_ALIASES.brand[0]],
  ['sku', DAILY_ALIASES.sku[0]],
  ['productName', DAILY_ALIASES.productName[0]],
  ['refNo', DAILY_ALIASES.refNo[0]],
  ['qty', DAILY_ALIASES.qty[0]],
  ['grossUsd', DAILY_ALIASES.grossUsd[0]],
  ['grossKrw', DAILY_ALIASES.grossKrw[0]],
  ['netUsd', DAILY_ALIASES.netUsd[0]],
  ['netKrw', DAILY_ALIASES.netKrw[0]],
  ['dcUsd', DAILY_ALIASES.dcUsd[0]],
  ['dcKrw', DAILY_ALIASES.dcKrw[0]],
  ['discountRate', DAILY_ALIASES.discountRate[0]],
  ['voucherAmount', DAILY_ALIASES.voucherAmount[0]],
  ['voucherDeduction', DAILY_ALIASES.voucherDeduction[0]],
  ['customerPoints', DAILY_ALIASES.customerPoints[0]],
  ['customerRebate', DAILY_ALIASES.customerRebate[0]],
  ['storeBasePoints', DAILY_ALIASES.storeBasePoints[0]],
  ['storeBaseRebate', DAILY_ALIASES.storeBaseRebate[0]],
  ['storeExtraPoints', DAILY_ALIASES.storeExtraPoints[0]],
  ['storeExtraAmount', DAILY_ALIASES.storeExtraAmount[0]],
  ['storeFinalRebate', DAILY_ALIASES.storeFinalRebate[0]],
  ['categorySecondary', DAILY_ALIASES.category[0]],
  ['remark', DAILY_ALIASES.remark[0]],
];

const BILL_COLUMNS = [
  ['mode', BILL_ALIASES.mode[0]],
  ['storeFamily', BILL_ALIASES.storeFamily[0]],
  ['storeBranch', BILL_ALIASES.storeBranch[0]],
  ['tourNo', BILL_ALIASES.tourNo[0]],
  ['purchaseDate', BILL_ALIASES.purchaseDate[0]],
  ['originalDate', BILL_ALIASES.originalDate[0]],
  ['departureDate', BILL_ALIASES.departureDate[0]],
  ['name', BILL_ALIASES.name[0]],
  ['fullName', BILL_ALIASES.fullName[0]],
  ['passportNo', BILL_ALIASES.passportNo[0]],
  ['receiptNo', BILL_ALIASES.receiptNo[0]],
  ['originalReceiptNo', BILL_ALIASES.originalReceiptNo[0]],
  ['brand', BILL_ALIASES.brand[0]],
  ['sku', BILL_ALIASES.sku[0]],
  ['refNo', BILL_ALIASES.refNo[0]],
  ['category', BILL_ALIASES.category[0]],
  ['qty', BILL_ALIASES.qty[0]],
  ['grossUsd', BILL_ALIASES.grossUsd[0]],
  ['grossKrw', BILL_ALIASES.grossKrw[0]],
  ['netUsd', BILL_ALIASES.netUsd[0]],
  ['netKrw', BILL_ALIASES.netKrw[0]],
  ['points', BILL_ALIASES.points[0]],
  ['rebateAmount', BILL_ALIASES.rebateAmount[0]],
];

async function main() {
  resetTarget();
  const dirs = createPackageDirs();
  copyRawFiles(dirs.raw);

  const subset = await buildDiverseSubset();
  await writeWorkbook(path.join(dirs.input, 'daily_receipt_subset.xlsx'), 'Sheet1', DAILY_COLUMNS, subset.dailyRows);
  await writeWorkbook(path.join(dirs.input, 'store_bill_subset.xlsx'), 'Sheet1', BILL_COLUMNS, subset.billRows);
  writeNotes(dirs.notes, subset.notes);

  const dbPath = path.join(TARGET_ROOT, 'monthly_test.sqlite');
  const runResult = await runMonthlyPipeline({
    dbPath,
    dailyFile: path.join(dirs.input, 'daily_receipt_subset.xlsx'),
    billFile: path.join(dirs.input, 'store_bill_subset.xlsx'),
    exportRoot: TARGET_ROOT,
    deliveryDir: dirs.delivery,
  });

  copyWorkspaceLogs(dirs.logs);
  copyDeliveryFiles(path.join(TARGET_ROOT, WORKSPACE_KEY), dirs.delivery);
  writeReports({ dirs, subset, runResult });

  console.log(JSON.stringify({
    target: TARGET_ROOT,
    dailyRows: subset.dailyRows.length,
    billRows: subset.billRows.length,
    logs: fs.readdirSync(dirs.logs).filter((f) => f.endsWith('.log')),
    delivery: fs.readdirSync(dirs.delivery).filter((f) => f.endsWith('.xlsx')),
  }, null, 2));
}

function resetTarget() {
  const target = path.resolve(TARGET_ROOT);
  const expected = path.resolve(os.homedir(), 'Desktop', 'test0517');
  if (target !== expected) {
    throw new Error(`Refusing to delete unexpected path: ${target}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
}

function createPackageDirs() {
  const dirs = {
    root: TARGET_ROOT,
    input: path.join(TARGET_ROOT, 'input'),
    raw: path.join(TARGET_ROOT, 'raw'),
    logs: path.join(TARGET_ROOT, 'logs'),
    delivery: path.join(TARGET_ROOT, 'delivery'),
    notes: path.join(TARGET_ROOT, 'notes'),
  };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  return dirs;
}

function copyRawFiles(rawDir) {
  for (const source of SOURCE_SETS) {
    assertFile(source.daily);
    assertFile(source.bill);
    fs.copyFileSync(source.daily, path.join(rawDir, `${source.label}-台账原始.xlsx`));
    fs.copyFileSync(source.bill, path.join(rawDir, `${source.label}-账单原始.xlsx`));
  }
}

async function buildDiverseSubset() {
  const dailyRows = [];
  const billRows = [];
  const notes = [];

  for (const source of SOURCE_SETS) {
    const daily = await readMappedDaily(source.daily);
    const bills = await readMappedBills(source.bill);
    const dailyByReceipt = new Map(daily.filter((r) => r.receiptNo).map((r) => [clean(r.receiptNo), r]));
    const matchedPairs = [];
    const usedReceipts = new Set();
    for (const bill of bills) {
      const receiptKey = clean(bill.receiptNo);
      const dailyRow = dailyByReceipt.get(receiptKey);
      if (dailyRow && !usedReceipts.has(receiptKey)) {
        matchedPairs.push({ daily: dailyRow, bill });
        usedReceipts.add(receiptKey);
      }
      if (matchedPairs.length >= 6) break;
    }

    if (matchedPairs.length < 2) {
      throw new Error(`${source.label}: not enough exact receipt matches for test subset`);
    }

    const exactPairs = matchedPairs.slice(0, 2);
    for (const pair of exactPairs) {
      dailyRows.push(asDailyRow(pair.daily, { remark: `${source.label} - 匹配成功样本` }));
      billRows.push(asBillRowAligned(pair.bill, pair.daily));
    }
    notes.push(`${source.label}: 选取 ${exactPairs.length} 条小票号一致样本，用于验证匹配成功。`);

    const conflictPair = matchedPairs[2] || matchedPairs[0];
    dailyRows.push(asDailyRow(conflictPair.daily, { remark: `${source.label} - 人工确认样本` }));
    billRows.push(asBillRowAligned(conflictPair.bill, conflictPair.daily, { passportNo: `CONFLICT-${source.label}` }));
    notes.push(`${source.label}: 人为改写 1 条账单护照号，用于验证字段冲突进入人工确认表。`);

    const fuzzyPair = matchedPairs[3] || matchedPairs[1];
    dailyRows.push(asDailyRow(fuzzyPair.daily, { remark: `${source.label} - 模糊候选样本` }));
    billRows.push(asBillRowAligned(fuzzyPair.bill, fuzzyPair.daily, {
      receiptNo: mutateReceiptForFuzzy(fuzzyPair.bill.receiptNo),
    }));
    notes.push(`${source.label}: 人为改写 1 条账单小票号末位，用于验证模糊候选日志。`);

    const unmatched = bills.find((b) => b.receiptNo && !dailyByReceipt.has(clean(b.receiptNo))) || matchedPairs[0].bill;
    billRows.push(asBillRow(unmatched, {
      receiptNo: mutateReceiptForUnmatched(unmatched.receiptNo),
      name: `${unmatched.name || 'UNMATCHED'} TEST`,
      fullName: `${unmatched.fullName || unmatched.name || 'UNMATCHED'} TEST`,
      passportNo: mutatePassport(unmatched.passportNo),
    }));
    notes.push(`${source.label}: 加入 1 条账单有、台账没有的小票，用于验证未收小票账单。`);
  }

  return { dailyRows, billRows, notes };
}

async function readMappedDaily(filePath) {
  const rows = [];
  await streamRows(filePath, (ctx) => {
    const mapped = mapDailyReceiptRow({
      ...ctx,
      workspaceKey: WORKSPACE_KEY,
      sourceFile: path.basename(filePath),
      importedAt: new Date().toISOString(),
      importJobId: 0,
    });
    if (mapped?.receiptNo || mapped?.passportNo || mapped?.name) rows.push(mapped);
  }, { sheetFilter: () => true });
  return rows;
}

async function readMappedBills(filePath) {
  const rows = [];
  await streamRows(filePath, (ctx) => {
    const mapped = mapStoreBillRow({
      ...ctx,
      workspaceKey: WORKSPACE_KEY,
      sourceFile: path.basename(filePath),
      importedAt: new Date().toISOString(),
      importJobId: 0,
    });
    if (mapped?.receiptNo || mapped?.passportNo || mapped?.name) rows.push(mapped);
  }, { sheetFilter: () => true });
  return rows;
}

function asDailyRow(row, overrides = {}) {
  const out = {};
  for (const [key] of DAILY_COLUMNS) out[key] = row?.[key] ?? '';
  out.shop = overrides.shop ?? out.shop ?? row?.storeFamily ?? '';
  out.branch = overrides.branch ?? out.branch ?? row?.storeBranch ?? '';
  return { ...out, ...overrides };
}

function asBillRow(row, overrides = {}) {
  const out = {};
  for (const [key] of BILL_COLUMNS) out[key] = row?.[key] ?? '';
  out.storeFamily = out.storeFamily || row?.shop || '';
  out.storeBranch = out.storeBranch || row?.branch || '';
  return { ...out, ...overrides };
}

function asBillRowAligned(bill, daily, overrides = {}) {
  return asBillRow(bill, {
    receiptNo: daily.receiptNo || bill.receiptNo,
    tourNo: daily.tourNo || bill.tourNo,
    name: daily.name || bill.name,
    fullName: daily.name || bill.fullName || bill.name,
    passportNo: daily.passportNo || bill.passportNo,
    purchaseDate: daily.purchaseDate || bill.purchaseDate,
    departureDate: daily.departureDate || bill.departureDate,
    storeFamily: daily.shop || bill.storeFamily,
    storeBranch: daily.branch || bill.storeBranch,
    mode: daily.modeRaw || bill.mode,
    ...overrides,
  });
}

async function writeWorkbook(filePath, sheetName, columns, rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  sheet.addRow(columns.map(([, header]) => header));
  for (const row of rows) {
    sheet.addRow(columns.map(([key]) => row[key] ?? ''));
  }
  sheet.columns.forEach((column) => { column.width = 16; });
  await workbook.xlsx.writeFile(filePath);
}

async function runMonthlyPipeline({ dbPath, dailyFile, billFile, exportRoot, deliveryDir }) {
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
  const workspaceService = createMonthlyWorkspaceService({ workspaceRepo });
  const importService = createImportService({
    importJobRepo,
    groupCodeRepo,
    storeBillRepo,
    missingReceiptRepo,
    receivedReceiptRepo,
    dailyReceiptRepo,
  });
  const stageLogService = createStageLogService({ exportRoot });

  const workspace = workspaceService.open({ workspaceKey: WORKSPACE_KEY, operator: OPERATOR });
  const importDaily = await importService.importDailyReceipt({ workspaceKey: WORKSPACE_KEY, filePath: dailyFile, operator: OPERATOR });
  stageLogService.writeStageSummary({
    workspaceKey: WORKSPACE_KEY,
    stage: 'import_daily_receipt',
    startedAt: importDaily.startedAt,
    operator: OPERATOR,
    result: {
      按钮: '导入台账/每日收票',
      导入文件: path.basename(dailyFile),
      导入记录数: importDaily.rowsInserted,
      跳过记录数: importDaily.rowsSkipped,
    },
  });

  const importBill = await importService.importStoreBill({ workspaceKey: WORKSPACE_KEY, filePath: billFile, operator: OPERATOR });
  stageLogService.writeStageSummary({
    workspaceKey: WORKSPACE_KEY,
    stage: 'import_store_bill',
    startedAt: importBill.startedAt,
    operator: OPERATOR,
    result: {
      按钮: '选择店铺账单',
      导入文件: path.basename(billFile),
      导入账单明细: importBill.rowsInserted,
      跳过记录数: importBill.rowsSkipped,
    },
  });

  const billMatchService = createBillMatchService({ storeBillRepo, dailyReceiptRepo, billMatchLogRepo, pendingReviewRepo });
  const billMatch = await billMatchService.run({
    workspaceKey: WORKSPACE_KEY,
    stageJobId: 1,
    stageLogService,
  });

  const mergeService = createMergeService({ dailyReceiptRepo, billMatchLogRepo, monthlyDataRepo, storeBillRepo });
  const merge = await mergeService.run({ workspaceKey: WORKSPACE_KEY });
  stageLogService.writeStageSummary({
    workspaceKey: WORKSPACE_KEY,
    stage: 'merge',
    stageJobId: 2,
    startedAt: merge.startedAt,
    operator: OPERATOR,
    result: {
      按钮: '合并月度数据',
      写入正式月度数据: merge.matched,
      写入未收小票账单: merge.unreceived,
      跳过记录数: merge.skipped,
      按业务分类统计: merge.folderBreakdown,
    },
  });

  const secondPassService = createSecondPassMissingService({ dailyReceiptRepo, storeBillRepo, pendingReviewRepo });
  const secondPass = await secondPassService.run({ workspaceKey: WORKSPACE_KEY });
  stageLogService.writeStageSummary({
    workspaceKey: WORKSPACE_KEY,
    stage: 'second_pass',
    stageJobId: 3,
    startedAt: secondPass.startedAt,
    operator: OPERATOR,
    result: {
      按钮: '二次扫漏',
      扫描台账记录: secondPass.scanned,
      新增人工确认: secondPass.promotedToReview,
      仍未匹配: secondPass.stillMissing,
    },
  });

  const monthlyExportService = createMonthlyExportService({ monthlyDataRepo, pendingReviewRepo, db });
  const monthlyExport = await monthlyExportService.run({ workspaceKey: WORKSPACE_KEY, outputDir: path.join(exportRoot, WORKSPACE_KEY) });
  stageLogService.writeStageSummary({
    workspaceKey: WORKSPACE_KEY,
    stage: 'export',
    stageJobId: 4,
    startedAt: monthlyExport.producedAt,
    operator: OPERATOR,
    result: {
      按钮: '导出交付包',
      生成文件数: monthlyExport.files.length,
      文件清单: monthlyExport.files.map((f) => ({ 文件名: path.basename(f.path), 行数: f.rows, 类型: exportKindLabel(f.kind) })),
    },
  });

  const receivedReceiptExportService = createReceivedReceiptExportService({ db, userService: null });
  const receivedExport = await receivedReceiptExportService.run({ workspaceKey: WORKSPACE_KEY, outputDir: path.join(exportRoot, WORKSPACE_KEY) });
  stageLogService.writeStageSummary({
    workspaceKey: WORKSPACE_KEY,
    stage: 'received_receipt_export',
    stageJobId: 5,
    startedAt: receivedExport.producedAt,
    operator: OPERATOR,
    result: {
      按钮: '生成收票汇总',
      生成文件: path.basename(receivedExport.outputPath),
      收票记录数: receivedExport.totalRows,
      未分配员工记录数: receivedExport.unassignedCount,
    },
  });

  const counts = collectCounts(db);
  const result = { workspace, importDaily, importBill, billMatch, merge, secondPass, monthlyExport, receivedExport, counts };
  fs.writeFileSync(path.join(TARGET_ROOT, 'checks.json'), JSON.stringify(result, null, 2), 'utf8');
  db.close?.();
  void deliveryDir;
  return result;
}

function collectCounts(db) {
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const getN = (sql, ...args) => Number(db.prepare(sql).get(...args)?.n || 0);
  return {
    台账记录数: getN('SELECT COUNT(1) AS n FROM daily_receipt_export WHERE workspace_key = ?', WORKSPACE_KEY),
    店铺账单数: getN('SELECT COUNT(1) AS n FROM store_bill WHERE workspace_key = ?', WORKSPACE_KEY),
    账单匹配日志数: getN('SELECT COUNT(1) AS n FROM bill_match_log WHERE workspace_key = ?', WORKSPACE_KEY),
    人工确认待处理数: getN('SELECT COUNT(1) AS n FROM pending_review WHERE workspace_key = ? AND status = ?', WORKSPACE_KEY, 'open'),
    月度数据数: getN('SELECT COUNT(1) AS n FROM monthly_data WHERE workspace_key = ?', WORKSPACE_KEY),
    账单匹配结果: all('SELECT match_status AS status, match_priority AS priority, COUNT(1) AS n FROM bill_match_log WHERE workspace_key = ? GROUP BY match_status, match_priority ORDER BY match_status, match_priority', WORKSPACE_KEY),
    月度数据分类: all('SELECT mode_folder AS folder, is_unmatched AS unmatched, COUNT(1) AS n FROM monthly_data WHERE workspace_key = ? GROUP BY mode_folder, is_unmatched ORDER BY mode_folder, is_unmatched', WORKSPACE_KEY),
  };
}

function copyWorkspaceLogs(logDir) {
  const sourceDir = path.join(TARGET_ROOT, WORKSPACE_KEY, 'logs');
  if (!fs.existsSync(sourceDir)) return;
  for (const file of fs.readdirSync(sourceDir)) {
    if (file.endsWith('.log')) fs.copyFileSync(path.join(sourceDir, file), path.join(logDir, file));
  }
}

function copyDeliveryFiles(workspaceOutDir, deliveryDir) {
  if (!fs.existsSync(workspaceOutDir)) return;
  for (const file of fs.readdirSync(workspaceOutDir)) {
    if (file.endsWith('.xlsx')) fs.copyFileSync(path.join(workspaceOutDir, file), path.join(deliveryDir, file));
  }
}

function writeNotes(notesDir, notes) {
  fs.writeFileSync(path.join(notesDir, '样本选择说明.txt'), [
    '本次 test0517 从 data_sample/新建文件夹 抽取多业务分类样本。',
    '覆盖：匹配成功、字段冲突、模糊候选、账单有但台账未收、多个候选。',
    '',
    ...notes,
  ].join('\n'), 'utf8');
}

function writeReports({ dirs, subset, runResult }) {
  const logs = fs.readdirSync(dirs.logs).filter((f) => f.endsWith('.log')).sort();
  const delivery = fs.readdirSync(dirs.delivery).filter((f) => f.endsWith('.xlsx')).sort();
  const billLog = logs.find((f) => f.startsWith('bill_match_')) || 'logs/bill_match_*.log';

  fs.writeFileSync(path.join(TARGET_ROOT, 'RUN_REPORT_中文.md'), [
    '# test0517 月度流程执行报告',
    '',
    '## 结果',
    '',
    `本次已删除旧的 test0517 并重新生成。测试数据库：\`${path.join(TARGET_ROOT, 'monthly_test.sqlite')}\`。`,
    '',
    `输入台账：${subset.dailyRows.length} 条。`,
    `输入店铺账单：${subset.billRows.length} 条。`,
    `账单匹配：成功 ${runResult.billMatch.matched} 条，未收 ${runResult.billMatch.unmatched} 条，字段冲突 ${runResult.billMatch.conflicts} 条，模糊/多候选 ${runResult.billMatch.fuzzy + runResult.billMatch.ambiguous} 条。`,
    `合并月度数据：正式 ${runResult.merge.matched} 条，未收 ${runResult.merge.unreceived} 条。`,
    `收票汇总：${runResult.receivedExport.totalRows} 条。`,
    '',
    '## 操作员检查重点',
    '',
    `1. 先打开 \`logs/${billLog}\`。`,
    '2. 每一段“第 N 条账单”都能看到：账单来自哪个 Excel 工作表/行、账单Excel字段、台账字段、使用规则、处理结果、数据去向。',
    '3. “数据去向”为【正式月度数据】代表匹配成功；【未收小票账单】代表账单有但台账没收；【人工确认表】代表字段冲突或候选不唯一。',
    '4. 再打开 `delivery/收票汇总.xlsx` 看本月已收小票汇总。',
    '',
    '## 本次日志',
    '',
    ...logs.map((f) => `- \`logs/${f}\``),
    '',
    '## 本次交付文件',
    '',
    ...delivery.map((f) => `- \`delivery/${f}\``),
    '',
  ].join('\n'), 'utf8');

  fs.writeFileSync(path.join(TARGET_ROOT, '流程讲解_中文.md'), buildFlowDoc(runResult, billLog), 'utf8');
  fs.writeFileSync(path.join(TARGET_ROOT, '日志检查说明.md'), buildLogGuide(billLog), 'utf8');
}

function buildFlowDoc(runResult, billLog) {
  return [
    '# 月度账单匹配日志怎么用',
    '',
    '这份说明按真实按钮顺序写，给测试员工检查“系统到底拿什么字段匹配、匹配到哪里去了”。',
    '',
    '## 1. 导入台账/每日收票',
    '',
    '真实系统里这一步来自审核台【导入台账】。本次测试用 `input/daily_receipt_subset.xlsx` 模拟审核后进入台账的数据。',
    '',
    `系统导入 ${runResult.importDaily.rowsInserted} 条。主要字段包括：小票号、团号、姓名、护照号、购买日期、出境日期、免税店、返点模式。`,
    '',
    '## 2. 导入店铺账单',
    '',
    '月度工作台点击【选择店铺账单】，导入店铺 Excel。',
    '',
    `系统导入 ${runResult.importBill.rowsInserted} 条账单明细。主要字段包括：账单小票号、团号、姓名、护照号、购买日期、免税店、金额/返点字段。`,
    '',
    '## 3. 账单匹配',
    '',
    '月度工作台点击【账单匹配】或【账单匹配并合并月度数据】后，系统生成账单匹配日志。',
    '',
    `本次核心日志：\`logs/${billLog}\`。`,
    '',
    '系统逐条按以下规则检查：',
    '',
    '- P1：小票号一致。',
    '- P2：小票号 + 购买日期一致。',
    '- P3：小票号 + 团号一致。',
    '- P4：护照号 + 购买日期 + 免税店一致。',
    '- P5：姓名 + 购买日期 + 免税店一致。',
    '- P6：模糊候选，只进入人工确认。',
    '',
    '日志里每条都会写清楚：',
    '',
    '- 从账单 Excel 哪一行来的。',
    '- 账单Excel字段【小票号/团号/姓名/护照号/购买日期/免税店】是什么。',
    '- 和台账字段【小票号/团号/姓名/护照号/购买日期/免税店】比对结果是什么。',
    '- 使用哪条规则命中。',
    '- 最后进入【正式月度数据】、【未收小票账单】还是【人工确认表】。',
    '',
    `本次匹配结果：成功 ${runResult.billMatch.matched} 条，未收 ${runResult.billMatch.unmatched} 条，字段冲突 ${runResult.billMatch.conflicts} 条，人工确认候选 ${runResult.billMatch.fuzzy + runResult.billMatch.ambiguous} 条。`,
    '',
    '## 4. 合并月度数据',
    '',
    '匹配成功的数据进入正式月度数据；账单有但台账没有的数据进入未收小票账单。',
    '',
    `本次正式月度数据 ${runResult.merge.matched} 条，未收小票账单 ${runResult.merge.unreceived} 条。`,
    '',
    '## 5. 二次扫漏',
    '',
    '系统再扫描仍未匹配的台账，尝试找账单候选。无法安全确认时仍然进入人工确认。',
    '',
    `本次扫描 ${runResult.secondPass.scanned} 条，新增人工确认 ${runResult.secondPass.promotedToReview} 条。`,
    '',
    '## 6. 导出交付包',
    '',
    '导出结果在 `delivery` 目录。正式数据按业务分类拆表，未收和人工确认单独成表。',
    '',
    '## 7. 生成收票汇总',
    '',
    '`delivery/收票汇总.xlsx` 是本月已入台账小票汇总。本次因为没有绑定真实员工账号，所以进入“未分配”sheet。',
    '',
  ].join('\n');
}

function buildLogGuide(billLog) {
  return [
    '# 操作员如何检查账单匹配日志',
    '',
    `打开：\`C:\\Users\\SAMSUNG\\Desktop\\test0517\\logs\\${billLog}\`。`,
    '',
    '每条账单按以下顺序看：',
    '',
    '1. 看“账单来源”：确认是店铺 Excel 的哪个工作表、哪一行。',
    '2. 看“账单Excel主要字段”：确认小票号、团号、姓名、护照号、购买日期、免税店是否是 Excel 里的值。',
    '3. 看“使用规则”：知道系统用 P1/P2/P3/P4/P5/P6 哪条规则判断。',
    '4. 看“字段比对”：这里会写“账单Excel字段【小票号】=...；台账字段【小票号】=...；结果：一致/不一致”。',
    '5. 看“数据去向”：',
    '   - 【正式月度数据】：匹配成功，后面会进入业务分类数据表。',
    '   - 【未收小票账单】：店铺账单有，但台账没收到对应小票。',
    '   - 【人工确认表】：字段冲突、多个候选或模糊候选，需要人工判断。',
    '',
    '检查是否匹配对了，主要看两件事：',
    '',
    '- 规则是否合理：比如 P1 小票号一致最可信；P6 只是候选，不能自动入月。',
    '- 字段是否一致：如果小票号一致但护照号/姓名明显冲突，就应该进入人工确认。',
    '',
  ].join('\n');
}

function exportKindLabel(kind) {
  return {
    matched: '正式数据',
    missing: '未收小票总表',
    missing_folder: '业务分类未收',
    pending: '人工确认',
  }[kind] || kind;
}

function clean(value) {
  return String(value || '').trim().replace(/\s+/g, '').toLowerCase();
}

function mutateReceiptForFuzzy(receiptNo) {
  const s = String(receiptNo || '').trim();
  if (s.length < 3) return `FUZZY${Date.now()}`;
  const last = s.slice(-1);
  const next = last === '9' ? '8' : '9';
  return `${s.slice(0, -1)}${next}`;
}

function mutateReceiptForUnmatched(receiptNo) {
  const s = String(receiptNo || '').replace(/\D/g, '');
  if (!s) return `999${Date.now()}`;
  return `99${s.slice(2)}`;
}

function mutatePassport(passportNo) {
  const s = String(passportNo || 'P0000000').trim();
  return `${s.slice(0, 1) || 'P'}X${s.slice(2) || '000000'}`;
}

function assertFile(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`Missing sample file: ${filePath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
