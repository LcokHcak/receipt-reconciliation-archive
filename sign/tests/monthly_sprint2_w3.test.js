'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const ExcelJS = require('exceljs');

const { openMonthlyDatabase } = require('../lib/storage/monthly_database');
const { createImportJobRepository } = require('../repositories/import_job_repository');
const { createGroupCodeRepository } = require('../repositories/group_code_repository');
const { createStoreBillRepository } = require('../repositories/store_bill_repository');
const { createMissingReceiptRepository } = require('../repositories/missing_receipt_repository');
const { createDailyReceiptRepository } = require('../repositories/daily_receipt_repository');
const { createMonthlyDataRepository } = require('../repositories/monthly_data_repository');
const { createBillMatchLogRepository } = require('../repositories/bill_match_log_repository');
const { createPendingReviewRepository } = require('../repositories/pending_review_repository');
const { createCustomerLibraryRepository } = require('../repositories/customer_library_repository');
const { createImportService } = require('../services/monthly/import_service');
const { createMergeService } = require('../services/monthly/merge_service');
const { createMergeStreamingService } = require('../services/monthly/merge_streaming_service');
const { createSecondPassMissingService } = require('../services/monthly/second_pass_missing_service');
const { createMonthlyExportService } = require('../services/monthly/monthly_export_service');
const { createBillMatchService } = require('../services/monthly/bill_match_service');
const { FIELD_ALIASES: DAILY_FIELD_ALIASES } = require('../lib/monthly_pipeline/daily_receipt_mapper');
const { COLORS, FONT } = require('../lib/excel_style');

async function withDb(fn) {
  const tmp = path.join(os.tmpdir(), `sprint2-w3-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  const db = openMonthlyDatabase({ dbPath: tmp });
  try {
    return await fn(db);
  } finally {
    try { db.close?.(); } catch {
      // intentional: best-effort cleanup
    }
    try {
      fs.rmSync(tmp, { force: true });
      fs.rmSync(`${tmp}-wal`, { force: true });
      fs.rmSync(`${tmp}-shm`, { force: true });
    } catch {
      // intentional: best-effort cleanup
    }
  }
}

async function writeWorkbook(filePath, headers, rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('daily');
  sheet.addRow(headers);
  for (const row of rows) {
    sheet.addRow(headers.map((header) => row[header] ?? ''));
  }
  await workbook.xlsx.writeFile(filePath);
}

function dailyHeader(key) {
  return DAILY_FIELD_ALIASES[key][0];
}

test('import_service — stamps daily receipt imports with the operator owner', async () => {
  await withDb(async (db) => {
    const importJobRepo = createImportJobRepository({ db });
    const groupCodeRepo = createGroupCodeRepository({ db });
    const storeBillRepo = createStoreBillRepository({ db });
    const missingReceiptRepo = createMissingReceiptRepository({ db });
    const dailyReceiptRepo = createDailyReceiptRepository({ db });
    const importService = createImportService({
      importJobRepo,
      groupCodeRepo,
      storeBillRepo,
      missingReceiptRepo,
      dailyReceiptRepo,
    });

    const headers = [
      dailyHeader('modeRaw'),
      dailyHeader('shop'),
      dailyHeader('agent'),
      dailyHeader('purchaseDate'),
      dailyHeader('tourNo'),
      dailyHeader('name'),
      dailyHeader('passportNo'),
      dailyHeader('receiptNo'),
    ];
    const filePath = path.join(os.tmpdir(), `daily-owner-${Date.now()}-${Math.random().toString(36).slice(2)}.xlsx`);
    await writeWorkbook(filePath, headers, [{
      [dailyHeader('modeRaw')]: 'SG',
      [dailyHeader('shop')]: 'THE SHILLA',
      [dailyHeader('agent')]: 'Probe Agent',
      [dailyHeader('purchaseDate')]: '2026-01-03',
      [dailyHeader('tourNo')]: 'T202601',
      [dailyHeader('name')]: 'PROBE USER',
      [dailyHeader('passportNo')]: 'P20260101',
      [dailyHeader('receiptNo')]: 'R20260101',
    }]);

    try {
      await importService.importDailyReceipt({
        workspaceKey: '2026-01',
        filePath,
        operator: 'reviewer1',
      });
      const rows = dailyReceiptRepo.listLedger({
        workspaceKey: '2026-01',
        ownerUsername: 'reviewer1',
      });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].modifiedBy, 'reviewer1');
      assert.equal(rows[0].receiptNo, 'R20260101');
    } finally {
      fs.rmSync(filePath, { force: true });
    }
  });
});

test('monthly_export_service pages all pending review rows during process export', async () => {
  await withDb(async (db) => {
    const monthlyDataRepo = createMonthlyDataRepository({ db });
    const pendingRows = [
      {
        id: 1,
        sourceTable: 'store_bill',
        sourceId: 11,
        reasonType: 'field_conflict',
        status: 'open',
        createdAt: '2026-05-11T00:00:00.000Z',
        detail: { page: 1 },
      },
      {
        id: 2,
        sourceTable: 'store_bill',
        sourceId: 12,
        reasonType: 'fuzzy_match',
        status: 'open',
        createdAt: '2026-05-11T00:01:00.000Z',
        detail: { page: 1 },
      },
      {
        id: 3,
        sourceTable: 'daily_receipt_export',
        sourceId: 13,
        reasonType: 'date_out_of_window',
        status: 'open',
        createdAt: '2026-05-11T00:02:00.000Z',
        detail: { page: 2 },
      },
    ];
    const calls = [];
    const pendingReviewRepo = {
      countOpen: () => pendingRows.length,
      list({ limit, offset = 0 }) {
        calls.push({ limit, offset });
        return pendingRows.slice(offset, Math.min(offset + 2, offset + Number(limit)));
      },
    };
    const outDir = path.join(os.tmpdir(), `sprint2-w3-pending-export-${Date.now()}`);
    const svc = createMonthlyExportService({ monthlyDataRepo, pendingReviewRepo, db });

    try {
      const result = await svc.run({ workspaceKey: '2026-01', outputDir: outDir, operator: 'finance1' });
      assert.equal(result.files.length, 1);
      assert.equal(result.files[0].kind, 'pending');
      assert.equal(result.files[0].rows, 3);
      assert.deepEqual(calls.map((c) => c.offset), [0, 2]);

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(result.files[0].path);
      const info = workbook.getWorksheet('生成说明');
      assert.equal(info.getRow(6).getCell(2).value, 3);
      const dataSheet = workbook.worksheets.find((sheet) => sheet.name !== '生成说明');
      assert.equal(dataSheet.actualRowCount, 4);
    } finally {
      try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {
        // intentional: best-effort cleanup
      }
    }
  });
});

test('merge_streaming_service - paginates mode rows beyond the first 100000', async () => {
  const rows = Array.from({ length: 100001 }, (_, i) => ({
    id: i + 1,
    workspaceKey: '2026-01',
    receiptNo: `R${i + 1}`,
    name: 'A',
    passportNo: 'P1',
    modeFolder: '爱宝客',
    ledgerStatus: 'posted',
    billMatchStatus: 'pending_review',
  }));
  let inserted = 0;
  const dailyReceiptRepo = {
    countByMode: () => [{ folder: '爱宝客', count: rows.length }],
    listByMode: ({ limit, offset = 0 }) => rows.slice(offset, offset + limit),
  };
  const monthlyDataRepo = {
    insertMany(batch) {
      inserted += batch.length;
      return { inserted: batch.length, skipped: 0 };
    },
  };
  const svc = createMergeStreamingService({
    dailyReceiptRepo,
    billMatchLogRepo: { list: () => [] },
    monthlyDataRepo,
  });
  const result = await svc.run({ workspaceKey: '2026-01' });
  assert.equal(result.inserted, 100001);
  assert.equal(inserted, 100001);
});

test('merge_service — writes matched bill rows and bill-only rows as unreceived monthly data', async () => {
  await withDb(async (db) => {
    const storeBillRepo = createStoreBillRepository({ db });
    const dailyReceiptRepo = createDailyReceiptRepository({ db });
    const billMatchLogRepo = createBillMatchLogRepository({ db });
    const pendingReviewRepo = createPendingReviewRepository({ db });
    const monthlyDataRepo = createMonthlyDataRepository({ db });

    storeBillRepo.insertMany([{
      workspaceKey: '2026-01', storeFamily: '乐天免税店', storeBranch: '首尔本店',
      receiptNo: 'R1', tourNo: '71993', name: 'A', passportNo: 'P1',
      purchaseDate: '2026-01-14', brand: 'BRAND-A', netUsd: 100,
      isDetailSheet: true, rowHash: 'b1', importedAt: 't',
    }, {
      workspaceKey: '2026-01', storeFamily: '乐天免税店', storeBranch: '釜山',
      receiptNo: 'R-BILL-ONLY', tourNo: '88888888', name: 'BILL ONLY', passportNo: 'PX',
      purchaseDate: '2026-01-15', brand: 'BRAND-MISSING', netUsd: 250,
      sourceFile: '乐天釜山卖出1月-客人账单.xlsx',
      isDetailSheet: true, rowHash: 'b2', importedAt: 't',
    }]);
    dailyReceiptRepo.insertMany([
      {
        workspaceKey: '2026-01', receiptNo: 'R1', tourNo: '71993',
        name: 'A', passportNo: 'P1', shop: '乐天免税店', branch: '首尔本店',
        purchaseDate: '2026-01-14', rowHash: 'd1', importedAt: 't',
      },
      {
        workspaceKey: '2026-01', receiptNo: 'R2', tourNo: '71993',
        name: 'B', passportNo: 'P2', shop: '乐天免税店', branch: '首尔本店',
        purchaseDate: '2026-01-14', rowHash: 'd2', importedAt: 't',
      },
    ]);

    // Assign both to folder 乐天首尔
    const ids = db.prepare(`SELECT id FROM daily_receipt_export WHERE workspace_key = ?`).all('2026-01');
    for (const r of ids) {
      dailyReceiptRepo.updateTourMatch({
        id: r.id, workspaceKey: '2026-01',
        modeFolder: '乐天首尔', tourMatchStatus: 'matched',
      });
    }

    const billMatchSvc = createBillMatchService({
      storeBillRepo, dailyReceiptRepo, billMatchLogRepo, pendingReviewRepo,
    });
    await billMatchSvc.run({ workspaceKey: '2026-01' });

    const merge = createMergeService({ dailyReceiptRepo, billMatchLogRepo, monthlyDataRepo, storeBillRepo });
    const result = await merge.run({ workspaceKey: '2026-01' });

    assert.equal(result.matched, 1);
    assert.equal(result.unreceived, 1);
    assert.equal(result.unmatched, 0);
    assert.equal(result.inserted, 2);

    const byMode = monthlyDataRepo.countByMode('2026-01');
    const matched = byMode.find((x) => x.folder === '乐天首尔' && x.unmatched === 0);
    const unmatched = byMode.find((x) => x.folder === '乐天釜山' && x.unmatched === 1);
    assert.equal(matched.n, 1);
    assert.equal(unmatched.n, 1);

    const matchedRows = monthlyDataRepo.listFiltered({
      workspaceKey: '2026-01', modeFolder: '乐天首尔', isUnmatched: false,
    });
    assert.equal(matchedRows[0].brand, 'BRAND-A');
    assert.equal(matchedRows[0].net_usd, 100);

    const missingRows = monthlyDataRepo.listFiltered({
      workspaceKey: '2026-01', modeFolder: '乐天釜山', isUnmatched: true,
    });
    assert.equal(missingRows[0].receipt_no, 'R-BILL-ONLY');
    assert.equal(missingRows[0].store_bill_id > 0, true);
    assert.equal(missingRows[0].daily_receipt_id, null);
  });
});

test('merge_service — rebuilds monthly data instead of leaving stale rows', async () => {
  await withDb(async (db) => {
    const dailyReceiptRepo = createDailyReceiptRepository({ db });
    const billMatchLogRepo = createBillMatchLogRepository({ db });
    const monthlyDataRepo = createMonthlyDataRepository({ db });

    monthlyDataRepo.insertMany([{
      workspaceKey: '2026-01',
      modeFolder: '爱宝客',
      isUnmatched: true,
      receiptNo: 'STALE-RECEIPT',
      name: 'STALE ROW',
      rowHash: 'stale-monthly-row',
      createdAt: '2026-05-01T00:00:00.000Z',
    }]);
    assert.equal(monthlyDataRepo.countByWorkspace('2026-01'), 1);

    const merge = createMergeService({ dailyReceiptRepo, billMatchLogRepo, monthlyDataRepo });
    const result = await merge.run({ workspaceKey: '2026-01' });

    assert.equal(result.inserted, 0);
    assert.equal(monthlyDataRepo.countByWorkspace('2026-01'), 0);
  });
});

test('monthly_export_service writes customer evidence folders from workbench ledger rows', async () => {
  await withDb(async (db) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'monthly-customer-evidence-'));
    const libraryRoot = path.join(tempRoot, 'customer_library');
    const workspaceKey = '20260514-customer-import';
    const customerId = 'CL20260514-001';
    const billFilename = '\u8d26\u5355-LI MING.xlsx';

    try {
      const customerLibraryRepository = createCustomerLibraryRepository({
        defaultRoot: libraryRoot,
        settingsPath: path.join(tempRoot, 'customer_library.settings.json'),
        nowProvider: () => new Date('2026-05-14T08:00:00.000Z'),
      });
      const customer = customerLibraryRepository.createCustomerFolder({
        workspaceKey,
        customerId,
        agentName: 'Agent A',
        images: [
          { imageId: 'img-passport', relativePath: 'images/passport.jpg', originalFileName: 'passport.jpg' },
          { imageId: 'img-receipt', relativePath: 'images/receipt.jpg', originalFileName: 'receipt.jpg' },
        ],
      });
      const customerDir = customerLibraryRepository.customerDir(workspaceKey, customerId);
      fs.mkdirSync(path.join(customerDir, 'images'), { recursive: true });
      fs.writeFileSync(path.join(customerDir, 'images', 'passport.jpg'), 'passport-image');
      fs.writeFileSync(path.join(customerDir, 'images', 'receipt.jpg'), 'receipt-image');
      fs.mkdirSync(path.join(customerDir, 'template'), { recursive: true });
      fs.writeFileSync(path.join(customerDir, 'template', billFilename), 'bill-workbook');

      customer.status = 'in_review';
      customerLibraryRepository.saveCustomer(customer);
      customer.status = 'approved';
      customer.displayName = 'LI MING';
      customer.passportNumber = 'E12345678';
      customerLibraryRepository.saveCustomer(customer);
      customer.status = 'template_generated';
      customer.folderNameFinal = 'LI MING_E12345678';
      customer.template.finalOutputPath = `template/${billFilename}`;
      customerLibraryRepository.saveCustomer(customer);

      const dailyReceiptRepo = createDailyReceiptRepository({ db });
      const monthlyDataRepo = createMonthlyDataRepository({ db });
      const pendingReviewRepo = createPendingReviewRepository({ db });
      dailyReceiptRepo.insertMany([{
        workspaceKey: '2026-05',
        sourceCustomerId: customerId,
        sourceType: 'workbench',
        sourceBatchId: 'batch_20260514',
        sourceTaskId: 'task_receipt_1',
        receiptDate: '2026-05-14',
        agent: 'Agent A',
        modifiedBy: 'reviewer1',
        purchaseDate: '2026-01-24',
        receiptNo: '0326163500229',
        tourNo: '71993',
        name: 'LI MING',
        passportNo: 'E12345678',
        departureDate: '2026-01-26',
        shop: 'THE SHILLA',
        rowHash: 'daily-workbench-1',
        importedAt: '2026-05-14T09:00:00.000Z',
      }]);

      const outputDir = path.join(tempRoot, 'exports');
      const svc = createMonthlyExportService({
        monthlyDataRepo,
        pendingReviewRepo,
        db,
        customerLibraryRepository,
      });
      const result = await svc.run({ workspaceKey: '2026-05', outputDir });

      const evidenceDir = path.join(outputDir, '\u5ba2\u6237\u8d44\u6599', 'LI MING');
      assert.equal(result.customerEvidence.customerCount, 1);
      assert.equal(result.customerEvidence.imageCount, 2);
      assert.equal(result.customerEvidence.billCount, 1);
      assert.equal(fs.existsSync(path.join(evidenceDir, '\u8d26\u5355.xlsx')), true);
      assert.equal(fs.existsSync(path.join(evidenceDir, '\u53f0\u8d26\u660e\u7ec6.xlsx')), true);
      assert.equal(fs.existsSync(path.join(evidenceDir, '\u56fe\u7247', '001-passport.jpg')), true);
      assert.equal(fs.existsSync(path.join(evidenceDir, '\u56fe\u7247', '002-receipt.jpg')), true);

      // \u7edf\u4e00\u8868\u683c\u6837\u5f0f\u65ad\u8a00(\u4ec5\u89c6\u89c9\u5c42;\u65e2\u6709\u65ad\u8a00\u5168\u90e8\u4fdd\u7559)
      const ledgerWorkbook = new ExcelJS.Workbook();
      await ledgerWorkbook.xlsx.readFile(path.join(evidenceDir, '\u53f0\u8d26\u660e\u7ec6.xlsx'));
      const ledgerSheet = ledgerWorkbook.worksheets[0];
      const ledgerHeaderCell = ledgerSheet.getRow(1).getCell(1);
      assert.equal(ledgerHeaderCell.font.name, '\u5fae\u8f6f\u96c5\u9ed1');
      assert.equal(ledgerHeaderCell.fill.fgColor.argb, 'FF44546A');
      assert.equal(ledgerSheet.views[0].state, 'frozen');
      assert.equal(ledgerSheet.views[0].ySplit, 1);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

test('second_pass_missing_service — promotes matching passport+tour candidate', async () => {
  await withDb(async (db) => {
    const storeBillRepo = createStoreBillRepository({ db });
    const dailyReceiptRepo = createDailyReceiptRepository({ db });
    const pendingReviewRepo = createPendingReviewRepository({ db });

    // Bill has a different receipt number but same passport+tour
    storeBillRepo.insertMany([{
      workspaceKey: '2026-01', storeFamily: '乐天免税店',
      receiptNo: 'BILL_REPRINT', tourNo: '71993',
      name: 'A', passportNo: 'P1',
      purchaseDate: '2026-01-14', isDetailSheet: true, rowHash: 'b9', importedAt: 't',
    }]);
    dailyReceiptRepo.insertMany([{
      workspaceKey: '2026-01', receiptNo: 'R_ORIG', tourNo: '71993',
      name: 'A', passportNo: 'P1', shop: '乐天免税店',
      purchaseDate: '2026-01-14', rowHash: 'd9', importedAt: 't',
    }]);

    const svc = createSecondPassMissingService({ dailyReceiptRepo, storeBillRepo, pendingReviewRepo });
    const result = await svc.run({ workspaceKey: '2026-01' });

    assert.equal(result.scanned, 1);
    assert.equal(result.promotedToReview, 1);
    assert.equal(result.stillMissing, 0);
    assert.equal(pendingReviewRepo.countOpen('2026-01'), 1);

    const reasons = pendingReviewRepo.countByReason('2026-01');
    assert.equal(reasons[0].reason, 'second_pass_candidate');
  });
});

test('second_pass_missing_service — no candidate → still_missing', async () => {
  await withDb(async (db) => {
    const storeBillRepo = createStoreBillRepository({ db });
    const dailyReceiptRepo = createDailyReceiptRepository({ db });
    const pendingReviewRepo = createPendingReviewRepository({ db });

    dailyReceiptRepo.insertMany([{
      workspaceKey: '2026-01', receiptNo: 'LONELY', tourNo: '71111',
      name: 'Z', passportNo: 'PZ', shop: '乐天免税店',
      purchaseDate: '2026-01-14', rowHash: 'dz', importedAt: 't',
    }]);

    const svc = createSecondPassMissingService({ dailyReceiptRepo, storeBillRepo, pendingReviewRepo });
    const result = await svc.run({ workspaceKey: '2026-01' });
    assert.equal(result.scanned, 1);
    assert.equal(result.promotedToReview, 0);
    assert.equal(result.stillMissing, 1);
  });
});

test('monthly_export_service — writes matched data, overall missing, folder missing, and pending xlsx', async () => {
  await withDb(async (db) => {
    const dailyReceiptRepo = createDailyReceiptRepository({ db });
    const storeBillRepo = createStoreBillRepository({ db });
    const billMatchLogRepo = createBillMatchLogRepository({ db });
    const monthlyDataRepo = createMonthlyDataRepository({ db });
    const pendingReviewRepo = createPendingReviewRepository({ db });

    const now = '2026-05-11T00:00:00.000Z';
    dailyReceiptRepo.insertMany([{
      workspaceKey: '2026-01', receiptNo: 'R1', name: 'A', passportNo: 'P1',
      tourNo: '71993', shop: '乐天免税店', purchaseDate: '2026-01-14',
      sourceFile: '审核台导入.xlsx', sourceSheet: '收票', sourceRow: 2,
      rowHash: 'd-export-1', importedAt: now,
    }]);
    storeBillRepo.insertMany([{
      workspaceKey: '2026-01', storeFamily: '乐天免税店', storeBranch: '首尔本店',
      receiptNo: 'R1', name: 'A', passportNo: 'P1', tourNo: '71993',
      purchaseDate: '2026-01-14', isDetailSheet: true,
      sourceFile: '店铺账单.xlsx', sourceSheet: '明细', sourceRow: 9,
      rowHash: 'b-export-1', importedAt: now,
    }, {
      workspaceKey: '2026-01', storeFamily: '乐天免税店', storeBranch: '首尔本店',
      receiptNo: 'R2', name: 'B', passportNo: 'P2', tourNo: '71993',
      purchaseDate: '2026-01-15', isDetailSheet: true,
      sourceFile: '店铺账单.xlsx', sourceSheet: '明细', sourceRow: 10,
      rowHash: 'b-export-2', importedAt: now,
    }]);
    const daily = dailyReceiptRepo._listAll({ workspaceKey: '2026-01' })[0];
    const bills = storeBillRepo.list({ workspaceKey: '2026-01', limit: 10 });
    const matchedBill = bills.find((row) => row.receiptNo === 'R1');
    const missingBill = bills.find((row) => row.receiptNo === 'R2');
    billMatchLogRepo.insertMany([{
      workspaceKey: '2026-01',
      dailyReceiptId: daily.id,
      storeBillId: matchedBill.id,
      matchPriority: 1,
      matchKey: '小票号=R1',
      matchStatus: 'matched',
      matchedAt: now,
    }]);
    monthlyDataRepo.insertMany([
      {
        workspaceKey: '2026-01', modeFolder: '乐天首尔', isUnmatched: false,
        dailyReceiptId: daily.id, storeBillId: matchedBill.id,
        receiptNo: 'R1', name: 'A', passportNo: 'P1', tourNo: '71993',
        shop: '乐天免税店', branch: '首尔本店', agent: '梓陌',
        rowHash: 'm1', createdAt: now,
      },
      {
        workspaceKey: '2026-01', modeFolder: '乐天首尔', isUnmatched: true,
        dailyReceiptId: null, storeBillId: missingBill.id,
        receiptNo: 'R2', name: 'B', passportNo: 'P2', tourNo: '71993',
        shop: '乐天免税店', branch: '首尔本店', agent: '梓陌',
        rowHash: 'm2', createdAt: now,
      },
    ]);
    pendingReviewRepo.insertMany([{
      workspaceKey: '2026-01', sourceTable: 'store_bill', sourceId: 99,
      reasonType: 'field_conflict', detail: { foo: 'bar' },
      status: 'open', createdAt: now,
    }]);

    const outDir = path.join(os.tmpdir(), `sprint2-w3-export-${Date.now()}`);
    const svc = createMonthlyExportService({ monthlyDataRepo, pendingReviewRepo, db });
    const result = await svc.run({ workspaceKey: '2026-01', outputDir: outDir, operator: 'finance1' });

    assert.equal(result.files.length, 4);
    const kinds = result.files.map((f) => f.kind).sort();
    assert.deepEqual(kinds, ['matched', 'missing', 'missing_folder', 'pending']);
    const filenames = result.files.map((f) => path.basename(f.path));
    assert.ok(filenames.includes('2026-01_乐天首尔_未收账单.xlsx'));
    assert.ok(filenames.includes('2026-01_人工确认表.xlsx'));

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(path.join(outDir, '2026-01_乐天首尔_月度数据.xlsx'));
    const info = workbook.getWorksheet('生成说明');
    assert.ok(info, 'export workbook should include a generation summary sheet');
    assert.equal(info.getRow(1).getCell(1).value, '生成说明');
    const infoText = [];
    info.eachRow((row) => infoText.push(row.values.join(' ')));
    assert.match(infoText.join('\n'), /反向追溯字段/);
    assert.match(infoText.join('\n'), /生成人 finance1/);
    assert.match(infoText.join('\n'), /字段口径说明/);

    const dataSheet = workbook.getWorksheet('数据');
    const headers = dataSheet.getRow(1).values;
    assert.ok(headers.includes('系统月度ID'));
    assert.ok(headers.includes('台账ID'));
    assert.ok(headers.includes('账单ID'));
    assert.ok(headers.includes('匹配日志ID'));
    assert.ok(headers.includes('台账来源文件'));
    assert.ok(headers.includes('账单来源行号'));

    const firstDataRow = dataSheet.getRow(2);
    const headerToIndex = new Map(headers
      .map((header, index) => (header ? [header, index] : null))
      .filter(Boolean));
    assert.equal(firstDataRow.getCell(headerToIndex.get('台账来源文件')).value, '审核台导入.xlsx');
    assert.equal(firstDataRow.getCell(headerToIndex.get('账单来源行号')).value, 9);

    // 统一表格样式回归:表头深蓝灰底 + 微软雅黑,数据行字体一致(视觉层不改任何值)。
    assert.equal(dataSheet.getRow(1).getCell(1).fill.fgColor.argb, COLORS.headerBg, '表头深蓝灰');
    assert.equal(dataSheet.getRow(1).getCell(1).font.name, FONT, '表头微软雅黑');
    assert.equal(firstDataRow.getCell(1).font.name, FONT, '数据行微软雅黑');
    for (const f of result.files) {
      assert.ok(fs.existsSync(f.path), `file should exist: ${f.path}`);
      const stats = fs.statSync(f.path);
      assert.ok(stats.size > 0, `file should be non-empty: ${f.path}`);
    }
    // Clean up
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {
      // intentional: best-effort cleanup
    }
  });
});
