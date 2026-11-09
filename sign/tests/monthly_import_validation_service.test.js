'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ExcelJS = require('exceljs');

const { createImportValidationService } = require('../services/monthly/import_validation_service');

async function writeWorkbook(filePath, rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sheet1');
  for (const row of rows) {
    sheet.addRow(row);
  }
  await workbook.xlsx.writeFile(filePath);
}

test('monthly import validation reads streamed xlsx rows through the shared reader', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monthly-import-validation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'group-code.xlsx');
  await writeWorkbook(filePath, [
    ['tour_no', 'mode', 'apply_date', 'end_date'],
    ['T-001', 'V', '2026-01-01', '2026-01-31'],
  ]);

  const service = createImportValidationService({});
  const result = await service.validateImport({
    filePath,
    importType: 'group_code',
    workspaceKey: '2026-01',
  });

  assert.equal(result.valid, true);
  assert.deepEqual(result.summary, {
    totalRows: 1,
    validRows: 1,
    errorRows: 0,
    warningRows: 0,
  });
});
