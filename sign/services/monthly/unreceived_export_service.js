'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');

const { allFolders, classifyBillFolder } = require('../../lib/monthly_pipeline/mode_folder_classifier');
const { normalizeString } = require('../../lib/monthly_pipeline/matching/field_diff');
const { ensureDir } = require('../../lib/workbench_utils');
const { sanitizeFileName } = require('./monthly_export/builders');
const { createCustomerReconciliationService } = require('./customer_reconciliation_service');
const { applyExcelStyle } = require('../../lib/excel_style');

// 2026-06-12 改版:未收清单导出改为「账单明细样式」(运营要求——字段对齐源账单,
// 审核员能直接对回账单溯源),并按 4 桶分 sheet。每张未收小票输出其全部账单明细行。
const UNRECEIVED_DETAIL_COLUMNS = Object.freeze([
  { header: '返点模式', key: 'mode', width: 12 },
  { header: '免税店', key: 'store_family', width: 12 },
  { header: '免税分店', key: 'store_branch', width: 12 },
  { header: '原日期', key: 'original_date', width: 12 },
  { header: '购买日期', key: 'purchase_date', width: 12 },
  { header: '团号', key: 'tour_no', width: 12 },
  { header: '姓名', key: 'name', width: 18 },
  { header: '护照号', key: 'passport_no', width: 16 },
  { header: '出境日期', key: 'departure_date', width: 12 },
  { header: '小票号', key: 'receipt_no', width: 18 },
  { header: '原小票号', key: 'original_receipt_no', width: 18 },
  { header: '分类', key: 'category', width: 20 },
  { header: '品牌', key: 'brand', width: 14 },
  { header: 'SKU', key: 'sku', width: 16 },
  { header: '产品名称', key: 'product_name', width: 28 },
  { header: '数量', key: 'qty', width: 8 },
  { header: '总卖出($)', key: 'gross_usd', width: 12, style: { numFmt: '#,##0.00' } },
  { header: '总卖出(￦)', key: 'gross_krw', width: 14, style: { numFmt: '#,##0' } },
  { header: '纯卖出($)', key: 'net_usd', width: 12, style: { numFmt: '#,##0.00' } },
  { header: '纯卖出(￦)', key: 'net_krw', width: 14, style: { numFmt: '#,##0' } },
]);

// 二轮收票模板保留原 9 列(给审核员轻量手填追票,不需要账单全列)
const SECOND_ROUND_COLUMNS = Object.freeze([
  { header: '返点模式', key: 'mode_raw', width: 14 },
  { header: '团号', key: 'tour_no', width: 14 },
  { header: '购买日期', key: 'purchase_date', width: 14 },
  { header: '姓名', key: 'name', width: 18 },
  { header: '完整姓名', key: 'full_name', width: 22 },
  { header: '护照号', key: 'passport_no', width: 18 },
  { header: '小票号', key: 'receipt_no', width: 20 },
  { header: '品牌', key: 'brand', width: 14 },
  { header: '求和项:纯卖出($)', key: 'net_usd', width: 16, style: { numFmt: '#,##0.00' } },
]);

const UNRECEIVED_FILENAME = '未收清单.xlsx';
const SECOND_ROUND_SUFFIX = '二轮收票模板.xlsx';

function itemKey(passport, name, receipt) {
  return `${normalizeString(passport)}|${normalizeString(name)}|${normalizeString(receipt)}`;
}

function createUnreceivedExportService({ db, customerReconciliationService } = {}) {
  if (!db) {
    throw new Error('unreceived_export_service: db required(明细导出需直接查 store_bill)');
  }

  // 未收口径 (2026-06-03 统一): 账单有、台账无,与未收清单页/核销过滤同源。
  const recon = customerReconciliationService || createCustomerReconciliationService({ db });

  // 单源=SMG总账(2026-07-22 用户拍板,与 billUnreceivedStmt 同口径):未收明细只取 SMG 行,
  // 否则同一未收票的店家账单明细行也会被拉进来 = 交付包「未收明细双份」(审计 HIGH)。
  const detailStmt = db.prepare(`
    SELECT mode, store_family, store_branch, original_date, purchase_date, tour_no,
           name, passport_no, departure_date, receipt_no, original_receipt_no,
           category, brand, sku, product_name, qty,
           gross_usd, gross_krw, net_usd, net_krw
    FROM store_bill
    WHERE workspace_key = ?
      AND receipt_no IS NOT NULL AND receipt_no != ''
      AND (transaction_type IS NULL OR transaction_type = 'sale')
      AND import_job_id IN (SELECT id FROM import_job WHERE workspace_key = ? AND job_type = 'smg_ledger')
    ORDER BY purchase_date, receipt_no, id
  `);

  function listUnreceivedRows(workspaceKey, { folder = null } = {}) {
    return recon.listUnreceived(workspaceKey, { folder });
  }

  /**
   * 未收小票的账单明细行,按桶分组。
   * @returns {Map<folder, Array<detailRow>>}(classifyBillFolder 不中的归 '未归桶')
   */
  function listUnreceivedDetailByFolder(workspaceKey, { folder = null } = {}) {
    const unreceivedKeys = new Set(
      listUnreceivedRows(workspaceKey, { folder })
        .map((r) => itemKey(r.passport_no, r.name, r.receipt_no))
    );
    const byFolder = new Map();
    if (!unreceivedKeys.size) return byFolder;
    for (const row of detailStmt.all(workspaceKey, workspaceKey)) {
      if (!unreceivedKeys.has(itemKey(row.passport_no, row.name, row.receipt_no))) continue;
      const f = classifyBillFolder({
        modeRaw: row.mode, storeFamily: row.store_family, storeBranch: row.store_branch,
      }) || '未归桶';
      if (folder && f !== folder) continue;
      if (!byFolder.has(f)) byFolder.set(f, []);
      byFolder.get(f).push(row);
    }
    return byFolder;
  }

  /**
   * 把未收明细写进 workbook:按桶一 sheet(账单明细样式)。
   * @returns {{ totalRows: number, receiptCount: number }}
   */
  function addUnreceivedWorksheets(workbook, workspaceKey, { folder = null } = {}) {
    const byFolder = listUnreceivedDetailByFolder(workspaceKey, { folder });
    let totalRows = 0;
    const receipts = new Set();
    const folders = [...allFolders(), '未归桶'].filter((f) => byFolder.has(f));
    if (!folders.length) {
      // 空数据也给一个空 sheet,避免无 sheet 的非法 xlsx
      const sheet = workbook.addWorksheet(folder || '未收清单');
      sheet.columns = UNRECEIVED_DETAIL_COLUMNS.map((c) => ({ ...c }));
      applyExcelStyle(sheet, { freezeCols: 0, columnCount: UNRECEIVED_DETAIL_COLUMNS.length });
      return { totalRows: 0, receiptCount: 0 };
    }
    for (const f of folders) {
      const sheet = workbook.addWorksheet(f);
      sheet.columns = UNRECEIVED_DETAIL_COLUMNS.map((c) => ({ ...c }));
      for (const row of byFolder.get(f)) {
        sheet.addRow({
          ...row,
          original_date: fmtDate(row.original_date),
          purchase_date: fmtDate(row.purchase_date),
          departure_date: fmtDate(row.departure_date),
          qty: numberOrNull(row.qty),
          gross_usd: numberOrNull(row.gross_usd),
          gross_krw: numberOrNull(row.gross_krw),
          net_usd: numberOrNull(row.net_usd),
          net_krw: numberOrNull(row.net_krw),
        });
        totalRows += 1;
        receipts.add(itemKey(row.passport_no, row.name, row.receipt_no));
      }
      applyExcelStyle(sheet, { freezeCols: 0, columnCount: UNRECEIVED_DETAIL_COLUMNS.length });
    }
    return { totalRows, receiptCount: receipts.size };
  }

  async function exportForWorkspace({ workspaceKey, outputDir }) {
    if (!workspaceKey || !outputDir) throw new Error('workspaceKey and outputDir required');
    ensureDir(outputDir);

    const files = [];

    const unreceivedPath = path.join(outputDir, UNRECEIVED_FILENAME);
    if (fs.existsSync(unreceivedPath)) {
      try { fs.unlinkSync(unreceivedPath); } catch { /* best-effort cleanup */ }
    }
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Sign Workbench';
    workbook.created = new Date();
    const stats = addUnreceivedWorksheets(workbook, workspaceKey);
    await workbook.xlsx.writeFile(unreceivedPath);
    files.push({ kind: 'unreceived_list', folder: null, path: unreceivedPath, rows: stats.totalRows });

    for (const folder of allFolders()) {
      const templatePath = path.join(outputDir, `${sanitizeFileName(folder)}${SECOND_ROUND_SUFFIX}`);
      await writeSecondRoundTemplate(templatePath, folder);
      files.push({ kind: 'second_round_template', folder, path: templatePath, rows: 0 });
    }

    return { workspaceKey, outputDir, files, unreceivedRows: stats.receiptCount };
  }

  return { listUnreceivedRows, listUnreceivedDetailByFolder, addUnreceivedWorksheets, exportForWorkspace };
}

// 二轮收票模板:表头同旧 9 列,0 数据行,等审核员填表追客户。
async function writeSecondRoundTemplate(filePath, folder) {
  if (fs.existsSync(filePath)) {
    try { fs.unlinkSync(filePath); } catch { /* best-effort cleanup */ }
  }
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Sign Workbench';
  workbook.created = new Date();
  const sheet = workbook.addWorksheet(`${folder}-二轮收票`);
  sheet.columns = SECOND_ROUND_COLUMNS.map((c) => ({ ...c }));
  applyExcelStyle(sheet, { freezeCols: 0, columnCount: SECOND_ROUND_COLUMNS.length });
  await workbook.xlsx.writeFile(filePath);
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function fmtDate(value) {
  if (!value) return '';
  const s = String(value).trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
}

module.exports = {
  createUnreceivedExportService,
  UNRECEIVED_DETAIL_COLUMNS,
  SECOND_ROUND_COLUMNS,
};
