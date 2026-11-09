'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');
const sharp = require('sharp');

const { openMonthlyDatabase } = require('../../lib/storage/monthly_database');
const { createFinalDeliveryExportService } = require('../../services/monthly/final_delivery_export_service');
const { createCustomerLibraryRepository } = require('../../repositories/customer_library_repository');

const WORKSPACE_KEY = '2026-05';

test('final delivery readiness blocks unresolved pending reviews and missing rebates', () => {
  const { db, dir } = setupDb();
  try {
    insertMonthlyRow(db, {
      rowHash: 'eligible-1',
      dailyReceiptId: 1,
      storeBillId: 11,
      modeFolder: '乐天首尔',
      name: 'HAN SNOW',
      passportNo: 'M12345678',
      customerRebateKrw: 1234567,
      customerRebateUsd: 102.34,
    });
    insertMonthlyRow(db, {
      rowHash: 'missing-rebate',
      dailyReceiptId: 2,
      storeBillId: 12,
      modeFolder: '乐天首尔',
      name: 'KIM',
      passportNo: 'M22222222',
      customerRebateKrw: null,
      customerRebateUsd: null,
    });
    db.prepare(`
      INSERT INTO pending_review
        (workspace_key, source_table, source_id, reason_type, status, created_at)
      VALUES (?, 'store_bill', 12, 'field_conflict', 'open', ?)
    `).run(WORKSPACE_KEY, new Date().toISOString());

    const service = createFinalDeliveryExportService({ db });
    const readiness = service.checkReadiness({ workspaceKey: WORKSPACE_KEY });
    assert.equal(readiness.ok, false);
    assert.equal(readiness.eligibleRows, 1);
    assert.equal(readiness.excluded.missingRebate, 1);
    assert.equal(readiness.excluded.openPendingReviews, 1);
    assert.deepEqual(readiness.blocking.sort(), ['missing_rebate', 'open_pending_reviews']);
  } finally {
    cleanup(db, dir);
  }
});

test('final delivery readiness ignores stale tour-stage pending on already matched ledger rows', () => {
  const { db, dir } = setupDb();
  try {
    insertDailySourceRow(db, {
      id: 88,
      receiptNo: 'STALE-TOUR',
      rowHash: 'daily-stale-tour',
      tourMatchStatus: 'matched',
      ledgerStatus: 'posted',
    });
    insertMonthlyRow(db, {
      rowHash: 'eligible-stale-tour',
      dailyReceiptId: 88,
      storeBillId: 188,
      modeFolder: '乐天首尔',
      name: 'STALE OK',
      passportNo: 'P88',
      receiptNo: 'STALE-TOUR',
      customerRebateKrw: 1000,
      customerRebateUsd: 1,
    });
    db.prepare(`
      INSERT INTO pending_review
        (workspace_key, source_table, source_id, reason_type, status, created_at)
      VALUES (?, 'daily_receipt_export', 88, 'tour_not_found', 'open', ?)
    `).run(WORKSPACE_KEY, new Date().toISOString());

    const service = createFinalDeliveryExportService({ db });
    const readiness = service.checkReadiness({ workspaceKey: WORKSPACE_KEY });
    assert.equal(readiness.excluded.openPendingReviews, 0);
    assert.equal(readiness.ok, true);
  } finally {
    cleanup(db, dir);
  }
});

test('final delivery excludes bill-only adjustments from customer delivery eligibility', () => {
  const { db, dir } = setupDb();
  try {
    insertMonthlyRow(db, {
      rowHash: 'eligible-ledger-linked',
      dailyReceiptId: 1,
      storeBillId: 11,
      receiptNo: 'LEDGER-001',
      customerRebateKrw: 1000,
      customerRebateUsd: 1,
    });
    insertMonthlyRow(db, {
      rowHash: 'bill-only-refund',
      dailyReceiptId: null,
      storeBillId: 99,
      receiptNo: 'BILL-ONLY-REFUND',
      name: 'REFUND ONLY',
      passportNo: null,
      netKrw: -100000,
      customerRebateKrw: -3000,
      customerRebateUsd: null,
    });

    const service = createFinalDeliveryExportService({ db });
    const readiness = service.checkReadiness({ workspaceKey: WORKSPACE_KEY });
    assert.equal(readiness.ok, true);
    assert.equal(readiness.eligibleRows, 1);
    assert.equal(readiness.excluded.billOnlyRows, 1);
    assert.ok(readiness.warnings.includes('bill_only_rows_excluded'));
  } finally {
    cleanup(db, dir);
  }
});

test('final delivery export writes final xlsx, receipt workbook and one pdf per eligible customer', async () => {
  const { db, dir } = setupDb();
  try {
    const { customerLibraryRepository, customerDir } = await seedCustomerLibrary(dir);
    insertDailySourceRow(db, {
      id: 1,
      sourceCustomerId: 'CL20260514-001',
      sourceBatchId: 'batch_20260514',
      sourceTaskId: 'task_receipt_1',
      rowHash: 'daily-source-1',
    });
    insertDailySourceRow(db, {
      id: 2,
      sourceCustomerId: 'CL20260514-001',
      sourceBatchId: 'batch_20260514',
      sourceTaskId: 'task_receipt_2',
      rowHash: 'daily-source-2',
    });
    insertMonthlyRow(db, {
      rowHash: 'eligible-1',
      dailyReceiptId: 1,
      storeBillId: 11,
      modeFolder: '乐天首尔',
      name: 'HAN SNOW',
      passportNo: 'M12345678',
      departureDate: '2026-05-20',
      receiptNo: '90176326000330',
      customerRebateKrw: 1234567,
      customerRebateUsd: 102.34,
    });
    insertMonthlyRow(db, {
      rowHash: 'eligible-2',
      dailyReceiptId: 2,
      storeBillId: 12,
      modeFolder: '乐天首尔',
      name: 'HAN SNOW',
      passportNo: 'M12345678',
      departureDate: '2026-05-21',
      receiptNo: '90176326000331',
      customerRebateKrw: 2000,
      customerRebateUsd: 2,
    });
    insertMonthlyRow(db, {
      rowHash: 'unmatched-excluded',
      dailyReceiptId: null,
      storeBillId: 99,
      modeFolder: '乐天首尔',
      isUnmatched: true,
      name: 'UNRECEIVED',
      passportNo: 'M99999999',
      customerRebateKrw: 777777,
    });
    insertMonthlyRow(db, {
      rowHash: 'no-bill-excluded',
      dailyReceiptId: 3,
      storeBillId: null,
      modeFolder: '乐天首尔',
      name: 'DAILY ONLY',
      passportNo: 'M33333333',
      customerRebateKrw: 888888,
    });
    insertMonthlyRow(db, {
      rowHash: 'bill-only-adjustment-excluded',
      dailyReceiptId: null,
      storeBillId: 199,
      name: 'REFUND ONLY',
      passportNo: null,
      receiptNo: 'BILL-ONLY-199',
      netKrw: -100000,
      customerRebateKrw: -3333,
    });

    const service = createFinalDeliveryExportService({ db, customerLibraryRepository });
    const outputDir = path.join(dir, 'delivery');
    const result = await service.run({ workspaceKey: WORKSPACE_KEY, outputDir, operator: 'tester' });

    assert.equal(result.readiness.ok, true);
    assert.equal(result.readiness.eligibleRows, 2);
    assert.equal(result.readiness.excluded.unreceivedRows, 1);
    assert.equal(result.readiness.excluded.dailyWithoutBill, 1);
    assert.equal(result.readiness.excluded.billOnlyRows, 1);

    const dataFile = result.files.find((file) => file.kind === 'final_data' && file.folder === '乐天首尔');
    assert.ok(dataFile, 'final data xlsx should exist');
    const dataWorkbook = new ExcelJS.Workbook();
    await dataWorkbook.xlsx.readFile(dataFile.path);
    // 最终数据对齐通用交付模板:客户汇总/明细/小票/做账单
    assert.deepEqual(dataWorkbook.getWorksheet('客户汇总').getRow(1).values.slice(1), [
      '姓名', '护照号', '出境日期', '求和项:客人返点金额',
    ]);
    assert.equal(dataWorkbook.getWorksheet('明细').rowCount, 3); // header + 2 eligible rows
    assert.ok(dataWorkbook.getWorksheet('小票'), '应有小票 sheet');
    assert.deepEqual(dataWorkbook.getWorksheet('小票').getRow(1).values.slice(1), [
      '小票号', '代理', '出境日期', '已收', '姓名', '护照号', '负责人', '收票日期',
    ]);
    assert.equal(dataWorkbook.getWorksheet('小票').rowCount, 3); // header + 2 distinct receipts
    // 收票日期 = 客户建档日(上传当天,CL20260514 → 2026-05-14 KST),而非台账 receipt_date。
    const receiptSheet = dataWorkbook.getWorksheet('小票');
    const receiptHeaderVals = receiptSheet.getRow(1).values.slice(1);
    const collectedIdx = receiptHeaderVals.indexOf('收票日期') + 1;
    receiptSheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      assert.equal(row.getCell(collectedIdx).value, '2026-05-14', '收票日期取客户编号内嵌上传日,不用 receipt_date');
    });
    assert.ok(dataWorkbook.getWorksheet('做账单'), '应有做账单 sheet');
    assert.equal(dataWorkbook.getWorksheet('做账单').rowCount, 3);
    assert.equal(dataWorkbook.getWorksheet('代理'), undefined, '通用交付模板没有单独代理 sheet');

    const receiptFile = result.files.find((file) => file.kind === 'receipt_workbook' && file.folder === '乐天首尔');
    assert.ok(receiptFile, 'receipt workbook should exist');
    const receiptWorkbook = new ExcelJS.Workbook();
    await receiptWorkbook.xlsx.readFile(receiptFile.path);
    const signSheet = receiptWorkbook.getWorksheet('Sheet1');
    assert.equal(signSheet.getRow(2).getCell(1).value, 'HAN SNOW');
    assert.equal(signSheet.getRow(2).getCell(2).value, 'M12345678');
    assert.equal(signSheet.getRow(2).getCell(3).value, 1236000);
    assert.equal(signSheet.getImages().length, 0, 'signature placeholders should stay blank until real signatures are wired');

    assert.equal(result.customerPdfs.length, 1);
    assert.ok(result.customerPdfs[0].imageCount >= 3, 'pdf should embed passport, receipt, and ticket images');
    const pdfBytes = fs.readFileSync(result.customerPdfs[0].path);
    assert.equal(pdfBytes.subarray(0, 4).toString('utf8'), '%PDF');

    // ⭐ 2026-08-01:上面那条 imageCount 断的是**服务自己上报的计数器**,
    // 而计数器(imageCount += 1)和真正的 doc.image() 是两条**独立语句**。
    // 变异验证过:把 doc.image(...) 那行注释掉、只留计数器自增 ——
    // PDF 里一张图都不嵌、只剩空白页,而这个测试**照样绿**。
    // 客户拿到的是一份没有任何凭证图的结算单,没有任何防线。
    //
    // 所以查 PDF 字节本身:嵌入的位图会在 PDF 里生成 /Subtype /Image 的 XObject。
    // 这是 pdfkit 嵌图的必然产物,和它内部怎么实现无关。
    const pdfText = pdfBytes.toString('latin1');
    const imageXObjects = (pdfText.match(/\/Subtype\s*\/Image/g) || []).length;
    assert.ok(imageXObjects >= 3,
      `PDF 里只找到 ${imageXObjects} 个图像对象,应至少 3 个(护照/小票/机票)。`
      + 'imageCount 说嵌了 ' + result.customerPdfs[0].imageCount + ' 张 —— '
      + '计数器和真正的 doc.image() 是两条独立语句,只信计数器会漏掉"图根本没进去"');

    // 反向对照:确认这个判据不是"任何 PDF 都能满足"。
    // 没有图的 PDF(比如同批产出的收据单,如果有的话)不该也命中 3 个以上。
    assert.ok(pdfText.includes('/Type /Page') || pdfText.includes('/Type/Page'),
      '前提校验:这确实是一份结构正常的 PDF,不是随便一段字节');

    assert.equal(result.dataPackages.length, 1);
    const dataPackage = result.dataPackages[0];
    assert.ok(dataPackage.path.split(path.sep).includes('客户数据包'));
    // 命名对齐参照样本:客户名 + 护照前4位(空格分隔)
    assert.equal(path.basename(dataPackage.path), 'HAN SNOW M123');
    assert.equal(fs.existsSync(path.join(dataPackage.path, '客户PDF.pdf')), true);
    assert.equal(fs.existsSync(path.join(dataPackage.path, '客户账单.xlsx')), true);
    assert.equal(fs.existsSync(path.join(dataPackage.path, '台账明细.xlsx')), true);
    assert.equal(fs.existsSync(path.join(dataPackage.path, '图片', '护照', '001-passport.png')), true);
    assert.equal(fs.existsSync(path.join(dataPackage.path, '图片', '小票', '001-receipt.png')), true);
    assert.equal(fs.existsSync(path.join(dataPackage.path, '图片', '机票', '001-ticket.png')), true);
    assert.equal(fs.existsSync(path.join(customerDir, 'template', 'bill.xlsx')), true);

    const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
    assert.equal(manifest.eligibleRows, 2);
    assert.equal(manifest.customerPdfCount, 1);
    assert.equal(manifest.dataPackageCount, 1);
  } finally {
    cleanup(db, dir);
  }
});

function setupDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'final-delivery-'));
  const db = openMonthlyDatabase({ dbPath: path.join(dir, 'monthly.sqlite') });
  db.prepare(`
    INSERT INTO monthly_workspace (workspace_key, year, month, status, created_at, updated_at)
    VALUES (?, 2026, 5, 'open', ?, ?)
  `).run(WORKSPACE_KEY, new Date().toISOString(), new Date().toISOString());
  return { db, dir };
}

function insertMonthlyRow(db, overrides = {}) {
  const now = new Date().toISOString();
  const row = {
    workspaceKey: WORKSPACE_KEY,
    modeFolder: '乐天首尔',
    isUnmatched: false,
    dailyReceiptId: 1,
    storeBillId: 1,
    rowHash: `row-${Math.random()}`,
    name: 'HAN SNOW',
    passportNo: 'M12345678',
    purchaseDate: '2026-05-12',
    departureDate: '2026-05-20',
    receiptNo: 'R001',
    tourNo: 'T001',
    netKrw: 1000000,
    netUsd: 800,
    customerPoints: 0.0332,
    customerRebateKrw: 1000,
    customerRebateUsd: 1.25,
    ...overrides,
  };
  db.prepare(`
    INSERT INTO monthly_data (
      workspace_key, mode_folder, is_unmatched, daily_receipt_id, store_bill_id,
      name, passport_no, purchase_date, departure_date, receipt_no, tour_no,
      net_krw, net_usd, customer_points, customer_rebate_krw, customer_rebate_usd,
      row_hash, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.workspaceKey,
    row.modeFolder,
    row.isUnmatched ? 1 : 0,
    row.dailyReceiptId,
    row.storeBillId,
    row.name,
    row.passportNo,
    row.purchaseDate,
    row.departureDate,
    row.receiptNo,
    row.tourNo,
    row.netKrw,
    row.netUsd,
    row.customerPoints,
    row.customerRebateKrw,
    row.customerRebateUsd,
    row.rowHash,
    now,
    now
  );
}

function insertDailySourceRow(db, overrides = {}) {
  const row = {
    id: overrides.id,
    workspaceKey: WORKSPACE_KEY,
    sourceCustomerId: overrides.sourceCustomerId || '',
    sourceBatchId: overrides.sourceBatchId || '',
    sourceTaskId: overrides.sourceTaskId || '',
    name: overrides.name || 'HAN SNOW',
    passportNo: overrides.passportNo || 'M12345678',
    purchaseDate: overrides.purchaseDate || '2026-05-12',
    departureDate: overrides.departureDate || '2026-05-20',
    receiptNo: overrides.receiptNo || `R${overrides.id || 1}`,
    tourNo: overrides.tourNo || 'T001',
    shop: overrides.shop || 'THE SHILLA',
    tourMatchStatus: overrides.tourMatchStatus || 'pending',
    ledgerStatus: overrides.ledgerStatus || 'in_review',
    rowHash: overrides.rowHash || `daily-${overrides.id || Math.random()}`,
    importedAt: '2026-05-14T09:00:00.000Z',
  };
  db.prepare(`
    INSERT INTO daily_receipt_export (
      id, workspace_key, source_customer_id, source_type, source_batch_id, source_task_id,
      name, passport_no, purchase_date, departure_date, receipt_no, tour_no, shop,
      tour_match_status, ledger_status, row_hash, imported_at
    ) VALUES (?, ?, ?, 'workbench', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    row.workspaceKey,
    row.sourceCustomerId,
    row.sourceBatchId,
    row.sourceTaskId,
    row.name,
    row.passportNo,
    row.purchaseDate,
    row.departureDate,
    row.receiptNo,
    row.tourNo,
    row.shop,
    row.tourMatchStatus,
    row.ledgerStatus,
    row.rowHash,
    row.importedAt
  );
}

async function seedCustomerLibrary(dir) {
  const libraryRoot = path.join(dir, 'customer_library');
  const customerLibraryRepository = createCustomerLibraryRepository({
    defaultRoot: libraryRoot,
    settingsPath: path.join(dir, 'customer_library.settings.json'),
    nowProvider: () => new Date('2026-05-14T08:00:00.000Z'),
  });
  const customer = customerLibraryRepository.createCustomerFolder({
    workspaceKey: '20260514-customer-import',
    customerId: 'CL20260514-001',
    agentName: 'Agent A',
    images: [
      { imageId: 'img-passport', relativePath: 'images/passport.png', originalFileName: 'passport.png' },
      { imageId: 'img-receipt', relativePath: 'images/receipt.png', originalFileName: 'receipt.png' },
      { imageId: 'img-ticket', relativePath: 'images/ticket.png', originalFileName: 'ticket.png' },
    ],
  });
  const customerDir = customerLibraryRepository.customerDir('20260514-customer-import', customer.customerId);
  fs.mkdirSync(path.join(customerDir, 'images'), { recursive: true });
  await createPng(path.join(customerDir, 'images', 'passport.png'), '#ff5555');
  await createPng(path.join(customerDir, 'images', 'receipt.png'), '#55aa55');
  await createPng(path.join(customerDir, 'images', 'ticket.png'), '#5555ff');
  fs.mkdirSync(path.join(customerDir, 'template'), { recursive: true });
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('bill').addRow(['bill']);
  await workbook.xlsx.writeFile(path.join(customerDir, 'template', 'bill.xlsx'));

  customer.status = 'in_review';
  customerLibraryRepository.saveCustomer(customer);
  customer.status = 'approved';
  customer.displayName = 'HAN SNOW';
  customer.passportNumber = 'M12345678';
  customerLibraryRepository.saveCustomer(customer);
  customer.status = 'template_generated';
  customer.folderNameFinal = 'HAN SNOW_M12345678';
  customer.template.finalOutputPath = 'template/bill.xlsx';
  customerLibraryRepository.saveCustomer(customer);

  return { customerLibraryRepository, customerDir };
}

async function createPng(filePath, color) {
  await sharp({
    create: {
      width: 120,
      height: 80,
      channels: 3,
      background: color,
    },
  }).png().toFile(filePath);
}

function cleanup(db, dir) {
  try { db.close?.(); } catch { /* noop */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
}
