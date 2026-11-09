'use strict';

const path = require('node:path');
const fs = require('node:fs');
const ExcelJS = require('exceljs');

const { ensureDir } = require('../../../lib/workbench_utils');
const { applyExcelStyle } = require('../../../lib/excel_style');
const { sanitizeFileName } = require('./builders');

const CUSTOMER_EVIDENCE_DIRNAME = '\u5ba2\u6237\u8d44\u6599';
const CUSTOMER_IMAGE_DIRNAME = '\u56fe\u7247';
const CUSTOMER_BILL_FILENAME = '\u8d26\u5355.xlsx';
const CUSTOMER_LEDGER_FILENAME = '\u53f0\u8d26\u660e\u7ec6.xlsx';
const CUSTOMER_MANIFEST_FILENAME = '\u5ba2\u6237\u4fe1\u606f.json';

async function writeCustomerEvidencePackage({
  db,
  workspaceKey,
  outputDir,
  customerLibraryRepository,
  batchRepository = null,
}) {
  const rows = db.prepare(`
    SELECT id, source_customer_id, source_batch_id, source_task_id,
           receipt_date, agent, modified_by, purchase_date, receipt_no,
           tour_no, name, passport_no, departure_date, shop
    FROM daily_receipt_export
    WHERE workspace_key = ?
      AND source_type = 'workbench'
      AND COALESCE(source_customer_id, '') <> ''
    ORDER BY name, passport_no, id
  `).all(workspaceKey);

  const evidenceRoot = path.join(outputDir, CUSTOMER_EVIDENCE_DIRNAME);
  if (fs.existsSync(evidenceRoot)) {
    fs.rmSync(evidenceRoot, { recursive: true, force: true });
  }
  ensureDir(evidenceRoot);

  const groups = groupWorkbenchRowsByCustomer(rows);
  const workspaceCache = new Map();
  const batchCache = new Map();
  const usedFolderNames = new Set();
  let customerCount = 0;
  let imageCount = 0;
  let billCount = 0;
  let ledgerFileCount = 0;

  for (const group of groups) {
    const resolved = resolveCustomerForEvidence({
      group,
      customerLibraryRepository,
      batchRepository,
      workspaceCache,
      batchCache,
    });
    if (!resolved?.customer || !resolved.customerDir) {
      continue;
    }

    const folderName = uniqueFolderName(
      sanitizeFileName(resolveCustomerEvidenceName(resolved.customer, group.rows)),
      usedFolderNames,
      group.customerId
    );
    const targetDir = path.join(evidenceRoot, folderName);
    ensureDir(targetDir);

    billCount += copyCustomerBill(resolved.customerDir, resolved.customer, targetDir);
    imageCount += copyCustomerImages(resolved.customerDir, resolved.customer, targetDir);
    await writeCustomerLedgerWorkbook(path.join(targetDir, CUSTOMER_LEDGER_FILENAME), group.rows);
    ledgerFileCount += 1;
    writeCustomerManifest(targetDir, resolved.customer, group.rows, folderName);
    customerCount += 1;
  }

  return {
    outputDir: evidenceRoot,
    customerCount,
    imageCount,
    billCount,
    ledgerFileCount,
  };
}

function groupWorkbenchRowsByCustomer(rows) {
  const byCustomer = new Map();
  for (const row of rows) {
    const customerId = String(row.source_customer_id || '').trim();
    if (!customerId) continue;
    if (!byCustomer.has(customerId)) {
      byCustomer.set(customerId, { customerId, rows: [] });
    }
    byCustomer.get(customerId).rows.push(row);
  }
  return Array.from(byCustomer.values());
}

function resolveCustomerForEvidence({
  group,
  customerLibraryRepository,
  batchRepository,
  workspaceCache,
  batchCache,
}) {
  const preferred = resolveCustomerReferenceFromBatch(group.rows, batchRepository, batchCache);
  if (preferred?.workspaceKey && preferred?.customerId) {
    const direct = loadCustomerIfExists(customerLibraryRepository, preferred.workspaceKey, preferred.customerId);
    if (direct) return direct;
  }
  return findCustomerById(customerLibraryRepository, group.customerId, workspaceCache);
}

function resolveCustomerReferenceFromBatch(rows, batchRepository, batchCache) {
  if (!batchRepository || typeof batchRepository.loadBatch !== 'function') return null;
  for (const row of rows) {
    const batchId = String(row.source_batch_id || '').trim();
    const taskId = String(row.source_task_id || '').trim();
    if (!batchId || !taskId) continue;
    let batch = batchCache.get(batchId);
    if (!batchCache.has(batchId)) {
      try {
        batch = batchRepository.loadBatch(batchId);
      } catch (_error) {
        batch = null;
      }
      batchCache.set(batchId, batch);
    }
    const task = Array.isArray(batch?.tasks)
      ? batch.tasks.find((item) => String(item?.id || '').trim() === taskId)
      : null;
    const parsed = parseCustomerReferenceFromSourcePath(task?.sourceOriginalPath);
    if (parsed) return parsed;
  }
  return null;
}

// 客户引用解析收敛到 lib/customer_ref(原同款逻辑散在 4 处)。
const { parseCustomerRefFromPath: parseCustomerReferenceFromSourcePath } = require('../../../lib/customer_ref');

function findCustomerById(customerLibraryRepository, customerId, workspaceCache) {
  if (!customerId) return null;
  for (const workspaceKey of customerLibraryRepository.listWorkspaces()) {
    if (!workspaceCache.has(workspaceKey)) {
      const customers = customerLibraryRepository.listCustomers(workspaceKey);
      workspaceCache.set(workspaceKey, customers);
    }
    const customer = workspaceCache.get(workspaceKey)
      .find((item) => String(item?.customerId || '').trim() === customerId);
    if (customer) {
      return {
        workspaceKey,
        customer,
        customerDir: customerLibraryRepository.customerDir(workspaceKey, customerId),
      };
    }
  }
  return null;
}

function loadCustomerIfExists(customerLibraryRepository, workspaceKey, customerId) {
  try {
    const customer = customerLibraryRepository.loadCustomer(workspaceKey, customerId);
    return {
      workspaceKey,
      customer,
      customerDir: customerLibraryRepository.customerDir(workspaceKey, customerId),
    };
  } catch (_error) {
    return null;
  }
}

function resolveCustomerEvidenceName(customer, rows) {
  return String(
    customer?.displayName
      || rows?.[0]?.name
      || String(customer?.folderNameFinal || '').split('_')[0]
      || customer?.customerId
      || 'customer'
  ).trim();
}

function uniqueFolderName(baseName, usedFolderNames, customerId) {
  const safeBase = baseName || 'customer';
  let candidate = safeBase;
  if (usedFolderNames.has(candidate)) {
    candidate = `${safeBase}_${sanitizeFileName(customerId, 'customer')}`;
  }
  let suffix = 2;
  while (usedFolderNames.has(candidate)) {
    candidate = `${safeBase}_${suffix}`;
    suffix += 1;
  }
  usedFolderNames.add(candidate);
  return candidate;
}

function resolveInside(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const fullPath = path.resolve(resolvedRoot, String(relativePath || ''));
  if (fullPath !== resolvedRoot && !fullPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    return '';
  }
  return fullPath;
}

function copyCustomerBill(customerDir, customer, targetDir) {
  const relPath = String(customer?.template?.finalOutputPath || '').trim();
  if (!relPath) return 0;
  const sourcePath = resolveInside(customerDir, relPath);
  if (!sourcePath || !fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) return 0;
  fs.copyFileSync(sourcePath, path.join(targetDir, CUSTOMER_BILL_FILENAME));
  return 1;
}

function copyCustomerImages(customerDir, customer, targetDir) {
  const images = Array.isArray(customer?.images) ? customer.images : [];
  if (!images.length) return 0;
  const imageDir = path.join(targetDir, CUSTOMER_IMAGE_DIRNAME);
  ensureDir(imageDir);
  let copied = 0;
  for (const image of images) {
    const relPath = String(image?.relativePath || image?.fileName || '').trim();
    const sourcePath = resolveInside(customerDir, relPath);
    if (!sourcePath || !fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) continue;
    copied += 1;
    const ext = path.extname(sourcePath) || '.jpg';
    const rawName = image?.originalFileName || path.basename(relPath) || `image${ext}`;
    const safeName = sanitizeFileName(path.basename(rawName, path.extname(rawName)), `image-${copied}`);
    fs.copyFileSync(sourcePath, path.join(imageDir, `${String(copied).padStart(3, '0')}-${safeName}${ext}`));
  }
  return copied;
}

async function writeCustomerLedgerWorkbook(filePath, rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('\u53f0\u8d26\u660e\u7ec6');
  sheet.columns = [
    { header: '\u6536\u7968\u65e5\u671f', key: 'receipt_date', width: 12 },
    { header: '\u4ee3\u7406', key: 'agent', width: 16 },
    { header: '\u8d1f\u8d23\u4eba', key: 'modified_by', width: 14 },
    { header: '\u8d2d\u4e70\u65e5\u671f', key: 'purchase_date', width: 12 },
    { header: '\u5c0f\u7968\u53f7', key: 'receipt_no', width: 18 },
    { header: '\u56e2\u53f7', key: 'tour_no', width: 12 },
    { header: '\u59d3\u540d', key: 'name', width: 18 },
    { header: '\u62a4\u7167', key: 'passport_no', width: 16 },
    { header: '\u514d\u7a0e\u5e97', key: 'shop', width: 16 },
    { header: '\u51fa\u5883\u65e5\u671f', key: 'departure_date', width: 12 },
  ];
  for (const row of rows) {
    sheet.addRow({
      receipt_date: fmtDate(row.receipt_date),
      agent: row.agent || '',
      modified_by: row.modified_by || '',
      purchase_date: fmtDate(row.purchase_date),
      receipt_no: row.receipt_no || '',
      tour_no: row.tour_no || '',
      name: row.name || '',
      passport_no: row.passport_no || '',
      shop: row.shop || '',
      departure_date: fmtDate(row.departure_date),
    });
  }
  // 统一表格样式(仅视觉层:列序/列数/单元格值/表头行号均不变)。
  // 左侧两列(收票日期/代理)非序号/客户组等定位列 → freezeCols 保持 0(只冻表头)。
  applyExcelStyle(sheet, { headerRow: 1 });
  await workbook.xlsx.writeFile(filePath);
}

function writeCustomerManifest(targetDir, customer, rows, folderName) {
  const payload = {
    folderName,
    customerId: customer?.customerId || '',
    customerName: resolveCustomerEvidenceName(customer, rows),
    passportNumber: customer?.passportNumber || rows?.[0]?.passport_no || '',
    agent: rows?.[0]?.agent || customer?.agentName || '',
    owner: rows?.[0]?.modified_by || '',
    receiptCount: rows.length,
    receipts: rows.map((row) => ({
      receiptNo: row.receipt_no || '',
      tourNo: row.tour_no || '',
      purchaseDate: fmtDate(row.purchase_date),
      shop: row.shop || '',
    })),
  };
  fs.writeFileSync(
    path.join(targetDir, CUSTOMER_MANIFEST_FILENAME),
    JSON.stringify(payload, null, 2),
    'utf8'
  );
}

function fmtDate(value) {
  if (!value) return '';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    return value.toISOString().slice(0, 10);
  }
  const s = String(value).trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return s;
}

module.exports = { writeCustomerEvidencePackage };
