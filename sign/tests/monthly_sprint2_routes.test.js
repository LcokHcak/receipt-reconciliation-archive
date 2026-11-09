'use strict';

/**
 * Sprint 2 HTTP surface test — wires the full Sprint-1 + Sprint-2 stack
 * into an Express app, then drives the stage pipeline via fetch requests.
 *
 * Covers:
 *   - /imports/received-receipt and /imports/daily-receipt
 *   - /stages/tour-match, /stages/bill-match, /stages/merge, /stages/second-pass
 *   - /exports/monthly-data, /exports/files, /exports/files/:filename
 *   - /pending-reviews, /pending-reviews/:id/resolve
 *   - /daily-receipts filtered listing
 *   - /bill-match-logs, /monthly-data, /received-receipts listings
 *   - /overview surfaces Sprint 2 counts
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const ExcelJS = require('exceljs');

const { openMonthlyDatabase } = require('../lib/storage/monthly_database');
const { createMonthlyWorkspaceRepository } = require('../repositories/monthly_workspace_repository');
const { createGroupCodeRepository } = require('../repositories/group_code_repository');
const { createStoreBillRepository } = require('../repositories/store_bill_repository');
const { createMissingReceiptRepository } = require('../repositories/missing_receipt_repository');
const { createErrorRecordRepository } = require('../repositories/error_record_repository');
const { createImportJobRepository } = require('../repositories/import_job_repository');
const { createDepartureSyncAuditRepository } = require('../repositories/departure_sync_audit_repository');
const { createReceivedReceiptRepository } = require('../repositories/received_receipt_repository');
const { createDailyReceiptRepository } = require('../repositories/daily_receipt_repository');
const { createBillMatchLogRepository } = require('../repositories/bill_match_log_repository');
const { createPendingReviewRepository } = require('../repositories/pending_review_repository');
const { createMonthlyDataRepository } = require('../repositories/monthly_data_repository');
const { createMonthlyWorkspaceService } = require('../services/monthly/workspace_service');
const { createImportService } = require('../services/monthly/import_service');
const { createErrorDetectionService } = require('../services/monthly/error_detection_service');
const { createCrossCheckService } = require('../services/monthly/cross_check_service');
const { createTourMatchService } = require('../services/monthly/tour_match_service');
const { createBillMatchService } = require('../services/monthly/bill_match_service');
const { createMergeService } = require('../services/monthly/merge_service');
const { createSecondPassMissingService } = require('../services/monthly/second_pass_missing_service');
const { createMonthlyExportService } = require('../services/monthly/monthly_export_service');
const { createMonthlyReconciliationService } = require('../services/monthly/reconciliation_service');
const { createMonthlyRoutes } = require('../routes/monthly_routes');
const { normalizeMode } = require('../lib/monthly_pipeline/mode_normalizer');
const { classifyModeFolder } = require('../lib/monthly_pipeline/mode_folder_classifier');
const { FIELD_ALIASES: BILL_FIELD_ALIASES } = require('../lib/monthly_pipeline/bill_mapper');

const WORKSPACE_KEY = '2026-01';

function createTestAuth() {
  return {
    authenticateToken(req, _res, next) {
      req.user = {
        username: req.headers['x-test-user'] || 'reviewer',
        role: req.headers['x-test-role'] || 'reviewer',
      };
      next();
    },
    requireRole(...roles) {
      return (req, res, next) => {
        if (roles.includes(req.user?.role)) return next();
        return res.status(403).json({ error: 'forbidden' });
      };
    },
  };
}

async function setup(t, { auth = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sprint2-routes-'));
  const db = openMonthlyDatabase({ dbPath: path.join(dir, 'monthly.sqlite') });

  const workspaceRepo = createMonthlyWorkspaceRepository({ db });
  const groupCodeRepo = createGroupCodeRepository({ db });
  const storeBillRepo = createStoreBillRepository({ db });
  const missingReceiptRepo = createMissingReceiptRepository({ db });
  const errorRecordRepo = createErrorRecordRepository({ db });
  const importJobRepo = createImportJobRepository({ db });
  const departureSyncAuditRepo = createDepartureSyncAuditRepository({ db });
  const receivedReceiptRepo = createReceivedReceiptRepository({ db });
  const dailyReceiptRepo = createDailyReceiptRepository({ db });
  const billMatchLogRepo = createBillMatchLogRepository({ db });
  const pendingReviewRepo = createPendingReviewRepository({ db });
  const monthlyDataRepo = createMonthlyDataRepository({ db });

  const workspaceService = createMonthlyWorkspaceService({ workspaceRepo });
  workspaceService.open({ workspaceKey: WORKSPACE_KEY, operator: 'test' });

  const importService = createImportService({
    importJobRepo, groupCodeRepo, storeBillRepo, missingReceiptRepo,
    receivedReceiptRepo, dailyReceiptRepo,
  });
  const crossCheckService = createCrossCheckService({
    storeBillRepo, errorRecordRepo, departureSyncAuditRepo,
  });
  const errorDetectionService = createErrorDetectionService({
    storeBillRepo, errorRecordRepo, groupCodeRepo, crossCheckService,
  });
  const tourMatchService = createTourMatchService({
    dailyReceiptRepo, groupCodeRepo, pendingReviewRepo, errorRecordRepo,
  });
  const billMatchService = createBillMatchService({
    storeBillRepo, dailyReceiptRepo, billMatchLogRepo, pendingReviewRepo,
  });
  const mergeService = createMergeService({
    dailyReceiptRepo, billMatchLogRepo, monthlyDataRepo,
  });
  const secondPassMissingService = createSecondPassMissingService({
    dailyReceiptRepo, storeBillRepo, pendingReviewRepo,
  });
  const monthlyExportService = createMonthlyExportService({
    monthlyDataRepo, pendingReviewRepo, db,
  });
  const monthlyReconciliationService = createMonthlyReconciliationService({
    db,
    dailyReceiptRepo,
    storeBillRepo,
    billMatchLogRepo,
    pendingReviewRepo,
    monthlyDataRepo,
  });

  const exportRoot = path.join(dir, 'exports');

  // Minimal upload stub — routes only call upload.single(); they do not
  // need multer's actual file parsing for the stage endpoints.
  const upload = {
    single() {
      return (req, _res, next) => {
        if (req.headers['x-test-upload-path']) {
          req.file = {
            path: req.headers['x-test-upload-path'],
            originalname: req.headers['x-test-upload-name'] || path.basename(req.headers['x-test-upload-path']),
          };
          if (req.headers['x-test-bucket-folder']) {
            req.body = {
              ...(req.body || {}),
              bucketFolder: decodeURIComponent(req.headers['x-test-bucket-folder']),
            };
          }
        } else if (req.headers['x-test-upload'] === '1') {
          const filePath = path.join(dir, 'locked-import.xlsx');
          fs.writeFileSync(filePath, 'locked import should not be parsed');
          req.file = {
            path: filePath,
            originalname: 'locked-import.xlsx',
          };
        }
        next();
      };
    },
  };

  const routes = createMonthlyRoutes({
    workspaceService, importService, errorDetectionService, crossCheckService,
    groupCodeRepo, storeBillRepo, missingReceiptRepo, errorRecordRepo,
    importJobRepo, departureSyncAuditRepo,
    receivedReceiptRepo, dailyReceiptRepo, billMatchLogRepo,
    pendingReviewRepo, monthlyDataRepo,
    tourMatchService, billMatchService, mergeService,
    secondPassMissingService, monthlyExportService,
    monthlyReconciliationService,
    exportRoot, upload,
  });

  const app = express();
  app.use(express.json());
  routes.register(app, auth);

  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  t.after(() => {
    server.close();
    try { db.close?.(); } catch {
      // intentional: best-effort cleanup
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {
      // intentional: best-effort cleanup
    }
  });

  return {
    baseUrl, dir, db,
    repos: {
      groupCodeRepo, storeBillRepo, dailyReceiptRepo,
      billMatchLogRepo, pendingReviewRepo, monthlyDataRepo,
      receivedReceiptRepo, importJobRepo,
    },
  };
}

async function writeWorkbook(filePath, headers, rows, sheetName = 'Sheet1') {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  sheet.addRow(headers);
  for (const row of rows) {
    sheet.addRow(headers.map((header) => row[header] ?? ''));
  }
  await workbook.xlsx.writeFile(filePath);
}

function billHeader(key) {
  return BILL_FIELD_ALIASES[key][0];
}

test('sprint2 routes: tour-match → bill-match → merge → second-pass → export', async (t) => {
  const { baseUrl, repos } = await setup(t);
  const { groupCodeRepo, storeBillRepo, dailyReceiptRepo } = repos;

  groupCodeRepo.insertMany([{
    workspaceKey: WORKSPACE_KEY,
    tourNo: '71993',
    mode: '乐天SG-本司',
    modeNormalized: 'SG',
    agent: '梓陌',
    applyDate: '2026-01-10',
    endDate: '2026-01-20',
    rowHash: 'gc1',
    importedAt: 't',
  }]);
  storeBillRepo.insertMany([{
    workspaceKey: WORKSPACE_KEY, storeFamily: '乐天免税店',
    receiptNo: 'R100', tourNo: '71993',
    name: 'LI MING', passportNo: 'P1', purchaseDate: '2026-01-14',
    isDetailSheet: true, rowHash: 'b1', importedAt: 't',
  }]);
  dailyReceiptRepo.insertMany([
    {
      workspaceKey: WORKSPACE_KEY, receiptNo: 'R100', tourNo: '71993',
      agent: '梓陌', name: 'LI MING', passportNo: 'P1',
      shop: '乐天免税店', purchaseDate: '2026-01-14',
      rowHash: 'd100', importedAt: 't',
    },
    {
      workspaceKey: WORKSPACE_KEY, receiptNo: 'R-MISS', tourNo: '71993',
      agent: '梓陌', name: 'WANG', passportNo: 'P9',
      shop: '乐天免税店', purchaseDate: '2026-01-15',
      rowHash: 'd200', importedAt: 't',
    },
  ]);

  // 1. tour-match
  const tourRes = await fetch(`${baseUrl}/api/monthly/workspaces/${WORKSPACE_KEY}/stages/tour-match`, {
    method: 'POST',
  });
  assert.equal(tourRes.status, 200);
  const tourJson = await tourRes.json();
  assert.equal(tourJson.scanned, 2);
  assert.equal(tourJson.matched, 2);

  // 2. bill-match
  const billRes = await fetch(`${baseUrl}/api/monthly/workspaces/${WORKSPACE_KEY}/stages/bill-match`, {
    method: 'POST',
  });
  assert.equal(billRes.status, 200);
  const billJson = await billRes.json();
  assert.equal(billJson.matched, 1);

  // 3. merge
  const mergeRes = await fetch(`${baseUrl}/api/monthly/workspaces/${WORKSPACE_KEY}/stages/merge`, {
    method: 'POST',
  });
  assert.equal(mergeRes.status, 200);
  const mergeJson = await mergeRes.json();
  assert.equal(mergeJson.inserted, 2);
  assert.equal(mergeJson.matched, 1);
  assert.equal(mergeJson.unmatched, 1);

  // 4. second-pass
  const secondRes = await fetch(`${baseUrl}/api/monthly/workspaces/${WORKSPACE_KEY}/stages/second-pass`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dateWindowDays: 3 }),
  });
  assert.equal(secondRes.status, 200);
  const secondJson = await secondRes.json();
  assert.equal(typeof secondJson.scanned, 'number');

  // 5. export
  const exportRes = await fetch(`${baseUrl}/api/monthly/workspaces/${WORKSPACE_KEY}/exports/monthly-data`, {
    method: 'POST',
  });
  assert.equal(exportRes.status, 200);
  const exportJson = await exportRes.json();
  assert.ok(Array.isArray(exportJson.files));
  assert.ok(exportJson.files.length >= 1, 'at least one export file expected');
  assert.ok(exportJson.files.every((f) => f.filename.endsWith('.xlsx')));

  // 6. list exports
  const filesRes = await fetch(`${baseUrl}/api/monthly/workspaces/${WORKSPACE_KEY}/exports/files`);
  assert.equal(filesRes.status, 200);
  const filesJson = await filesRes.json();
  assert.ok(filesJson.files.length >= 1);

  // 7. download one
  const filename = filesJson.files[0].filename;
  const dlRes = await fetch(
    `${baseUrl}/api/monthly/workspaces/${WORKSPACE_KEY}/exports/files/${encodeURIComponent(filename)}`
  );
  assert.equal(dlRes.status, 200);
  const buf = Buffer.from(await dlRes.arrayBuffer());
  assert.ok(buf.length > 0);
});

test('sprint2 routes: overview surfaces sprint2 counts', async (t) => {
  const { baseUrl, repos } = await setup(t);
  repos.dailyReceiptRepo.insertMany([{
    workspaceKey: WORKSPACE_KEY, receiptNo: 'R1', tourNo: 'T1',
    name: 'A', passportNo: 'P1', rowHash: 'd1', importedAt: 't',
  }]);

  const res = await fetch(`${baseUrl}/api/monthly/workspaces/${WORKSPACE_KEY}/overview`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.counts.dailyReceipts, 1);
  assert.ok(Array.isArray(body.counts.dailyByMatchStatus));
  assert.ok(Array.isArray(body.counts.pendingByReason));
});

test('sprint2 routes: reconciliation endpoint explains monthly counts and details', async (t) => {
  const { baseUrl, repos } = await setup(t);
  const { dailyReceiptRepo, storeBillRepo, billMatchLogRepo, monthlyDataRepo } = repos;
  const now = '2026-05-19T08:00:00.000Z';

  dailyReceiptRepo.insertMany([{
    workspaceKey: WORKSPACE_KEY,
    receiptNo: 'R-TRACE',
    tourNo: '71993',
    name: 'TRACE USER',
    passportNo: 'P-TRACE',
    shop: 'THE SHILLA',
    purchaseDate: '2026-01-14',
    modeFolder: '济州新罗V团',
    sourceFile: '审核台导入.xlsx',
    sourceSheet: '收票',
    sourceRow: 2,
    rowHash: 'route-trace-daily-1',
    importedAt: now,
    ledgerStatus: 'posted',
    sourceType: 'workbench',
    modifiedBy: 'reviewer',
  }]);
  storeBillRepo.insertMany([{
    workspaceKey: WORKSPACE_KEY,
    storeFamily: 'THE SHILLA',
    receiptNo: 'R-TRACE',
    tourNo: '71993',
    name: 'TRACE USER',
    passportNo: 'P-TRACE',
    purchaseDate: '2026-01-14',
    isDetailSheet: true,
    sourceFile: '店铺账单.xlsx',
    sourceSheet: '明细',
    sourceRow: 8,
    rowHash: 'route-trace-bill-1',
    importedAt: now,
  }]);
  const daily = dailyReceiptRepo._listAll({ workspaceKey: WORKSPACE_KEY })[0];
  const bill = storeBillRepo.list({ workspaceKey: WORKSPACE_KEY, limit: 5 })[0];
  billMatchLogRepo.insertMany([{
    workspaceKey: WORKSPACE_KEY,
    dailyReceiptId: daily.id,
    storeBillId: bill.id,
    matchPriority: 1,
    matchKey: '小票号=R-TRACE',
    matchStatus: 'matched',
    matchedAt: now,
  }]);
  monthlyDataRepo.insertMany([{
    workspaceKey: WORKSPACE_KEY,
    modeFolder: '济州新罗V团',
    isUnmatched: false,
    dailyReceiptId: daily.id,
    storeBillId: bill.id,
    receiptNo: 'R-TRACE',
    name: 'TRACE USER',
    passportNo: 'P-TRACE',
    tourNo: '71993',
    shop: 'THE SHILLA',
    purchaseDate: '2026-01-14',
    rowHash: 'route-trace-monthly-1',
    createdAt: now,
  }]);

  const res = await fetch(`${baseUrl}/api/monthly/workspaces/${WORKSPACE_KEY}/reconciliation`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.metrics.find((item) => item.id === 'storeBills').value, 1);
  assert.equal(body.formulas.find((item) => item.id === 'billClosure').balanced, true);
  assert.equal(
    body.detailSections.monthlyMatched.rows[0].trace.dailySource.file,
    '审核台导入.xlsx'
  );
  assert.equal(
    body.detailSections.monthlyMatched.rows[0].trace.billSource.row,
    8
  );
});

test('sprint2 routes: stage buttons are blocked until previous monthly step is complete', async (t) => {
  const { baseUrl, repos } = await setup(t);

  const billMatchBeforeBill = await fetch(
    `${baseUrl}/api/monthly/workspaces/${WORKSPACE_KEY}/stages/bill-match`,
    { method: 'POST' }
  );
  assert.equal(billMatchBeforeBill.status, 409);
  assert.match((await billMatchBeforeBill.json()).error, /先导入店铺账单/);

  repos.storeBillRepo.insertMany([{
    workspaceKey: WORKSPACE_KEY,
    storeFamily: 'THE SHILLA',
    receiptNo: '0326163500001',
    name: 'NO MATCH YET',
    purchaseDate: '2026-01-15',
    isDetailSheet: true,
    rowHash: 'route-stage-lock-bill-1',
    importedAt: '2026-01-15T00:00:00.000Z',
  }]);

  const mergeBeforeMatch = await fetch(
    `${baseUrl}/api/monthly/workspaces/${WORKSPACE_KEY}/stages/merge`,
    { method: 'POST' }
  );
  assert.equal(mergeBeforeMatch.status, 409);
  assert.match((await mergeBeforeMatch.json()).error, /先运行账单匹配/);

  const exportBeforeMerge = await fetch(
    `${baseUrl}/api/monthly/workspaces/${WORKSPACE_KEY}/exports/monthly-data`,
    { method: 'POST' }
  );
  assert.equal(exportBeforeMerge.status, 409);
  assert.match((await exportBeforeMerge.json()).error, /先完成合并月度数据/);
});

test('sprint2 routes: mode update persists mode fields without ledger status transition', async (t) => {
  const { baseUrl, repos } = await setup(t);
  const { dailyReceiptRepo } = repos;
  const modeRaw = '\u6d4e\u5dde\u65b0\u7f57V\u56e2-\u8559\u65b0';

  dailyReceiptRepo.insertMany([{
    workspaceKey: WORKSPACE_KEY,
    receiptNo: 'R-MODE',
    tourNo: 'T-MODE',
    name: 'MODE ROW',
    passportNo: 'P-MODE',
    rowHash: 'mode-update-1',
    importedAt: '2026-01-02T00:00:00.000Z',
    sourceType: 'workbench',
    ledgerStatus: 'remedy',
    remedyReason: 'mode_not_found',
  }]);
  const row = dailyReceiptRepo._listAll({ workspaceKey: WORKSPACE_KEY })[0];

  const res = await fetch(
    `${baseUrl}/api/monthly/workspaces/${WORKSPACE_KEY}/ledger/${row.id}/fields`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modeRaw, ledgerStatus: 'ready_to_post' }),
    }
  );

  assert.equal(res.status, 200);
  const updated = dailyReceiptRepo._fetchFullById({ workspaceKey: WORKSPACE_KEY, id: row.id });
  assert.equal(updated.modeRaw, modeRaw);
  assert.equal(updated.modeNormalized, normalizeMode(modeRaw).code);
  assert.equal(updated.modeFolder, classifyModeFolder({ modeRaw }));
  assert.equal(updated.ledgerStatus, 'remedy');
  assert.equal(updated.remedyReason, 'mode_not_found');
});

test('sprint2 routes: field update records date window status without ledger transition', async (t) => {
  const { baseUrl, repos } = await setup(t);
  const { dailyReceiptRepo, groupCodeRepo } = repos;
  const modeRaw = '\u6d4e\u5dde\u65b0\u7f57V\u56e2-\u8559\u65b0';

  groupCodeRepo.insertMany([{
    workspaceKey: WORKSPACE_KEY,
    tourNo: 'T-DATE',
    mode: modeRaw,
    modeNormalized: normalizeMode(modeRaw).code,
    agent: 'AGENT',
    applyDate: '2026-01-01',
    endDate: '2026-01-31',
    rowHash: 'date-window-gc-1',
    importedAt: '2026-01-01T00:00:00.000Z',
  }]);
  dailyReceiptRepo.insertMany([{
    workspaceKey: WORKSPACE_KEY,
    receiptNo: 'R-DATE',
    tourNo: 'T-DATE',
    agent: 'AGENT',
    name: 'DATE ROW',
    passportNo: 'P-DATE',
    purchaseDate: '2026-01-15',
    modeRaw,
    modeNormalized: normalizeMode(modeRaw).code,
    modeFolder: classifyModeFolder({ modeRaw }),
    rowHash: 'date-window-row-1',
    importedAt: '2026-01-15T00:00:00.000Z',
    sourceType: 'workbench',
    tourMatchStatus: 'matched',
    ledgerStatus: 'ready_to_post',
  }]);
  const row = dailyReceiptRepo._listAll({ workspaceKey: WORKSPACE_KEY })[0];

  const res = await fetch(
    `${baseUrl}/api/monthly/workspaces/${WORKSPACE_KEY}/ledger/${row.id}/fields`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ purchaseDate: '2035-12-31', ledgerStatus: 'ready_to_post' }),
    }
  );

  assert.equal(res.status, 200);
  const updated = dailyReceiptRepo._fetchFullById({ workspaceKey: WORKSPACE_KEY, id: row.id });
  assert.equal(updated.purchaseDate, '2035-12-31');
  assert.equal(updated.tourMatchStatus, 'date_out_of_window');
  assert.equal(updated.ledgerStatus, 'ready_to_post');
  assert.equal(updated.remedyReason, null);
});

test('sprint2 routes: manual remedy confirmation can override date window status only', async (t) => {
  const { baseUrl, repos } = await setup(t);
  const { dailyReceiptRepo, groupCodeRepo } = repos;
  const modeRaw = '\u6d4e\u5dde\u65b0\u7f57V\u56e2-\u8559\u65b0';

  groupCodeRepo.insertMany([{
    workspaceKey: WORKSPACE_KEY,
    tourNo: 'T-REMEDY-DATE',
    mode: modeRaw,
    modeNormalized: normalizeMode(modeRaw).code,
    agent: 'AGENT',
    applyDate: '2026-01-01',
    endDate: '2026-01-31',
    rowHash: 'date-window-remedy-gc-1',
    importedAt: '2026-01-01T00:00:00.000Z',
  }]);
  dailyReceiptRepo.insertMany([{
    workspaceKey: WORKSPACE_KEY,
    receiptNo: 'R-REMEDY-DATE',
    tourNo: 'T-REMEDY-DATE',
    agent: 'AGENT',
    name: 'DATE REMEDY ROW',
    passportNo: 'P-REMEDY-DATE',
    purchaseDate: '2035-12-31',
    rowHash: 'date-window-remedy-row-1',
    importedAt: '2026-01-15T00:00:00.000Z',
    sourceType: 'workbench',
    tourMatchStatus: 'date_out_of_window',
    ledgerStatus: 'remedy',
    remedyReason: 'tour_match_unresolved',
  }]);
  const row = dailyReceiptRepo._listAll({ workspaceKey: WORKSPACE_KEY })[0];

  const res = await fetch(
    `${baseUrl}/api/monthly/workspaces/${WORKSPACE_KEY}/ledger/${row.id}/fields`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        modeRaw,
        ledgerStatus: 'ready_to_post',
        remedyReason: null,
        manualRemedyConfirm: true,
      }),
    }
  );

  assert.equal(res.status, 200);
  const updated = dailyReceiptRepo._fetchFullById({ workspaceKey: WORKSPACE_KEY, id: row.id });
  assert.equal(updated.modeRaw, modeRaw);
  assert.equal(updated.modeFolder, classifyModeFolder({ modeRaw }));
  assert.equal(updated.tourMatchStatus, 'matched');
  assert.equal(updated.ledgerStatus, 'remedy');
  assert.equal(updated.remedyReason, 'tour_match_unresolved');
});

test('sprint2 routes: delete ledger row removes unclear receipt from queue', async (t) => {
  const { baseUrl, repos } = await setup(t);
  const { dailyReceiptRepo } = repos;

  dailyReceiptRepo.insertMany([{
    workspaceKey: WORKSPACE_KEY,
    receiptNo: 'R-DELETE',
    tourNo: 'T-DELETE',
    name: 'DELETE ROW',
    passportNo: 'P-DELETE',
    rowHash: 'delete-ledger-1',
    importedAt: '2026-01-03T00:00:00.000Z',
    sourceType: 'workbench',
    ledgerStatus: 'remedy',
    remedyReason: 'image_unclear',
  }]);
  const row = dailyReceiptRepo._listAll({ workspaceKey: WORKSPACE_KEY })[0];

  const res = await fetch(
    `${baseUrl}/api/monthly/workspaces/${WORKSPACE_KEY}/ledger/${row.id}`,
    { method: 'DELETE' }
  );

  assert.equal(res.status, 200);
  assert.equal(dailyReceiptRepo._fetchFullById({ workspaceKey: WORKSPACE_KEY, id: row.id }), null);
});

test('sprint2 routes: reviewer can delete only own unposted workbench ledger rows', async (t) => {
  const { baseUrl, repos } = await setup(t, { auth: createTestAuth() });
  const { dailyReceiptRepo } = repos;

  dailyReceiptRepo.insertMany([
    {
      workspaceKey: WORKSPACE_KEY,
      receiptNo: 'R-OWN',
      tourNo: 'T-OWN',
      name: 'OWN ROW',
      passportNo: 'P-OWN',
      rowHash: 'delete-own-1',
      importedAt: '2026-01-03T00:00:00.000Z',
      sourceType: 'workbench',
      modifiedBy: 'alice',
      ledgerStatus: 'remedy',
      remedyReason: 'image_unclear',
    },
    {
      workspaceKey: WORKSPACE_KEY,
      receiptNo: 'R-OTHER',
      tourNo: 'T-OTHER',
      name: 'OTHER ROW',
      passportNo: 'P-OTHER',
      rowHash: 'delete-other-1',
      importedAt: '2026-01-03T00:00:00.000Z',
      sourceType: 'workbench',
      modifiedBy: 'bob',
      ledgerStatus: 'remedy',
      remedyReason: 'image_unclear',
    },
    {
      workspaceKey: WORKSPACE_KEY,
      receiptNo: 'R-POSTED',
      tourNo: 'T-POSTED',
      name: 'POSTED ROW',
      passportNo: 'P-POSTED',
      rowHash: 'delete-posted-1',
      importedAt: '2026-01-03T00:00:00.000Z',
      sourceType: 'workbench',
      modifiedBy: 'alice',
      ledgerStatus: 'posted',
    },
    {
      workspaceKey: WORKSPACE_KEY,
      receiptNo: 'R-IMPORTED',
      tourNo: 'T-IMPORTED',
      name: 'IMPORTED ROW',
      passportNo: 'P-IMPORTED',
      rowHash: 'delete-imported-1',
      importedAt: '2026-01-03T00:00:00.000Z',
      sourceType: 'imported',
      modifiedBy: 'alice',
      ledgerStatus: 'in_review',
    },
  ]);

  const rows = dailyReceiptRepo._listAll({ workspaceKey: WORKSPACE_KEY });
  const byReceipt = Object.fromEntries(rows.map((row) => [row.receiptNo, row]));

  const otherRes = await fetch(
    `${baseUrl}/api/monthly/workspaces/${WORKSPACE_KEY}/ledger/${byReceipt['R-OTHER'].id}`,
    { method: 'DELETE', headers: { 'x-test-user': 'alice', 'x-test-role': 'reviewer' } }
  );
  assert.equal(otherRes.status, 403);

  const postedRes = await fetch(
    `${baseUrl}/api/monthly/workspaces/${WORKSPACE_KEY}/ledger/${byReceipt['R-POSTED'].id}`,
    { method: 'DELETE', headers: { 'x-test-user': 'alice', 'x-test-role': 'reviewer' } }
  );
  assert.equal(postedRes.status, 200);

  const importedRes = await fetch(
    `${baseUrl}/api/monthly/workspaces/${WORKSPACE_KEY}/ledger/${byReceipt['R-IMPORTED'].id}`,
    { method: 'DELETE', headers: { 'x-test-user': 'alice', 'x-test-role': 'reviewer' } }
  );
  assert.equal(importedRes.status, 403);

  const ownRes = await fetch(
    `${baseUrl}/api/monthly/workspaces/${WORKSPACE_KEY}/ledger/${byReceipt['R-OWN'].id}`,
    { method: 'DELETE', headers: { 'x-test-user': 'alice', 'x-test-role': 'reviewer' } }
  );
  assert.equal(ownRes.status, 200);
  assert.equal(dailyReceiptRepo._fetchFullById({ workspaceKey: WORKSPACE_KEY, id: byReceipt['R-OWN'].id }), null);
  assert.notEqual(dailyReceiptRepo._fetchFullById({ workspaceKey: WORKSPACE_KEY, id: byReceipt['R-OTHER'].id }), null);
});

test('sprint2 routes: reviewer ledger listing is scoped to own rows while finance can see all', async (t) => {
  const { baseUrl, repos } = await setup(t, { auth: createTestAuth() });
  const { dailyReceiptRepo } = repos;

  dailyReceiptRepo.insertMany([
    {
      workspaceKey: WORKSPACE_KEY,
      receiptNo: 'R-ALICE-1',
      tourNo: 'T-OWN',
      name: 'ALICE ROW',
      passportNo: 'P-OWN',
      rowHash: 'ledger-scope-alice-1',
      importedAt: '2026-01-03T00:00:00.000Z',
      sourceType: 'workbench',
      modifiedBy: 'alice',
      ledgerStatus: 'ready_to_post',
    },
    {
      workspaceKey: WORKSPACE_KEY,
      receiptNo: 'R-BOB-1',
      tourNo: 'T-OTHER',
      name: 'BOB ROW',
      passportNo: 'P-OTHER',
      rowHash: 'ledger-scope-bob-1',
      importedAt: '2026-01-03T00:00:00.000Z',
      sourceType: 'workbench',
      modifiedBy: 'bob',
      ledgerStatus: 'remedy',
      remedyReason: 'tour_match_unresolved',
    },
  ]);

  const reviewerRes = await fetch(
    `${baseUrl}/api/monthly/workspaces/${WORKSPACE_KEY}/ledger?limit=50`,
    { headers: { 'x-test-user': 'alice', 'x-test-role': 'reviewer' } }
  );
  assert.equal(reviewerRes.status, 200);
  const reviewerBody = await reviewerRes.json();
  assert.equal(reviewerBody.total, 1);
  assert.deepEqual(reviewerBody.rows.map((row) => row.receiptNo), ['R-ALICE-1']);

  const countRes = await fetch(
    `${baseUrl}/api/monthly/workspaces/${WORKSPACE_KEY}/ledger/status-counts`,
    { headers: { 'x-test-user': 'alice', 'x-test-role': 'reviewer' } }
  );
  assert.equal(countRes.status, 200);
  const countBody = await countRes.json();
  assert.equal(countBody.counts.reduce((sum, row) => sum + Number(row.n || 0), 0), 1);

  const financeRes = await fetch(
    `${baseUrl}/api/monthly/workspaces/${WORKSPACE_KEY}/ledger?limit=50`,
    { headers: { 'x-test-user': 'finance', 'x-test-role': 'finance' } }
  );
  assert.equal(financeRes.status, 200);
  const financeBody = await financeRes.json();
  assert.equal(financeBody.total, 2);
  assert.deepEqual(
    financeBody.rows.map((row) => row.receiptNo).sort(),
    ['R-ALICE-1', 'R-BOB-1']
  );
});

test('sprint2 routes: admin can delete any unposted unlocked ledger row', async (t) => {
  const { baseUrl, repos } = await setup(t, { auth: createTestAuth() });
  const { dailyReceiptRepo } = repos;

  dailyReceiptRepo.insertMany([{
    workspaceKey: WORKSPACE_KEY,
    receiptNo: 'R-ADMIN-DELETE',
    tourNo: 'T-ADMIN-DELETE',
    name: 'ADMIN DELETE ROW',
    passportNo: 'P-ADMIN-DELETE',
    rowHash: 'delete-admin-1',
    importedAt: '2026-01-03T00:00:00.000Z',
    sourceType: 'imported',
    ledgerStatus: 'in_review',
  }]);
  const row = dailyReceiptRepo._listAll({ workspaceKey: WORKSPACE_KEY })[0];

  const res = await fetch(
    `${baseUrl}/api/monthly/workspaces/${WORKSPACE_KEY}/ledger/${row.id}`,
    { method: 'DELETE', headers: { 'x-test-user': 'admin', 'x-test-role': 'admin' } }
  );

  assert.equal(res.status, 200);
  assert.equal(dailyReceiptRepo._fetchFullById({ workspaceKey: WORKSPACE_KEY, id: row.id }), null);
});

test('sprint2 routes: lock and publish endpoints are removed', async (t) => {
  const { baseUrl, repos } = await setup(t);
  const { dailyReceiptRepo } = repos;

  dailyReceiptRepo.insertMany([
    {
      workspaceKey: WORKSPACE_KEY,
      receiptNo: 'R-POSTED',
      tourNo: 'T-POSTED',
      name: 'POSTED ROW',
      passportNo: 'P-POSTED',
      rowHash: 'lock-posted-1',
      importedAt: '2026-01-04T00:00:00.000Z',
      sourceType: 'workbench',
      ledgerStatus: 'posted',
    },
    {
      workspaceKey: WORKSPACE_KEY,
      receiptNo: 'R-REMEDY',
      tourNo: 'T-REMEDY',
      name: 'REMEDY ROW',
      passportNo: 'P-REMEDY',
      rowHash: 'lock-remedy-1',
      importedAt: '2026-01-04T00:00:00.000Z',
      sourceType: 'workbench',
      ledgerStatus: 'remedy',
      remedyReason: 'field_unconfirmed',
    },
  ]);

  const res = await fetch(`${baseUrl}/api/monthly/workspaces/${WORKSPACE_KEY}/lock`, { method: 'POST' });
  assert.equal(res.status, 410);

  const rows = dailyReceiptRepo._listAll({ workspaceKey: WORKSPACE_KEY });
  const postedRow = rows.find((row) => row.receiptNo === 'R-POSTED');
  assert.equal(postedRow.ledgerStatus, 'posted');

  const publishRes = await fetch(
    `${baseUrl}/api/monthly/workspaces/${WORKSPACE_KEY}/ledger/publish`,
    { method: 'POST' }
  );
  assert.equal(publishRes.status, 410);

  const patchRes = await fetch(
    `${baseUrl}/api/monthly/workspaces/${WORKSPACE_KEY}/ledger/${postedRow.id}/fields`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ledgerStatus: 'ready_to_post' }),
    }
  );
  assert.equal(patchRes.status, 200);

  assert.equal(dailyReceiptRepo._fetchFullById({ workspaceKey: WORKSPACE_KEY, id: postedRow.id }).ledgerStatus, 'posted');
});

// 异步导入:上传只返回 {job:{id,status:'running'}},轮询 import-jobs/:id 直到非 running。
async function pollImportJob(baseUrl, jobId, { timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(
      `${baseUrl}/api/monthly/workspaces/${WORKSPACE_KEY}/import-jobs/${jobId}`
    );
    if (res.status === 200) {
      const { job } = await res.json();
      if (job && job.status && job.status !== 'running') return job;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`import job ${jobId} did not finish within ${timeoutMs}ms`);
}

test('sprint2 routes: repeated HTTP store-bill upload dedupes by original filename, not multer temp path', async (t) => {
  const { baseUrl, dir, repos } = await setup(t);
  const firstPath = path.join(dir, 'multer-temp-a.xlsx');
  const secondPath = path.join(dir, 'multer-temp-b.xlsx');
  const originalName = 'same-store-bill.xlsx';

  const headers = [
    billHeader('mode'),
    billHeader('storeFamily'),
    billHeader('storeBranch'),
    billHeader('tourNo'),
    billHeader('purchaseDate'),
    billHeader('departureDate'),
    billHeader('name'),
    billHeader('passportNo'),
    billHeader('receiptNo'),
    billHeader('netKrw'),
  ];
  await writeWorkbook(firstPath, headers, [
    {
      [billHeader('mode')]: 'SG',
      [billHeader('storeFamily')]: 'LOTTE',
      [billHeader('storeBranch')]: 'SEOUL',
      [billHeader('tourNo')]: 'T-HTTP',
      [billHeader('purchaseDate')]: '2026-01-12',
      [billHeader('departureDate')]: '2026-01-20',
      [billHeader('name')]: 'HAN TEST',
      [billHeader('passportNo')]: 'PHTTP001',
      [billHeader('receiptNo')]: 'RHTTP001',
      [billHeader('netKrw')]: 124300,
    },
    {
      [billHeader('mode')]: 'SG',
      [billHeader('storeFamily')]: 'LOTTE',
      [billHeader('storeBranch')]: 'SEOUL',
      [billHeader('tourNo')]: 'T-HTTP',
      [billHeader('purchaseDate')]: '2026-01-13',
      [billHeader('departureDate')]: '2026-01-20',
      [billHeader('name')]: 'KIM TEST',
      [billHeader('passportNo')]: 'PHTTP002',
      [billHeader('receiptNo')]: 'RHTTP002',
      [billHeader('netKrw')]: 225000,
    },
  ]);
  fs.copyFileSync(firstPath, secondPath);

  async function upload(filePath) {
    const res = await fetch(
      `${baseUrl}/api/monthly/workspaces/${WORKSPACE_KEY}/imports/store-bill`,
      {
        method: 'POST',
        headers: {
          'x-test-upload-path': filePath,
          'x-test-upload-name': originalName,
        },
      }
    );
    assert.equal(res.status, 200);
    const { job } = await res.json();
    // 异步导入:轮询 import-jobs/:id 直到 done,返回最终 job
    return pollImportJob(baseUrl, job.id);
  }

  const firstJob = await upload(firstPath);
  const secondJob = await upload(secondPath);

  assert.equal(firstJob.sourceFile, originalName);
  assert.equal(secondJob.sourceFile, originalName);
  assert.equal(firstJob.rowsInserted, 2);
  assert.equal(secondJob.rowsInserted, 0);
  assert.equal(secondJob.rowsSkipped, 2);
  assert.equal(repos.storeBillRepo.countByWorkspace(WORKSPACE_KEY), 2);
});

test('sprint2 routes: store-bill upload records the UI-selected bucket folder', async (t) => {
  const { baseUrl, dir, repos } = await setup(t);
  const filePath = path.join(dir, 'neutral-store-bill.xlsx');
  const originalName = 'generic-upload.xlsx';

  const headers = [
    billHeader('mode'),
    billHeader('storeFamily'),
    billHeader('storeBranch'),
    billHeader('tourNo'),
    billHeader('purchaseDate'),
    billHeader('departureDate'),
    billHeader('name'),
    billHeader('passportNo'),
    billHeader('receiptNo'),
    billHeader('netKrw'),
  ];
  await writeWorkbook(filePath, headers, [{
    [billHeader('mode')]: '',
    [billHeader('storeFamily')]: '',
    [billHeader('storeBranch')]: '',
    [billHeader('tourNo')]: 'T-BUCKET',
    [billHeader('purchaseDate')]: '2026-01-12',
    [billHeader('departureDate')]: '2026-01-20',
    [billHeader('name')]: 'PARK BUCKET',
    [billHeader('passportNo')]: 'PBUCKET001',
    [billHeader('receiptNo')]: 'RBUCKET001',
    [billHeader('netKrw')]: 300000,
  }]);

  const res = await fetch(
    `${baseUrl}/api/monthly/workspaces/${WORKSPACE_KEY}/imports/store-bill`,
    {
      method: 'POST',
      headers: {
        'x-test-upload-path': filePath,
        'x-test-upload-name': originalName,
        'x-test-bucket-folder': encodeURIComponent('爱宝客'),
      },
    }
  );

  assert.equal(res.status, 200);
  // 异步导入:响应只回 running job(id);bucketFolder 在建 job 时已落库,查 job 记录验证。
  const job = (await res.json()).job;
  assert.equal(job.status, 'running');
  const finalJob = await pollImportJob(baseUrl, job.id);
  assert.equal(finalJob.bucketFolder, '爱宝客');
  assert.equal(repos.importJobRepo.findById(job.id).bucketFolder, '爱宝客');
});

test('sprint2 routes: daily-receipts / bill-match-logs / pending-reviews listings', async (t) => {
  const { baseUrl, repos } = await setup(t);
  repos.dailyReceiptRepo.insertMany([{
    workspaceKey: WORKSPACE_KEY, receiptNo: 'R10', tourNo: 'T',
    name: 'N', passportNo: 'P', rowHash: 'd10', importedAt: 't',
    billMatchStatus: 'unmatched',
  }]);
  repos.pendingReviewRepo.insertMany([{
    workspaceKey: WORKSPACE_KEY, sourceTable: 'daily_receipt_export',
    sourceId: 1, reasonType: 'second_pass', detail: { note: 'x' },
    status: 'open', createdAt: 't',
  }, {
    workspaceKey: WORKSPACE_KEY, sourceTable: 'store_bill',
    sourceId: 2, reasonType: 'fuzzy_match', detail: { candidateIds: [1] },
    status: 'open', createdAt: 't',
  }]);

  const dailyRes = await fetch(
    `${baseUrl}/api/monthly/workspaces/${WORKSPACE_KEY}/daily-receipts?billMatchStatus=unmatched&limit=10`
  );
  assert.equal(dailyRes.status, 200);
  const dailyJson = await dailyRes.json();
  assert.equal(dailyJson.total, 1);
  assert.equal(dailyJson.rows[0].receiptNo, 'R10');

  const logsRes = await fetch(
    `${baseUrl}/api/monthly/workspaces/${WORKSPACE_KEY}/bill-match-logs`
  );
  assert.equal(logsRes.status, 200);
  const logsJson = await logsRes.json();
  assert.ok(Array.isArray(logsJson.rows));

  const pendingRes = await fetch(
    `${baseUrl}/api/monthly/workspaces/${WORKSPACE_KEY}/pending-reviews`
  );
  assert.equal(pendingRes.status, 200);
  const pendingJson = await pendingRes.json();
  assert.equal(pendingJson.rows.length, 2);
  assert.equal(pendingJson.total, 2);
  const pendingId = pendingJson.rows.find((row) => row.reasonType === 'second_pass').id;

  const fuzzyRes = await fetch(
    `${baseUrl}/api/monthly/workspaces/${WORKSPACE_KEY}/pending-reviews?status=open&reasonType=fuzzy_match&limit=1`
  );
  assert.equal(fuzzyRes.status, 200);
  const fuzzyJson = await fuzzyRes.json();
  assert.equal(fuzzyJson.total, 1);
  assert.equal(fuzzyJson.rows.length, 1);
  assert.equal(fuzzyJson.rows[0].reasonType, 'fuzzy_match');

  // Resolve
  const resolveRes = await fetch(
    `${baseUrl}/api/monthly/workspaces/${WORKSPACE_KEY}/pending-reviews/${pendingId}/resolve`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'resolved', resolution: 'ok' }),
    }
  );
  assert.equal(resolveRes.status, 200);
  assert.deepEqual((await resolveRes.json()).ok, true);

  // After resolve, open count = 0
  const after = await fetch(
    `${baseUrl}/api/monthly/workspaces/${WORKSPACE_KEY}/pending-reviews?status=open&reasonType=second_pass`
  );
  assert.equal((await after.json()).rows.length, 0);
});
