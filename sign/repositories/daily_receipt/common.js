'use strict';

const FIELD_COLS = [
  'stmt_date', 'statement_date', 'payment_mode',
  'mode_raw', 'mode_normalized',
  'shop', 'branch', 'upstream', 'entry_company',
  'tour_guide', 'agent',
  'original_date', 'purchase_date', 'tour_no',
  'name', 'passport_no', 'departure_date',
  'receipt_no', 'original_receipt_no',
  'category', 'brand', 'sku', 'product_name',
  'ref_no', 'qty',
  'gross_usd', 'gross_krw', 'net_usd', 'net_krw',
  'dc_usd', 'dc_krw', 'discount_rate',
  'voucher_amount', 'voucher_deduction',
  'customer_points', 'customer_rebate',
  'store_base_points', 'store_base_rebate',
  'store_extra_points', 'store_extra_amount', 'store_final_rebate',
  'category_secondary', 'remark',
];

const NUMERIC_COLS = new Set([
  'qty', 'gross_usd', 'gross_krw', 'net_usd', 'net_krw',
  'dc_usd', 'dc_krw', 'discount_rate',
  'voucher_amount', 'voucher_deduction',
  'customer_points', 'customer_rebate',
  'store_base_points', 'store_base_rebate',
  'store_extra_points', 'store_extra_amount', 'store_final_rebate',
]);

const CAMEL_BY_COL = Object.freeze({
  stmt_date: 'stmtDate',
  statement_date: 'statementDate',
  payment_mode: 'paymentMode',
  mode_raw: 'modeRaw',
  mode_normalized: 'modeNormalized',
  shop: 'shop',
  branch: 'branch',
  upstream: 'upstream',
  entry_company: 'entryCompany',
  tour_guide: 'tourGuide',
  agent: 'agent',
  original_date: 'originalDate',
  purchase_date: 'purchaseDate',
  tour_no: 'tourNo',
  name: 'name',
  passport_no: 'passportNo',
  departure_date: 'departureDate',
  receipt_no: 'receiptNo',
  original_receipt_no: 'originalReceiptNo',
  category: 'category',
  brand: 'brand',
  sku: 'sku',
  product_name: 'productName',
  ref_no: 'refNo',
  qty: 'qty',
  gross_usd: 'grossUsd',
  gross_krw: 'grossKrw',
  net_usd: 'netUsd',
  net_krw: 'netKrw',
  dc_usd: 'dcUsd',
  dc_krw: 'dcKrw',
  discount_rate: 'discountRate',
  voucher_amount: 'voucherAmount',
  voucher_deduction: 'voucherDeduction',
  customer_points: 'customerPoints',
  customer_rebate: 'customerRebate',
  store_base_points: 'storeBasePoints',
  store_base_rebate: 'storeBaseRebate',
  store_extra_points: 'storeExtraPoints',
  store_extra_amount: 'storeExtraAmount',
  store_final_rebate: 'storeFinalRebate',
  category_secondary: 'categorySecondary',
  remark: 'remark',
});

const ALLOWED_FIELD_UPDATES = new Map([
  ...FIELD_COLS.map((col) => [CAMEL_BY_COL[col], col]),
  ['modeFolder', 'mode_folder'],
  ['tourMatchStatus', 'tour_match_status'],
  ['billMatchStatus', 'bill_match_status'],
  ['billMatchPriority', 'bill_match_priority'],
  ['ledgerStatus', 'ledger_status'],
  ['remedyReason', 'remedy_reason'],
  ['modifiedBy', 'modified_by'],
  ['postedAt', 'posted_at'],
  ['postedBy', 'posted_by'],
  ['conflictFields', 'conflict_fields'],
]);

function safeJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function addOwnerScopeCondition(conds, params, { ownerUserId = null, ownerUsername = null } = {}) {
  const ownerConds = [];
  if (ownerUserId !== null && ownerUserId !== undefined && ownerUserId !== '') {
    ownerConds.push('agent_id = ?');
    params.push(Number(ownerUserId));
  }
  if (ownerUsername) {
    ownerConds.push('modified_by = ?');
    params.push(String(ownerUsername));
  }
  if (ownerConds.length) {
    conds.push(`(${ownerConds.join(' OR ')})`);
  }
}

function mapRow(row) {
  if (!row) return null;
  const out = {
    id: row.id,
    workspaceKey: row.workspace_key,
    sourceCustomerId: row.source_customer_id,
    billMatchStatus: row.bill_match_status,
    billMatchPriority: row.bill_match_priority,
    modeFolder: row.mode_folder,
    tourMatchStatus: row.tour_match_status,
    sourceFile: row.source_file,
    sourceSheet: row.source_sheet,
    sourceRow: row.source_row,
    rowHash: row.row_hash,
    importedAt: row.imported_at,
    importJobId: row.import_job_id,
    receiptDate: row.receipt_date,
    agentId: row.agent_id,
    agentCode: row.agent_code,
    sourceType: row.source_type,
    sourceBatchId: row.source_batch_id,
    sourceTaskId: row.source_task_id,
    modifiedBy: row.modified_by,
    ledgerStatus: row.ledger_status,
    remedyReason: row.remedy_reason,
    postedAt: row.posted_at,
    postedBy: row.posted_by,
    manualLockedFields: row.manual_locked_fields ?? null,
    conflictFields: safeJson(row.conflict_fields),
    // 复核HIGH-1/MEDIUM-2(2026-07-16):补齐三列,使 _fetchFullById→insertMany 成为完整行往返
    // (restoreOldRows 回滚依赖;mode_confirmed 此前只在专用查询里映射,mapRow 漏了)
    modeConfirmedAt: row.mode_confirmed_at ?? null,
    modeConfirmedBy: row.mode_confirmed_by ?? null,
    rawPayload: safeJson(row.raw_payload),
  };
  for (const col of FIELD_COLS) out[CAMEL_BY_COL[col]] = row[col];
  return out;
}

function normalizeFieldValue(col, value) {
  if (value == null || value === '') return null;
  if (col === 'conflict_fields') {
    return JSON.stringify(value);
  }
  if (NUMERIC_COLS.has(col) || col === 'bill_match_priority') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return String(value);
}

module.exports = {
  ALLOWED_FIELD_UPDATES,
  CAMEL_BY_COL,
  FIELD_COLS,
  NUMERIC_COLS,
  addOwnerScopeCondition,
  mapRow,
  normalizeFieldValue,
};
