'use strict';

const DATA_COLUMNS = Object.freeze([
  { header: '日期', key: 'stmt_date' },
  { header: '出账日期', key: 'statement_date' },
  { header: '付款模式', key: 'payment_mode' },
  { header: '返点模式', key: 'mode_raw' },
  { header: '免税店', key: 'shop' },
  { header: '免税分店', key: 'branch' },
  { header: '上家', key: 'upstream' },
  { header: '入店公司', key: 'entry_company' },
  { header: '导游', key: 'tour_guide' },
  { header: '代理', key: 'agent' },
  { header: '原日期', key: 'original_date' },
  { header: '购买日期', key: 'purchase_date' },
  { header: '团号', key: 'tour_no' },
  { header: '姓名', key: 'name' },
  { header: '护照号', key: 'passport_no' },
  { header: '出境日期', key: 'departure_date' },
  { header: '小票号', key: 'receipt_no' },
  { header: '原小票号', key: 'original_receipt_no' },
  { header: '分类', key: 'category' },
  { header: '品牌', key: 'brand' },
  { header: 'SKU', key: 'sku' },
  { header: '产品名称', key: 'product_name' },
  { header: 'REF NO', key: 'ref_no' },
  { header: '数量', key: 'qty' },
  { header: '总卖出($)', key: 'gross_usd' },
  { header: '总卖出(￦)', key: 'gross_krw' },
  { header: '纯卖出($)', key: 'net_usd' },
  { header: '纯卖出(￦)', key: 'net_krw' },
  { header: 'DC($)', key: 'dc_usd' },
  { header: 'DC(￦)', key: 'dc_krw' },
  { header: '折扣率', key: 'discount_rate' },
  { header: '商品券金额', key: 'voucher_amount' },
  { header: '扣点商品券', key: 'voucher_deduction' },
  { header: '客人点数', key: 'customer_points' },
  { header: '客人返点金额(￦)', key: 'customer_rebate_krw' },
  { header: '客人返点金额($)', key: 'customer_rebate_usd' },
  { header: '免税店点数', key: 'store_base_points' },
  { header: '免税店返点', key: 'store_base_rebate' },
  { header: '免税店追加点', key: 'store_extra_points' },
  { header: '追加金额', key: 'store_extra_amount' },
  { header: '免税店最终返点', key: 'store_final_rebate' },
  { header: '分类', key: 'category_secondary' },
  { header: '备注', key: 'remark' },
]);

const PENDING_COLUMNS = Object.freeze([
  { header: 'ID', key: 'id' },
  { header: '来源', key: 'source_table' },
  { header: '来源行', key: 'source_id' },
  { header: '类型', key: 'reason_type' },
  { header: '状态', key: 'status' },
  { header: '发现时间', key: 'created_at' },
  { header: '详情', key: 'detail' },
]);

const TRACE_COLUMNS = Object.freeze([
  { header: '系统月度ID', key: 'trace_monthly_data_id' },
  { header: '台账ID', key: 'trace_daily_receipt_id' },
  { header: '账单ID', key: 'trace_store_bill_id' },
  { header: '匹配日志ID', key: 'trace_match_log_id' },
  { header: '匹配规则', key: 'trace_match_key' },
  { header: '台账来源文件', key: 'trace_daily_source_file' },
  { header: '台账来源工作表', key: 'trace_daily_source_sheet' },
  { header: '台账来源行号', key: 'trace_daily_source_row' },
  { header: '账单来源文件', key: 'trace_bill_source_file' },
  { header: '账单来源工作表', key: 'trace_bill_source_sheet' },
  { header: '账单来源行号', key: 'trace_bill_source_row' },
]);

function exportColumnDescription(key) {
  return {
    stmt_date: '店铺账单或下游表中的日期字段。',
    statement_date: '店铺账单出账日期。',
    payment_mode: '付款模式。',
    mode_raw: '返点/业务模式原始值。',
    shop: '免税店名称。',
    branch: '免税店分店。',
    upstream: '上家。',
    entry_company: '入店公司。',
    tour_guide: '导游。',
    agent: '代理，来自审核建档或台账字段。',
    original_date: '原始日期。',
    purchase_date: '购买日期，用于账单和台账匹配。',
    tour_no: '团号，用于业务分类和匹配辅助。',
    name: '客户姓名。',
    passport_no: '护照号。',
    departure_date: '出境日期。',
    receipt_no: '小票号，主要匹配键之一。',
    original_receipt_no: '原小票号。',
    category: '商品分类。',
    brand: '品牌。',
    sku: 'SKU。',
    product_name: '产品名称。',
    ref_no: 'REF NO。',
    qty: '数量。',
    gross_usd: '总卖出美元。',
    gross_krw: '总卖出韩元。',
    net_usd: '纯卖出美元。',
    net_krw: '纯卖出韩元。',
    dc_usd: '折扣美元。',
    dc_krw: '折扣韩元。',
    discount_rate: '折扣率。',
    voucher_amount: '商品券金额。',
    voucher_deduction: '扣点商品券。',
    customer_points: '客人点数。',
    customer_rebate_krw: '客人返点金额(韩元)。',
    customer_rebate_usd: '客人返点金额(美元)。',
    store_base_points: '免税店基础点数。',
    store_base_rebate: '免税店基础返点。',
    store_extra_points: '免税店追加点。',
    store_extra_amount: '追加金额。',
    store_final_rebate: '免税店最终返点。',
    category_secondary: '第二分类字段，保留原表结构。',
    remark: '备注。',
    id: '人工确认记录ID。',
    source_table: '人工确认来源表。',
    source_id: '人工确认来源行ID。',
    reason_type: '进入人工确认的原因。',
    status: '人工确认当前状态。',
    created_at: '人工确认发现时间。',
    detail: '人工确认详细信息。',
    trace_monthly_data_id: '系统月度ID，可回到系统月度数据追溯。',
    trace_daily_receipt_id: '台账ID，可回到收票台账追溯。',
    trace_store_bill_id: '账单ID，可回到店铺账单追溯。',
    trace_match_log_id: '匹配日志ID，可回到匹配过程追溯。',
    trace_match_key: '本行采用的匹配规则或匹配键。',
    trace_daily_source_file: '台账来源文件。',
    trace_daily_source_sheet: '台账来源工作表。',
    trace_daily_source_row: '台账来源 Excel 行号。',
    trace_bill_source_file: '账单来源文件。',
    trace_bill_source_sheet: '账单来源工作表。',
    trace_bill_source_row: '账单来源 Excel 行号。',
  }[key] || '系统导出字段。';
}

function buildExportFilename(workspaceKey, folder, label) {
  const parts = [workspaceKey, folder, label].filter(Boolean).map((part) => sanitizeFileName(part));
  return `${parts.join('_')}.xlsx`;
}

function sanitizeFileName(value, fallback = 'customer') {
  return String(value || '')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || fallback;
}

module.exports = {
  DATA_COLUMNS,
  PENDING_COLUMNS,
  TRACE_COLUMNS,
  exportColumnDescription,
  buildExportFilename,
  sanitizeFileName,
};
