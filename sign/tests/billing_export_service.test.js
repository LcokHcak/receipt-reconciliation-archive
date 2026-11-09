const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ExcelJS = require('exceljs');

const { createBillingExportService } = require('../services/billing_export_service');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'billing-export-'));
}

function cleanup(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

test('exportCustomerBill 用固定空白模板写出可读账单(中文签名下线:不嵌签名图)', async () => {
  const tempRoot = makeTempDir();

  try {
    const outputDir = path.join(tempRoot, 'out');

    const service = createBillingExportService();
    const result = await service.exportCustomerBill({
      outputDir,
      customer: {
        travelerName: 'ZHOU YAN',
        passportNumber: 'EJ1234567',
        contactPhone: '010-1111-2222',
        receiptAmount: '78000',
      },
      approvedAt: '2026-05-05T15:00:00.000Z',
    });

    assert.equal(path.dirname(result.outputPath), outputDir);
    assert.equal(path.basename(result.outputPath), '账单-ZHOU YAN.xlsx');
    assert.equal(
      result.templatePath.endsWith(path.join('passport_review_workbench', 'templates', 'customer-receipt-template.xlsx')),
      true
    );

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(result.outputPath);
    const sheet = workbook.worksheets[0];
    assert.equal(sheet.getCell('F7').value, 'ZHOU YAN');
    assert.equal(sheet.getCell('F8').value, 'EJ1234567');
    assert.equal(sheet.getCell('F9').value, '010-1111-2222');
    assert.equal(sheet.getCell('F10').value, '78,000');
    // 中文签名下线:输出不应含签名图
    assert.equal((workbook.model.media || []).length, 0, '账单不应再嵌任何签名图');
  } finally {
    cleanup(tempRoot);
  }
});
