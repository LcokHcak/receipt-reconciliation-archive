const fs = require('node:fs');
const path = require('node:path');

const JSZip = require('jszip');

const { RECEIPT_TEMPLATE_MAPPING } = require('../lib/receipt_template_mapping');

// 2026-06-13 中文签名下线:原有签名图嵌入相关常量/helper(drawing/media/content-types)已全部删除。

function formatAmount(value) {
  const digits = String(value || '').replace(/[^\d.-]/g, '');
  if (!digits) {
    return '';
  }
  const numeric = Number.parseFloat(digits);
  if (!Number.isFinite(numeric)) {
    return '';
  }
  return numeric.toLocaleString('en-US');
}

function escapeXml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function stripCellType(attrs) {
  return String(attrs || '').replace(/\s+t="[^"]*"/g, '').replace(/\s*\/\s*$/g, '');
}

function setInlineCell(sheetXml, cellRef, value) {
  const escapedValue = escapeXml(value);
  const emptyCellPattern = new RegExp(`<c([^>]*)r="${cellRef}"([^>]*)\\/>`);
  if (emptyCellPattern.test(sheetXml)) {
    return sheetXml.replace(emptyCellPattern, (_match, before, after) => (
      `<c${stripCellType(before)}r="${cellRef}"${stripCellType(after)} t="inlineStr"><is><t>${escapedValue}</t></is></c>`
    ));
  }

  const fullCellPattern = new RegExp(`<c([^>]*)r="${cellRef}"([^>]*)>[\\s\\S]*?<\\/c>`);
  if (fullCellPattern.test(sheetXml)) {
    return sheetXml.replace(fullCellPattern, (_match, before, after) => (
      `<c${stripCellType(before)}r="${cellRef}"${stripCellType(after)} t="inlineStr"><is><t>${escapedValue}</t></is></c>`
    ));
  }

  return sheetXml;
}

function removeCalcChainContentType(xml) {
  return String(xml || '').replace(
    /<Override[^>]+PartName="\/xl\/calcChain\.xml"[^>]*\/>/,
    ''
  );
}

function removeCalcChainRelationship(xml) {
  return String(xml || '').replace(
    /<Relationship[^>]+Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/calcChain"[^>]*\/>/,
    ''
  );
}

async function removeCalcChain(zip) {
  if (zip.file('xl/calcChain.xml')) {
    zip.remove('xl/calcChain.xml');
  }
  if (zip.file('xl/_rels/workbook.xml.rels')) {
    zip.file(
      'xl/_rels/workbook.xml.rels',
      removeCalcChainRelationship(await zip.file('xl/_rels/workbook.xml.rels').async('string'))
    );
  }
  if (zip.file('[Content_Types].xml')) {
    zip.file(
      '[Content_Types].xml',
      removeCalcChainContentType(await zip.file('[Content_Types].xml').async('string'))
    );
  }
}

async function writeTemplateZip({
  workingTemplatePath,
  outputPath,
  values,
}) {
  const zip = await JSZip.loadAsync(fs.readFileSync(workingTemplatePath));
  const sheetPath = 'xl/worksheets/sheet1.xml';
  let sheetXml = await zip.file(sheetPath).async('string');

  Object.entries(values).forEach(([cellRef, value]) => {
    sheetXml = setInlineCell(sheetXml, cellRef, value);
  });
  await removeCalcChain(zip);

  // 2026-06-13 中文签名下线:不再往客户账单嵌签名图。客户手签留白行由模板自带(保留)。
  zip.file(sheetPath, sheetXml);
  const output = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, output);
}

function createCustomerTemplateFillService() {
  async function fillTemplate({
    workingTemplatePath,
    outputPath,
    travelerName,
    passportNumber,
    contactPhone,
    receiptAmount,
    approvedAt,
  }) {
    const approvedDate = new Date(approvedAt || Date.now());
    const fields = RECEIPT_TEMPLATE_MAPPING.fields;
    await writeTemplateZip({
      workingTemplatePath,
      outputPath,
      values: {
        [fields.travelerName]: travelerName || '',
        [fields.passportNumber]: passportNumber || '',
        [fields.contactPhone]: contactPhone || '',
        [fields.receiptAmount]: receiptAmount ? formatAmount(receiptAmount) : '',
        [fields.approvalYear]: `${approvedDate.getUTCFullYear()}년`,
        [fields.approvalMonth]: `${String(approvedDate.getUTCMonth() + 1).padStart(2, '0')}월`,
        [fields.approvalDay]: `${String(approvedDate.getUTCDate()).padStart(2, '0')}일`,
      },
    });
    return outputPath;
  }

  return {
    fillTemplate,
  };
}

module.exports = {
  createCustomerTemplateFillService,
};
