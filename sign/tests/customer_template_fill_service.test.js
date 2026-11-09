const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ExcelJS = require('exceljs');
const JSZip = require('jszip');

const { createCustomerTemplateFillService } = require('../services/customer_template_fill_service');

// 仓库内真实模板(跨平台:相对 __dirname,不写死本机 D:)
const REAL_TEMPLATE = path.join(__dirname, '..', 'passport_review_workbench', 'templates', 'customer-receipt-template.xlsx');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'customer-template-fill-'));
}

function cleanup(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

test('fillTemplate 写旅客字段+审批日期,清掉 calcChain,且不再嵌任何签名图', async () => {
  const tempRoot = makeTempDir();

  try {
    const workingTemplatePath = path.join(tempRoot, '账单模板.xlsx');
    const outputPath = path.join(tempRoot, '账单-HUANG YU.xlsx');
    fs.copyFileSync(REAL_TEMPLATE, workingTemplatePath);
    // 注入 calcChain,验证 fillTemplate 会清掉它
    const tz = await JSZip.loadAsync(fs.readFileSync(workingTemplatePath));
    tz.file(
      'xl/calcChain.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><calcChain xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><c r="F10" i="1" l="1"/></calcChain>'
    );
    tz.file(
      'xl/_rels/workbook.xml.rels',
      (await tz.file('xl/_rels/workbook.xml.rels').async('string')).replace(
        '</Relationships>',
        '<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain" Target="calcChain.xml"/></Relationships>'
      )
    );
    tz.file(
      '[Content_Types].xml',
      (await tz.file('[Content_Types].xml').async('string')).replace(
        '</Types>',
        '<Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/></Types>'
      )
    );
    fs.writeFileSync(workingTemplatePath, await tz.generateAsync({ type: 'nodebuffer' }));

    const service = createCustomerTemplateFillService();
    await service.fillTemplate({
      workingTemplatePath,
      outputPath,
      travelerName: 'HUANG YU',
      passportNumber: 'EM7242787',
      contactPhone: '010-1234-5678',
      receiptAmount: '56000',
      approvedAt: '2025-12-18T09:00:00.000Z',
    });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(outputPath);
    const sheet = workbook.worksheets[0];

    assert.equal(sheet.getCell('F7').value, 'HUANG YU');
    assert.equal(sheet.getCell('F8').value, 'EM7242787');
    assert.equal(sheet.getCell('F9').value, '010-1234-5678');
    assert.equal(sheet.getCell('F10').value, '56,000');
    assert.equal(sheet.getCell('C16').value, '2025년');
    assert.equal(sheet.getCell('E16').value, '12월');
    assert.equal(sheet.getCell('F16').value, '18일');

    const outputZip = await JSZip.loadAsync(fs.readFileSync(outputPath));
    assert.equal(Boolean(outputZip.file('xl/calcChain.xml')), false);
    const workbookRelsXml = await outputZip.file('xl/_rels/workbook.xml.rels').async('string');
    assert.doesNotMatch(workbookRelsXml, /calcChain/);
    // 中文签名下线:回归守卫——输出不应含任何签名图产物
    assert.equal(Boolean(outputZip.file('xl/media/signature.png')), false, '不应嵌签名图');
    assert.equal(Boolean(outputZip.file('xl/drawings/drawing1.xml')), false, '不应有签名 drawing');
  } finally {
    cleanup(tempRoot);
  }
});
