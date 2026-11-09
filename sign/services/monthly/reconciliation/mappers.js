'use strict';

const {
  LEDGER_STATUS_LABELS,
  PENDING_REASON_LABELS,
  buildSource,
  fmt,
  safeJson,
} = require('./common');

function mapLedgerRow(row) {
  return {
    id: row.id,
    receiptDate: fmt(row.receipt_date),
    status: row.ledger_status,
    statusLabel: LEDGER_STATUS_LABELS[row.ledger_status] || row.ledger_status || '-',
    remedyReason: row.remedy_reason || '',
    agent: row.agent || '',
    owner: row.modified_by || '',
    purchaseDate: fmt(row.purchase_date),
    tourNo: row.tour_no || '',
    name: row.name || '',
    passportNo: row.passport_no || '',
    receiptNo: row.receipt_no || '',
    shop: row.shop || '',
    trace: {
      ledgerId: row.id,
      dailySource: buildSource(row.source_file, row.source_sheet, row.source_row),
      sourceBatchId: row.source_batch_id || '',
      sourceTaskId: row.source_task_id || '',
      rowHash: row.row_hash || '',
      importedAt: row.imported_at || '',
    },
  };
}

function mapStoreBillRow(row) {
  return {
    id: row.id,
    store: [row.store_family, row.store_branch].filter(Boolean).join(' ') || row.store_family || '',
    mode: row.mode || '',
    purchaseDate: fmt(row.purchase_date),
    tourNo: row.tour_no || '',
    name: row.name || row.full_name || '',
    passportNo: row.passport_no || '',
    receiptNo: row.receipt_no || '',
    trace: {
      billId: row.id,
      billSource: buildSource(row.source_file, row.source_sheet, row.source_row),
      rowHash: row.row_hash || '',
      importedAt: row.imported_at || '',
    },
  };
}

function mapMonthlyTraceRow(row) {
  return {
    monthlyId: row.monthly_id,
    modeFolder: row.mode_folder || '',
    kind: row.is_unmatched ? '账单有但未收' : '正式入月',
    receiptNo: row.receipt_no || '',
    name: row.name || '',
    passportNo: row.passport_no || '',
    tourNo: row.tour_no || '',
    purchaseDate: fmt(row.purchase_date),
    shop: row.shop || row.bill_store_family || '',
    trace: {
      monthlyDataId: row.monthly_id,
      dailyReceiptId: row.daily_receipt_id,
      storeBillId: row.store_bill_id,
      matchLogId: row.match_log_id,
      matchRule: row.match_key || '',
      matchPriority: row.match_priority,
      matchStatus: row.match_status || '',
      matchNote: row.match_note || '',
      dailyOwner: row.daily_modified_by || '',
      dailyReceiptDate: fmt(row.daily_receipt_date),
      dailySource: buildSource(row.daily_source_file, row.daily_source_sheet, row.daily_source_row),
      billSource: buildSource(row.bill_source_file, row.bill_source_sheet, row.bill_source_row),
      sourceBatchId: row.daily_source_batch_id || '',
      sourceTaskId: row.daily_source_task_id || '',
    },
  };
}

function mapPendingRow(row) {
  const detail = safeJson(row.detail);
  const sourceIsBill = row.source_table === 'store_bill';
  return {
    id: row.id,
    sourceTable: sourceIsBill ? '店铺账单' : '收票台账',
    sourceId: row.source_id,
    reasonType: row.reason_type,
    reasonLabel: PENDING_REASON_LABELS[row.reason_type] || row.reason_type || '待人工确认',
    status: row.status,
    createdAt: row.created_at || '',
    name: sourceIsBill ? (row.bill_name || '') : (row.daily_name || ''),
    passportNo: sourceIsBill ? (row.bill_passport_no || '') : (row.daily_passport_no || ''),
    receiptNo: sourceIsBill ? (row.bill_receipt_no || '') : (row.daily_receipt_no || ''),
    detail,
    trace: {
      dailySource: buildSource(row.daily_source_file, row.daily_source_sheet, row.daily_source_row),
      billSource: buildSource(row.bill_source_file, row.bill_source_sheet, row.bill_source_row),
    },
  };
}

function mapBillMatchRow(row) {
  return {
    id: row.id,
    dailyReceiptId: row.daily_receipt_id,
    storeBillId: row.store_bill_id,
    status: row.match_status,
    priority: row.match_priority,
    matchRule: row.match_key || '',
    matchedAt: row.matched_at || '',
    note: row.note || '',
    daily: {
      receiptNo: row.daily_receipt_no || '',
      name: row.daily_name || '',
      passportNo: row.daily_passport_no || '',
      source: buildSource(row.daily_source_file, row.daily_source_sheet, row.daily_source_row),
    },
    bill: {
      receiptNo: row.bill_receipt_no || '',
      name: row.bill_name || '',
      passportNo: row.bill_passport_no || '',
      source: buildSource(row.bill_source_file, row.bill_source_sheet, row.bill_source_row),
    },
  };
}

module.exports = {
  mapLedgerRow,
  mapStoreBillRow,
  mapMonthlyTraceRow,
  mapPendingRow,
  mapBillMatchRow,
};
