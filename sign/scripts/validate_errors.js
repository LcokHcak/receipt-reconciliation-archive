'use strict';

/**
 * Parse 1月错.xlsx (ground-truth error workbook) into a normalised error
 * set, then compare against whatever the rule engine currently detects
 * for a workspace. Produces a precision/recall-style report.
 *
 * Each sheet in 1月错.xlsx is 3–4 error blocks glued side-by-side, split
 * by BLOCK_DELIMITERS below.
 *
 * Usage:
 *   node scripts/validate_errors.js --xlsx <path-to-1月错.xlsx> [--workspace 2026-01]
 *
 * Defaults to data_sample/新建文件夹/5.未收-用来补齐部分/1月错.xlsx and workspace 2026-01.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');

const { openMonthlyDatabase } = require('../lib/storage/monthly_database');
const { createMonthlyWorkspaceRepository } = require('../repositories/monthly_workspace_repository');
const { createGroupCodeRepository } = require('../repositories/group_code_repository');
const { createStoreBillRepository } = require('../repositories/store_bill_repository');
const { createMissingReceiptRepository } = require('../repositories/missing_receipt_repository');
const { createErrorRecordRepository } = require('../repositories/error_record_repository');
const { createImportJobRepository } = require('../repositories/import_job_repository');
const { createDepartureSyncAuditRepository } = require('../repositories/departure_sync_audit_repository');
const { createMonthlyWorkspaceService } = require('../services/monthly/workspace_service');
const { createImportService } = require('../services/monthly/import_service');
const { createErrorDetectionService } = require('../services/monthly/error_detection_service');
const { createCrossCheckService } = require('../services/monthly/cross_check_service');

// ──────────── CLI ─────────────────────────────────────────────────
const argv = parseArgs(process.argv.slice(2));
const DEFAULT_XLSX = 'd:/JIN HAIMIN/self/ticket/data_sample/新建文件夹/5.未收-用来补齐部分/1月错.xlsx';
const DATA_ROOT = 'd:/JIN HAIMIN/self/ticket/data_sample/新建文件夹';
const XLSX_PATH = argv.xlsx || DEFAULT_XLSX;
const WORKSPACE_KEY = argv.workspace || '2026-01';

// ──────────── ground-truth block dictionary ───────────────────────
// Each sheet is manually inspected; columns are stable per block. Each
// block has a "marker" header (e.g. "正确出境日期") that we expect to
// find in the header row to validate we're still looking at the right
// layout.
const BLOCKS = {
  '爱宝客错': [
    { type: 'departure', cols: { receipt: 1, name: 3, passport: 4, actual: 5, expected: 7 }, marker: { col: 7, text: '正确出境日期' } },
    { type: 'dup_passport', cols: { receipt: 10, name: 11, passport: 12, expected: 14 }, marker: { col: 13, text: '一个姓名两个护照' } },
    { type: 'name_wrong', cols: { receipt: 16, name: 17, passport: 18, expected: 20 }, marker: { col: 19, text: '一个护照几个姓名' } },
    { type: 'name_wrong_extra', cols: { receipt: 23, name: 24, passport: 25 }, marker: { col: 28, text: '姓名错' } },
  ],
  '济州新罗错': [
    { type: 'departure', cols: { receipt: 8, name: 4, passport: 6, actual: 7, expected: 10 }, marker: { col: 10, text: '正确出境日期' } },
    { type: 'passport_wrong', cols: { receipt: 18, name: 15, passport: 17, expected: 20 }, marker: { col: 20, text: '正确护照' } },
    { type: 'name_wrong', cols: { receipt: 28, name: 25, passport: 27, expected: 30 }, marker: { col: 29, text: '姓名总账账不符' } },
  ],
  '乐天H错': [
    { type: 'departure', cols: { receipt: 6, name: 4, passport: 5, actual: 7, expected: 9 }, marker: { col: 9, text: '正确出境日期' } },
    { type: 'name_wrong', cols: { receipt: 12, name: 13, passport: 14, expected: 15 }, marker: { col: 15, text: '收票姓名' } },
    { type: 'passport_wrong', cols: { receipt: 19, name: 20, passport: 21, expected: 22 }, marker: { col: 22, text: '收票护照' } },
  ],
  '乐天SG错': [
    { type: 'departure', cols: { receipt: 1, name: 2, passport: 3, actual: 4, expected: 6 }, marker: { col: 6, text: '正确出境日期' } },
    { type: 'name_wrong', cols: { receipt: 8, name: 9, passport: null, expected: 10 }, marker: { col: null, text: '姓名错' } },
    { type: 'passport_wrong', cols: { receipt: 14, name: 15, passport: 16, expected: null }, marker: { col: null, text: '护照错' } },
  ],
};

// Map our ground-truth types to the RULE_IDs the engine emits
const GROUND_TRUTH_TO_RULE = {
  departure: 'CC_DEPARTURE_SYNC',
  dup_passport: 'CC_NAME_PASSPORT',
  name_wrong: 'CC_NAME_PASSPORT',
  name_wrong_extra: 'CC_NAME_PASSPORT',
  passport_wrong: 'CC_NAME_PASSPORT',
};

// ──────────── main ────────────────────────────────────────────────
(async () => {
  console.log(`[validate] xlsx = ${XLSX_PATH}`);
  console.log(`[validate] workspace = ${WORKSPACE_KEY}`);

  if (!fs.existsSync(XLSX_PATH)) {
    console.error(`[validate] file not found: ${XLSX_PATH}`);
    process.exit(2);
  }

  const groundTruth = await parseGroundTruth(XLSX_PATH);
  console.log(`[validate] parsed ${groundTruth.length} ground-truth error rows`);
  const groundTruthByType = groupBy(groundTruth, (r) => r.type);
  for (const [type, rows] of Object.entries(groundTruthByType)) {
    console.log(`  ${type}: ${rows.length}`);
  }

  console.log('\n[validate] provisioning temp workspace...');
  const { db, tmpDb } = provisionDb();
  const deps = wireServices(db);
  deps.workspaceService.open({ workspaceKey: WORKSPACE_KEY, operator: 'validator' });
  await importBaseline(deps.importService);

  console.log('\n[validate] running cross-check + departure sync...');
  const detection = deps.errorDetectionService.runCrossCheck({
    workspaceKey: WORKSPACE_KEY,
    withDepartureSync: true,
    triggeredBy: 'validator',
  });
  console.log(`  summary: ${JSON.stringify(detection.summary)}`);

  const detected = deps.errorRecordRepo.list({ workspaceKey: WORKSPACE_KEY, limit: 100000 });
  console.log(`  total detected: ${detected.length}`);

  console.log('\n[validate] ──────── matching ────────');
  const report = match({ groundTruth, detected });
  printReport(report);

  db.close?.();
  fs.rmSync(tmpDb, { force: true });
  fs.rmSync(`${tmpDb}-wal`, { force: true });
  fs.rmSync(`${tmpDb}-shm`, { force: true });
})().catch((err) => {
  console.error('[validate] FAILED', err);
  process.exit(1);
});

// ──────────── helpers ─────────────────────────────────────────────

function parseArgs(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
      out[key] = val;
    }
  }
  return out;
}

async function parseGroundTruth(filePath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const collected = [];
  for (const sheet of wb.worksheets) {
    const config = BLOCKS[sheet.name];
    if (!config) {
      console.warn(`[validate] no block config for sheet ${sheet.name}; skipping`);
      continue;
    }
    const headerRow = sheet.getRow(1);
    for (const block of config) {
      if (block.marker?.col) {
        const markerText = String(cell(headerRow, block.marker.col) || '').trim();
        if (!markerText.includes(block.marker.text)) {
          console.warn(`[validate]   marker mismatch in ${sheet.name} block ${block.type}: expected "${block.marker.text}", got "${markerText}"; skipping block`);
          continue;
        }
      }
      for (let r = 2; r <= sheet.rowCount; r += 1) {
        const row = sheet.getRow(r);
        const receipt = trimCell(cell(row, block.cols.receipt));
        if (!receipt) continue;
        collected.push({
          type: block.type,
          sheet: sheet.name,
          receiptNo: receipt,
          name: trimCell(cell(row, block.cols.name)),
          passportNo: block.cols.passport ? trimCell(cell(row, block.cols.passport)) : null,
          actualValue: block.cols.actual ? trimCell(cell(row, block.cols.actual)) : null,
          expectedValue: block.cols.expected ? trimCell(cell(row, block.cols.expected)) : null,
        });
      }
    }
  }
  return collected;
}

function cell(row, col) {
  if (!col) return null;
  const v = row.getCell(col).value;
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (v.text) return v.text;
    if (v.result !== undefined) return v.result;
    if (Array.isArray(v.richText)) return v.richText.map((p) => p.text).join('');
  }
  return v;
}

function trimCell(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function groupBy(arr, keyFn) {
  const out = {};
  for (const item of arr) {
    const key = keyFn(item);
    if (!out[key]) out[key] = [];
    out[key].push(item);
  }
  return out;
}

function provisionDb() {
  const tmpDb = path.join(os.tmpdir(), `validate-errors-${Date.now()}.sqlite`);
  const db = openMonthlyDatabase({ dbPath: tmpDb });
  return { db, tmpDb };
}

function wireServices(db) {
  const workspaceRepo = createMonthlyWorkspaceRepository({ db });
  const groupCodeRepo = createGroupCodeRepository({ db });
  const storeBillRepo = createStoreBillRepository({ db });
  const missingReceiptRepo = createMissingReceiptRepository({ db });
  const errorRecordRepo = createErrorRecordRepository({ db });
  const importJobRepo = createImportJobRepository({ db });
  const departureSyncAuditRepo = createDepartureSyncAuditRepository({ db });
  const workspaceService = createMonthlyWorkspaceService({ workspaceRepo });
  const importService = createImportService({
    importJobRepo,
    groupCodeRepo,
    storeBillRepo,
    missingReceiptRepo,
  });
  const crossCheckService = createCrossCheckService({
    storeBillRepo,
    errorRecordRepo,
    departureSyncAuditRepo,
  });
  const errorDetectionService = createErrorDetectionService({
    storeBillRepo,
    errorRecordRepo,
    groupCodeRepo,
    crossCheckService,
  });
  return {
    workspaceRepo,
    groupCodeRepo,
    storeBillRepo,
    missingReceiptRepo,
    errorRecordRepo,
    importJobRepo,
    departureSyncAuditRepo,
    workspaceService,
    importService,
    crossCheckService,
    errorDetectionService,
  };
}

async function importBaseline(importService) {
  const bills = [
    path.join(DATA_ROOT, '3.账单表', '爱宝客', '1月爱宝客客人账单数据.xlsx'),
    path.join(DATA_ROOT, '3.账单表', '乐天SG+H团+釜山', '1月乐天H 客人账单.xlsx'),
    path.join(DATA_ROOT, '3.账单表', '乐天SG+H团+釜山', '乐天SG 1月客人账单.xlsx'),
    path.join(DATA_ROOT, '3.账单表', '新罗V团+济州', '2601月济州新罗V团客人账单数据.xlsx'),
    path.join(DATA_ROOT, '4.最终数据√', '1月爱宝客数据.xlsx'),
    path.join(DATA_ROOT, '4.最终数据√', '1月济州新罗V团数据√.xlsx'),
  ];
  for (const f of bills) {
    if (!fs.existsSync(f)) { console.warn(`  skip missing: ${path.basename(f)}`); continue; }
    const t = Date.now();
    const job = await importService.importStoreBill({ workspaceKey: WORKSPACE_KEY, filePath: f, operator: 'validator' });
    console.log(`  imported: ${path.basename(f)} ins=${job.rowsInserted}/${job.rowsTotal} ms=${Date.now() - t}`);
  }
}

function match({ groundTruth, detected }) {
  // Index detected errors by (receiptNo, errorType)
  const detectedByReceipt = new Map();
  for (const err of detected) {
    const key = `${err.receiptNo || '-'}::${err.errorType}`;
    if (!detectedByReceipt.has(key)) detectedByReceipt.set(key, []);
    detectedByReceipt.get(key).push(err);
  }

  const byType = {};
  for (const truth of groundTruth) {
    const bucket = byType[truth.type] || (byType[truth.type] = {
      truth: 0, matched: 0, missed: [],
    });
    bucket.truth += 1;

    const ruleId = GROUND_TRUTH_TO_RULE[truth.type];
    if (!ruleId) {
      bucket.missed.push({ reason: 'unmapped type', truth });
      continue;
    }
    const key = `${truth.receiptNo}::${ruleId}`;
    const hits = detectedByReceipt.get(key) || [];
    if (hits.length) {
      bucket.matched += 1;
    } else {
      bucket.missed.push({ reason: 'no detection', truth });
    }
  }

  // Also compute "extras" — detected rows we cannot trace back to the
  // ground truth. These are NOT necessarily false positives since 1月错
  // only lists known problems; they're still worth counting.
  const truthReceipts = new Set(groundTruth.map((t) => t.receiptNo));
  const extras = detected.filter((d) => d.receiptNo && !truthReceipts.has(d.receiptNo));

  return { byType, extras };
}

function printReport(report) {
  console.log('\n┌──────────────────────────────────────────────┐');
  console.log('│          RECALL BY GROUND-TRUTH TYPE         │');
  console.log('└──────────────────────────────────────────────┘');
  for (const [type, bucket] of Object.entries(report.byType)) {
    const recall = bucket.truth === 0 ? 1 : bucket.matched / bucket.truth;
    const pct = (recall * 100).toFixed(1).padStart(5);
    console.log(`  ${type.padEnd(20)} matched ${bucket.matched}/${bucket.truth}  recall=${pct}%`);
    if (bucket.missed.length && bucket.missed.length <= 5) {
      for (const m of bucket.missed) {
        console.log(`    · miss: receipt=${m.truth.receiptNo} name=${m.truth.name || '-'} passport=${m.truth.passportNo || '-'}  reason=${m.reason}`);
      }
    } else if (bucket.missed.length) {
      console.log(`    · ${bucket.missed.length} misses; first 3:`);
      bucket.missed.slice(0, 3).forEach((m) => {
        console.log(`      receipt=${m.truth.receiptNo} name=${m.truth.name || '-'}  ${m.reason}`);
      });
    }
  }

  console.log('\n┌──────────────────────────────────────────────┐');
  console.log('│            DETECTED BUT NOT IN GT            │');
  console.log('└──────────────────────────────────────────────┘');
  console.log(`  extras: ${report.extras.length} detected rows whose receipt is absent from 1月错.xlsx`);
  console.log('  (these are candidates for false positives OR genuine new findings)');
  const extrasByType = groupBy(report.extras, (e) => e.errorType);
  for (const [type, rows] of Object.entries(extrasByType)) {
    console.log(`    ${type}: ${rows.length}`);
  }
}
