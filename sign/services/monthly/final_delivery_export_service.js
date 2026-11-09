'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');

const { allFolders } = require('../../lib/monthly_pipeline/mode_folder_classifier');
const { ensureDir } = require('../../lib/workbench_utils');
const {
  formatReceiptNoByMode,
  // 「不用记」出口过滤 + 收票日期(=上传当天)统一口径,与台账族其它导出同源(2026-07-24 用户拍板)
  isNoRecordMode,
  resolveCollectedDateFromLedgerRow,
} = require('../../lib/workbench_receipt_export');
// 统一表格样式(流式版):列定义 + 表头/正文就地上样式,只加视觉层,不改列序/列数/值/表头。
const {
  styledColumnDefs,
  styleHeaderRowInPlace,
  styleBodyRowInPlace,
  resolveColumnTypes,
} = require('../../lib/excel_style');

// 月结打票表票号格式化(2026-07-07):台账落库时统一去杠存纯数字(乐天/新罗系正好要纯数字),
// 但**现代**要带杠(2-6-3-5)。这里只给现代行补杠(干净16位→2-6-3-5),其余原样。
function formatMonthlyReceiptNo(row) {
  const receiptNo = row && row.receipt_no ? String(row.receipt_no) : '';
  if (!receiptNo) return receiptNo;
  const mode = String(row.mode_raw || row.mode_folder || '');
  const shop = String(row.shop || '').toUpperCase();
  const isHyundai = /现代|現代|HYUNDAI/.test(mode) || shop.includes('HYUNDAI');
  if (!isHyundai) return receiptNo;
  return formatReceiptNoByMode({ receiptNoFinal: receiptNo }, '现代-JEOCU');
}
// 「活跃待审」谓词单一来源(原本本文件与 pending_review_repository 各一份,已合并)
const { ACTIONABLE_PENDING_PREDICATE: ACTIONABLE_PENDING_REVIEW_SQL } = require('../../lib/monthly_pipeline/actionable_pending_sql');
const {
  buildExportFilename,
  sanitizeFileName,
} = require('./monthly_export/builders');
const { createUnreceivedExportService } = require('./unreceived_export_service');
const { createReceivedReceiptExportService } = require('./received_receipt_export_service');

const SUMMARY_COLUMNS = Object.freeze([
  c('姓名', 'name'),
  c('护照号', 'passport_no'),
  c('出境日期', 'departure_date'),
  c('求和项:客人返点金额', 'customer_rebate_krw'),
]);

const RECEIPT_COLUMNS = Object.freeze([
  c('小票号', 'receipt_no'),
  c('代理', 'agent'),
  c('出境日期', 'departure_date'),
  c('已收', 'received'),
  c('姓名', 'name'),
  c('护照号', 'passport_no'),
  c('负责人', 'owner'),
  c('收票日期', 'receive_date'),
]);

const BILLING_COLUMNS = Object.freeze([
  c('返点模式', 'mode_raw'),
  c('免税分店', 'branch'),
  c('购买日期', 'purchase_date'),
  c('团号', 'tour_no'),
  c('姓名', 'name'),
  c('护照号', 'passport_no'),
  c('小票号', 'receipt_no'),
  c('品牌', 'brand'),
  c('数量', 'qty'),
  c('总卖出($)', 'gross_usd'),
  c('总卖出(￦)', 'gross_krw'),
  c('纯卖出($)', 'net_usd'),
  c('纯卖出(￦)', 'net_krw'),
  c('客人点数', 'customer_points'),
  c('客人返点金额', 'customer_rebate_krw'),
  c('出境日期', 'departure_date'),
]);

const LOTTE_DETAIL_COLUMNS = Object.freeze([
  c('日期', 'stmt_date'), c('出账日期', 'statement_date'), c('付款模式', 'payment_mode'),
  c('返点模式', 'mode_raw'), c('免税店', 'shop'), c('免税分店', 'branch'),
  c('上家', 'upstream'), c('入店公司', 'entry_company'), c('导游', 'tour_guide'),
  c('代理', 'agent'), c('原日期', 'original_date'), c('购买日期', 'purchase_date'),
  c('团号', 'tour_no'), c('姓名', 'name'), c('护照号', 'passport_no'),
  c('出境日期', 'departure_date'), c('小票号', 'receipt_no'), c('原小票号', 'original_receipt_no'),
  c('分类', 'special'), c('品牌', 'brand'), c('SKU', 'sku'), c('产品名称', 'product_name'),
  c('REF NO', 'ref_no'), c('数量', 'qty'), c('总卖出($)', 'gross_usd'), c('总卖出(￦)', 'gross_krw'),
  c('纯卖出($)', 'net_usd'), c('纯卖出(￦)', 'net_krw'), c('DC($)', 'dc_usd'),
  c('DC(￦)', 'dc_krw'), c('折扣率', 'discount_rate'), c('商品券金额', 'voucher_amount'),
  c('扣点商品券', 'voucher_deduction'), c('客人点数', 'customer_points'),
  c('客人返点金额', 'customer_rebate_krw'), c('免税店点数', 'store_base_points'),
  c('免税店返点', 'store_base_rebate'), c('免税店追加点', 'store_extra_points'),
  c('追加金额', 'store_extra_amount'), c('免税店最终返点', 'store_final_rebate'),
  c('分类', 'category_secondary'), c('备注', 'remark'), c('备注2', 'remark2'),
  c('免税分店&购买日期&团号', 'branch_purchase_tour'), c('分类', 'category_tertiary'),
]);

const LOTTE_BUSAN_DETAIL_COLUMNS = Object.freeze([
  c('日期', 'stmt_date'), c('出账日期', 'statement_date'), c('付款模式', 'payment_mode'),
  c('返点模式', 'mode_raw'), c('免税店', 'shop'), c('免税分店', 'branch'),
  c('上家', 'upstream'), c('入店公司', 'entry_company'), c('导游', 'tour_guide'),
  c('代理', 'agent'), c('原日期', 'original_date'), c('购买日期', 'purchase_date'),
  c('团号', 'tour_no'), c('姓名', 'name'), c('护照号', 'passport_no'),
  c('出境日期', 'departure_date'), c('小票号', 'receipt_no'), c('原小票号', 'original_receipt_no'),
  c('分类', 'category'), c('品牌', 'brand'), c('SKU', 'sku'), c('产品名称', 'product_name'),
  c('REF NO', 'ref_no'), c('数量', 'qty'), c('总卖出($)', 'gross_usd'), c('总卖出(￦)', 'gross_krw'),
  c('纯卖出($)', 'net_usd'), c('纯卖出(￦)', 'net_krw'), c('DC($)', 'dc_usd'),
  c('DC(￦)', 'dc_krw'), c('折扣率', 'discount_rate'), c('商品券金额', 'voucher_amount'),
  c('扣点商品券', 'voucher_deduction'), c('客人点数', 'customer_points'),
  c('客人返点金额', 'customer_rebate_krw'), c('免税店点数', 'store_base_points'),
  c('免税店返点金额', 'store_base_rebate'), c('免税店追加点数', 'store_extra_points'),
  c('免税店追加金额', 'store_extra_amount'), c('最终返点金额', 'store_final_rebate'),
  c('备注', 'remark'),
]);

const AIBAO_DETAIL_COLUMNS = Object.freeze([
  c('免税店', 'shop'), c('免税分店', 'branch'), c('导游', 'tour_guide'),
  c('原日期', 'original_date'), c('购买日期', 'purchase_date'), c('团号', 'tour_no'),
  c('姓名', 'name'), c('护照号', 'passport_no'), c('出境日期', 'departure_date'),
  c('小票号', 'receipt_no'), c('原小票号', 'original_receipt_no'), c('分类', 'category'),
  c('品牌', 'brand'), c('SKU', 'sku'), c('产品名称', 'product_name'), c('REF NO', 'ref_no'),
  c('数量', 'qty'), c('总卖出($)', 'gross_usd'), c('总卖出(￦)', 'gross_krw'),
  c('纯卖出($)', 'net_usd'), c('纯卖出(￦)', 'net_krw'), c('DC($)', 'dc_usd'),
  c('DC(￦)', 'dc_krw'), c('商品券金额', 'voucher_amount'), c('扣点商品券', 'voucher_deduction'),
  c('客人点数', 'customer_points'), c('客人返点金额', 'customer_rebate_krw'),
  c('免税店点数', 'store_base_points'), c('免税店返点金额', 'store_base_rebate'),
  c('免税店追加', 'store_extra_points'), c('追加金额', 'store_extra_amount'),
  c('免税店最终返点', 'store_final_rebate'), c('分类', 'category_secondary'),
  c('备注', 'remark'), c('备注2', 'remark2'), c('代理', 'agent'),
]);

const SHILLA_DETAIL_COLUMNS = Object.freeze([
  c('免税店', 'shop'), c('免税分店', 'branch'), c('原日期', 'original_date'),
  c('购买日期', 'purchase_date'), c('团号', 'tour_no'), c('姓名', 'name'),
  c('完整姓名', 'full_name'), c('护照号', 'passport_no'), c('出境日期', 'departure_date'),
  c('小票号', 'receipt_no'), c('1', 'fixed_one'), c('分类', 'category'), c('品牌', 'brand'),
  c('SKU', 'sku'), c('产品名称', 'product_name'), c('REF NO', 'ref_no'), c('数量', 'qty'),
  c('总卖出($)', 'gross_usd'), c('总卖出(￦)', 'gross_krw'), c('纯卖出($)', 'net_usd'),
  c('纯卖出(￦)', 'net_krw'), c('DC($)', 'dc_usd'), c('DC(￦)', 'dc_krw'), c('折扣', 'discount_rate'),
  c('扣点商品券', 'voucher_deduction'), c('客人点数', 'customer_points'),
  c('客人返点金额', 'customer_rebate_krw'), c('免税店点数', 'store_base_points'),
  c('返点', 'store_base_rebate'), c('免税店追加', 'store_extra_points'),
  c('追加金额', 'store_extra_amount'), c('最终返点', 'store_final_rebate'),
  c('特殊', 'special'), c('', 'blank_1'), c('', 'blank_2'), c('', 'blank_3'),
  c('代理', 'agent'), c('点数', 'customer_points'), c('返点', 'customer_rebate_krw'),
  c('S追加点', 'store_extra_points'), c('S追加金额', 'store_extra_amount'),
  c('S最终返点', 'store_final_rebate'), c('D基本点', 'store_base_points'),
  c('D基本返点', 'store_base_rebate'), c('D追加', 'store_extra_points'),
  c('D追加金额', 'store_extra_amount'), c('D最终返点', 'store_final_rebate'),
]);

const DEFAULT_FINAL_TEMPLATES = Object.freeze({
  乐天首尔: Object.freeze({ detailColumns: LOTTE_DETAIL_COLUMNS, billingColumns: BILLING_COLUMNS }),
  乐天釜山: Object.freeze({ detailColumns: LOTTE_BUSAN_DETAIL_COLUMNS, billingColumns: BILLING_COLUMNS }),
  爱宝客: Object.freeze({ detailColumns: AIBAO_DETAIL_COLUMNS, billingColumns: BILLING_COLUMNS }),
  济州新罗V团: Object.freeze({
    detailColumns: SHILLA_DETAIL_COLUMNS,
    billingColumns: BILLING_COLUMNS,
  }),
});

// 改造G: 5 文件夹平铺结构 (对齐样本 data_sample/新建文件夹/)
const FINAL_DIR = '最终交付包';
const RECEIPT_SUMMARY_DIR = '2_收票汇总';
const DATA_DIR = '4_最终数据';
const UNRECEIVED_DIR = '5_未收-用来补齐部分';
const PDF_DIR = '客户PDF';

const DATA_PACKAGE_DIR = '\u5ba2\u6237\u6570\u636e\u5305';
const CUSTOMER_PDF_FILENAME = '\u5ba2\u6237PDF.pdf';
const CUSTOMER_BILL_FILENAME = '\u5ba2\u6237\u8d26\u5355.xlsx';
const CUSTOMER_LEDGER_FILENAME = '\u53f0\u8d26\u660e\u7ec6.xlsx';
const CUSTOMER_MANIFEST_FILENAME = 'manifest.json';
const IMAGE_DIR = '\u56fe\u7247';
const IMAGE_KIND_DIRS = {
  passport: '\u62a4\u7167',
  receipt: '\u5c0f\u7968',
  ticket: '\u673a\u7968',
  other: '\u5176\u4ed6',
};
// ── 交付说明.txt(0729 静默排查 A1)────────────────────────────────────────
// warnings 原本只进 交付清单.json:那是给程序看的,而且只勾「客户数据包」时它压根不进 zip。
// 这里把同一批信息翻成人话,**按"谁该做什么"分组**——操作员打开包第一眼就知道要不要补救。
// 纯函数,直测;没有可说的返回空串(干净包不塞噪音,与多模式交付包同规矩)。
const FINAL_WARNING_SPECS = Object.freeze([
  {
    types: ['image_source_missing'],
    title: '客户资料缺图·交付前必看',
    line: (w) => `${w.customer || '(无名)'}${w.passportNo ? ` / ${w.passportNo}` : ''}`,
    hint: '这些客户的原图在系统里取不到,他们的资料包/PDF 里少了图。找回原图后重新导出即可补齐。',
  },
  {
    types: ['image_embed_failed'],
    title: '图片没能放进 PDF',
    line: (w) => `${w.customer || '(无名)'}${w.image ? `(${w.image})` : ''}${w.message ? ` —— ${w.message}` : ''}`,
    hint: '图在系统里有,但写进 PDF 时失败了。重新导出通常能解决;仍失败请报运维。',
  },
  {
    types: ['customer_bill_missing'],
    title: '客户账单缺失（用了空壳表）',
    line: (w) => `${w.customer || '(无名)'}${w.passportNo ? ` / ${w.passportNo}` : ''}`,
    hint: '这些客户的账单文件没找到,包里那张是空表——**别直接发给客户**,先确认账单是否真的没生成。',
  },
  {
    types: ['backfill_customer_skipped'],
    title: '未收补录客户·没出 PDF',
    line: (w) => `${w.customer || '(无名)'}${w.passportNo ? ` / ${w.passportNo}` : ''}`,
    hint: '这些客户的行全部来自「未收补录」,按规则不出客户 PDF。属正常,列出来只是让你知道包里为什么没有他们。',
  },
  {
    types: ['cjk_font_missing', 'cjk_font_register_failed'],
    title: '中文字体不可用·PDF 里的中文会变方块',
    line: (w) => (w.customer ? `${w.customer}${w.passportNo ? ` / ${w.passportNo}` : ''}` : (w.message || '字体注册失败')),
    hint: '服务器上的中文字体没装好/没读到。这批 PDF 的中文显示不正常,请报运维装字体后重导,别直接发出去。',
  },
  {
    types: ['received_receipt_summary_failed', 'unreceived_export_failed'],
    title: '有一整份表没能生成',
    line: (w) => `${w.type === 'unreceived_export_failed' ? '未收清单' : '收票汇总'}:${w.message || '未知原因'}`,
    hint: '这份表在本次交付包里是**缺的**。请先解决报错再重新导出,不要按现在这个包去对账。',
  },
]);

function buildFinalDeliveryNotes({ workspaceKey = '', producedAt = '', warnings = [] } = {}) {
  const list = (Array.isArray(warnings) ? warnings : []).filter((w) => w && typeof w === 'object');
  if (!list.length) return '';
  const lines = [
    '最终交付包 · 导出说明(系统自动生成)',
    `工作区 ${workspaceKey}${producedAt ? ` · 生成于 ${producedAt}` : ''}`,
    '',
    '本次导出有以下情况需要你知道。没列到的部分一切正常。',
    '',
  ];
  for (const spec of FINAL_WARNING_SPECS) {
    const hit = list.filter((w) => spec.types.includes(String(w.type || '')));
    if (!hit.length) continue;
    lines.push(`【${spec.title}】共 ${hit.length} 条`);
    for (const w of hit.slice(0, 30)) lines.push(`  - ${spec.line(w)}`);
    if (hit.length > 30) lines.push(`  …等共 ${hit.length} 条(完整名单见 交付清单.json)`);
    lines.push(`  ${spec.hint}`);
    lines.push('');
  }
  // 没有匹配到任何已知类型 = 新增了 warning 却没在这里登记。宁可报"有未知情况"也不装作没有,
  // 否则以后新增的 warning 又会退回"只写进 JSON、没人看见"的老路。
  const known = new Set(FINAL_WARNING_SPECS.flatMap((s) => s.types));
  const unknown = list.filter((w) => !known.has(String(w.type || '')));
  if (unknown.length) {
    lines.push(`【其它情况】共 ${unknown.length} 条(说明模板还没覆盖这些类型,请看 交付清单.json)`);
    for (const w of unknown.slice(0, 10)) lines.push(`  - ${w.type || '(无类型)'}`);
    lines.push('');
  }
  return lines.join('\n');
}

function createFinalDeliveryExportService({
  db,
  customerLibraryRepository = null,
  batchRepository = null,
  userService = null,
  receivedReceiptExportService = null,
  unreceivedExportService = null,
  // 已注入的对账服务(含 unreceivedResolutionRepo)→ 交付包未收清单也应用「已核销」过滤,
  // 与 UI 列表/单项导出口径一致;未传则按 db 兜底(不过滤)。
  customerReconciliationService = null,
}) {
  if (!db) throw new Error('final_delivery_export_service: db required');

  // 改造G: 2_收票汇总 / 5_未收 子服务,未注入时按 db 兜底构造。
  const receivedService = receivedReceiptExportService
    || createReceivedReceiptExportService({ db, userService });
  const unreceivedService = unreceivedExportService
    || createUnreceivedExportService({ db, customerReconciliationService });

  function checkReadiness({ workspaceKey }) {
    if (!workspaceKey) throw new Error('workspaceKey required');
    const eligibleRows = countEligible(workspaceKey);
    const excluded = {
      unreceivedRows: scalar(`
        SELECT COUNT(1) AS n
        FROM monthly_data
        WHERE workspace_key = ? AND is_unmatched = 1
      `, workspaceKey),
      // 未收「明细行」(上一项)按商品行计;这里再给「张数」(distinct 小票),让 UI 能标清
      // 单位差异 —— 34,493 条明细行 ≈ N 张未收小票,与未收清单页(按张)口径对齐。
      unreceivedReceipts: scalar(`
        SELECT COUNT(1) AS n FROM (
          SELECT DISTINCT receipt_no, passport_no
          FROM monthly_data
          WHERE workspace_key = ? AND is_unmatched = 1
        )
      `, workspaceKey),
      dailyWithoutBill: scalar(`
        SELECT COUNT(1) AS n
        FROM monthly_data
        WHERE workspace_key = ?
          AND is_unmatched = 0
          AND store_bill_id IS NULL
          AND COALESCE(is_brand_activity, 0) = 0
      `, workspaceKey),
      billOnlyRows: scalar(`
        SELECT COUNT(1) AS n
        FROM monthly_data
        WHERE workspace_key = ?
          AND is_unmatched = 0
          AND daily_receipt_id IS NULL
          AND store_bill_id IS NOT NULL
          AND COALESCE(is_brand_activity, 0) = 0
      `, workspaceKey),
      // missing_rebate 只卡「匹配上的销售行」(daily_receipt_id 非空):这类行有台账有账单
      // 却算不出返点,是真错误,必须拦。退货/品牌等 bill-only 行(daily_receipt_id 为空)
      // 即便返点为空也不硬卡整月交付——它们是冲减/加项,缺返点属数据质量提示而非阻断。
      missingRebate: scalar(`
        SELECT COUNT(1) AS n
        FROM monthly_data
        WHERE workspace_key = ?
          AND is_unmatched = 0
          AND store_bill_id IS NOT NULL
          AND daily_receipt_id IS NOT NULL
          AND customer_rebate_krw IS NULL
          AND customer_rebate_usd IS NULL
      `, workspaceKey),
      openPendingReviews: scalar(`
        SELECT COUNT(1) AS n
        FROM pending_review pr
        WHERE pr.workspace_key = ? AND pr.status = 'open'
          AND ${ACTIONABLE_PENDING_REVIEW_SQL}
      `, workspaceKey),
    };
    const blocking = [];
    if (excluded.openPendingReviews > 0) blocking.push('open_pending_reviews');
    if (excluded.missingRebate > 0) blocking.push('missing_rebate');
    if (eligibleRows <= 0) blocking.push('no_eligible_rows');
    const warnings = [];
    if (excluded.unreceivedRows > 0) warnings.push('unreceived_rows_excluded');
    if (excluded.dailyWithoutBill > 0) warnings.push('daily_without_bill_excluded');
    if (excluded.billOnlyRows > 0) warnings.push('bill_only_rows_excluded');
    // merged:本月是否已生成过交付数据(monthly_data 有行)。交付页据此判断是否需要先 merge,
    // 且只在「从未 merge(=0 行)」时自动补 merge,已 merge 过则不重跑(保护人工逐行修改)。
    const mergedRows = scalar(`
      SELECT COUNT(1) AS n FROM monthly_data WHERE workspace_key = ?
    `, workspaceKey);
    // 派生脏标记:非空 = 上游变过、当前 monthly_data/导出已过期(出包前应 ensureFresh)
    const dirtyRow = db.prepare(
      'SELECT derivation_dirty_from AS dirtyFrom FROM monthly_workspace WHERE workspace_key = ?'
    ).get(workspaceKey);
    return {
      ok: blocking.length === 0,
      workspaceKey,
      eligibleRows,
      merged: mergedRows > 0,
      mergedRows,
      derivationDirtyFrom: dirtyRow?.dirtyFrom || null,
      excluded,
      blocking,
      warnings,
    };
  }

  async function run({ workspaceKey, outputDir, operator = 'system' }) {
    if (!workspaceKey || !outputDir) throw new Error('workspaceKey and outputDir required');
    const readiness = checkReadiness({ workspaceKey });
    if (!readiness.ok) {
      const error = new Error('final delivery blocked');
      error.code = 'FINAL_DELIVERY_BLOCKED';
      error.status = 400;
      error.readiness = readiness;
      throw error;
    }

    const packageDir = path.join(outputDir, `${sanitizeFileName(workspaceKey)}_${FINAL_DIR}`);
    resetDir(packageDir);
    const receiptSummaryDir = path.join(packageDir, RECEIPT_SUMMARY_DIR);
    const dataDir = path.join(packageDir, DATA_DIR);
    const unreceivedDir = path.join(packageDir, UNRECEIVED_DIR);
    const pdfRoot = path.join(packageDir, PDF_DIR);
    const dataPackageRoot = path.join(packageDir, DATA_PACKAGE_DIR);
    ensureDir(receiptSummaryDir);
    ensureDir(dataDir);
    ensureDir(unreceivedDir);
    ensureDir(pdfRoot);
    ensureDir(dataPackageRoot);

    const files = [];
    const customerPdfs = [];
    const dataPackages = [];
    const allRows = [];
    const warnings = [];
    const customerLookup = createCustomerLookup({ customerLibraryRepository, batchRepository });

    // 2_收票汇总:复用已实现的 received_receipt_export (按 worker 分 sheet)。
    try {
      const summary = await receivedService.run({ workspaceKey, outputDir: receiptSummaryDir, operator });
      const summaryFiles = Array.isArray(summary?.files) ? summary.files : [];
      for (const f of summaryFiles) {
        files.push({ kind: 'received_receipt_summary', folder: null, path: f.path || f, rows: f.rows || 0 });
      }
    } catch (error) {
      warnings.push({ type: 'received_receipt_summary_failed', message: error.message });
    }

    for (const folder of allFolders()) {
      // 「不用记」行整行不进任何导出产物(2026-07-24 用户拍板):台账仍保留(避免未收误催),
      // 只在导出出口按 mode_raw 过滤。过滤后某桶可能为空 → 下面 !rows.length 直接跳过(容忍空桶)。
      const rows = listEligibleRows({ workspaceKey, folder })
        .filter((row) => !isNoRecordMode(row.mode_raw));
      if (!rows.length) continue;
      allRows.push(...rows);

      const dataPath = path.join(dataDir, `${sanitizeFileName(folder)}-最终数据.xlsx`);
      await writeFinalDataWorkbook({ filePath: dataPath, rows, folder });
      files.push({ kind: 'final_data', folder, path: dataPath, rows: rows.length });

      const receiptPath = path.join(dataDir, buildExportFilename(workspaceKey, folder, '收据单'));
      const receiptRows = await writeReceiptWorkbook({ filePath: receiptPath, rows, workspaceKey, folder });
      files.push({ kind: 'receipt_workbook', folder, path: receiptPath, rows: receiptRows });

      const pdfDir = path.join(pdfRoot, sanitizeFileName(folder));
      ensureDir(pdfDir);
      for (const customer of groupRowsByCustomer(rows)) {
        // 未收补录(bill_backfill)的客户没有实物小票/照片,收款凭证类产物业务上
        // 不成立:全部行都来自补录的客户跳过 PDF/客户文件夹,只进上面的四桶数据。
        // 混合客户(部分小票收到了)照常生成,PDF 明细含补录行。
        const allBackfill = customer.rows.every((r) => r.trace_daily_source_type === 'bill_backfill');
        if (allBackfill) {
          warnings.push({ type: 'backfill_customer_skipped', customer: customer.name, passportNo: customer.passportNo });
          continue;
        }
        const assets = resolveCustomerAssets(customer, customerLookup);
        const pdfPath = path.join(pdfDir, `${sanitizeFileName(customer.fileName)}.pdf`);
        const pdfResult = await writeCustomerPdf({ filePath: pdfPath, customer, workspaceKey, folder, assets });
        customerPdfs.push({
          kind: 'customer_pdf',
          folder,
          path: pdfPath,
          rows: customer.rows.length,
          imageCount: pdfResult.imageCount,
        });

        const dataPackageDir = path.join(dataPackageRoot, sanitizeFileName(folder), sanitizeFileName(customer.fileName));
        const packageResult = await writeCustomerDataPackage({
          targetDir: dataPackageDir,
          customer,
          assets,
          pdfPath,
        });
        dataPackages.push({
          kind: 'customer_data_package',
          folder,
          path: dataPackageDir,
          rows: customer.rows.length,
          imageCount: packageResult.imageCount,
          billCount: packageResult.billCount,
        });
        warnings.push(...customer.warnings, ...pdfResult.warnings, ...packageResult.warnings);
      }
    }

    // 5_未收-用来补齐部分:未收清单 + 4 团二轮收票模板。
    let unreceivedResult = null;
    try {
      unreceivedResult = await unreceivedService.exportForWorkspace({ workspaceKey, outputDir: unreceivedDir });
      for (const f of unreceivedResult.files) {
        files.push({ kind: f.kind, folder: f.folder, path: f.path, rows: f.rows });
      }
    } catch (error) {
      warnings.push({ type: 'unreceived_export_failed', message: error.message });
    }

    const manifestPath = path.join(packageDir, '交付清单.json');
    const manifest = {
      workspaceKey,
      producedAt: new Date().toISOString(),
      operator,
      eligibleRows: readiness.eligibleRows,
      excluded: readiness.excluded,
      warnings,
      files: files.map(publicFileInfo),
      customerPdfCount: customerPdfs.length,
      dataPackageCount: dataPackages.length,
      unreceivedRows: unreceivedResult?.unreceivedRows ?? 0,
      directoryMapping: {
        samplePath: 'data_sample/新建文件夹/',
        outputPath: `${FINAL_DIR}/`,
        mapping: {
          '2.收票汇总/': `${RECEIPT_SUMMARY_DIR}/`,
          '4.最终数据√/': `${DATA_DIR}/`,
          '5.未收-用来补齐部分/': `${UNRECEIVED_DIR}/`,
          '客户PDF/': `${PDF_DIR}/`,
          '客户数据包/': `${DATA_PACKAGE_DIR}/`,
        },
      },
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    files.push({ kind: 'manifest', folder: null, path: manifestPath, rows: allRows.length });

    // 0729 静默排查 A1:warnings 这七类(护照图缺失/字体缺失/客户账单缺失/补录客户跳过 PDF/
    // 收票汇总失败/未收导出失败/图片嵌入失败)原本只躺在 交付清单.json 里,而
    //   ① run() 返回值不带它 → 路由无从转发 → 前端只看到一个干净的成功页;
    //   ② 只勾「客户数据包」下载时,交付清单.json 属于 data 组,**根本不进那个 zip**。
    // 结果是交付出去的资料包安静地缺东西,等客户自己发现少了什么再回来找。
    // 两头都补:返回值带上 warnings;另写一份人能直接读的说明,且**任何勾选组合都带它**。
    const notesPath = path.join(packageDir, '交付说明.txt');
    const notesText = buildFinalDeliveryNotes({ workspaceKey, producedAt: manifest.producedAt, warnings });
    if (notesText) fs.writeFileSync(notesPath, `\uFEFF${notesText}`, 'utf8'); // BOM 防中文乱码

    return {
      workspaceKey,
      outputDir: packageDir,
      producedAt: manifest.producedAt,
      readiness,
      files,
      customerPdfs,
      dataPackages,
      manifestPath,
      warnings,
      notesPath: notesText ? notesPath : '',
    };
  }

  function scalar(sql, workspaceKey) {
    return Number(db.prepare(sql).get(workspaceKey)?.n || 0);
  }

  function countEligible(workspaceKey) {
    // 必须与导出口径一致:run() 只按 allFolders() 的 4 个固定桶 listEligibleRows。
    // 若 readiness 不限定 mode_folder,落在 4 桶外/空 folder 的行会被计入 eligibleRows
    // 却不出现在任何 *-最终数据.xlsx → readiness 显示 N 行但实际导出 M<N,客户少拿数据。
    const folders = allFolders();
    const placeholders = folders.map(() => '?').join(', ');
    return Number(
      db.prepare(`
        SELECT COUNT(1) AS n
        FROM monthly_data
        WHERE workspace_key = ?
          AND is_unmatched = 0
          AND mode_folder IN (${placeholders})
          AND (daily_receipt_id IS NOT NULL OR COALESCE(is_brand_activity, 0) = 1)
          AND (store_bill_id IS NOT NULL OR COALESCE(is_brand_activity, 0) = 1)
          AND (customer_rebate_krw IS NOT NULL OR customer_rebate_usd IS NOT NULL)
      `).get(workspaceKey, ...folders)?.n || 0
    );
  }

  function listEligibleRows({ workspaceKey, folder }) {
    return db.prepare(`
      SELECT md.*,
             md.id AS trace_monthly_data_id,
             md.daily_receipt_id AS trace_daily_receipt_id,
             md.store_bill_id AS trace_store_bill_id,
             d.source_customer_id AS trace_source_customer_id,
             d.source_customer_id AS source_customer_id,
             d.source_type AS trace_daily_source_type,
             d.source_batch_id AS trace_source_batch_id,
             d.source_task_id AS trace_source_task_id,
             d.source_file AS trace_daily_source_file,
             d.source_sheet AS trace_daily_source_sheet,
             d.source_row AS trace_daily_source_row,
             b.source_file AS trace_bill_source_file,
             b.source_sheet AS trace_bill_source_sheet,
             b.source_row AS trace_bill_source_row,
             b.raw_payload AS trace_bill_raw_payload,
             d.receipt_date AS trace_daily_receipt_date,
             d.modified_by AS trace_daily_modified_by,
             d.agent_code AS trace_daily_agent_code,
             l.id AS trace_match_log_id,
             l.match_key AS trace_match_key
      FROM monthly_data md
      LEFT JOIN daily_receipt_export d
        ON d.workspace_key = md.workspace_key AND d.id = md.daily_receipt_id
      LEFT JOIN store_bill b
        ON b.workspace_key = md.workspace_key AND b.id = md.store_bill_id
      LEFT JOIN bill_match_log l
        ON l.id = (
          SELECT l2.id
          FROM bill_match_log l2
          WHERE l2.workspace_key = md.workspace_key
            AND (
              (md.daily_receipt_id IS NOT NULL AND l2.daily_receipt_id = md.daily_receipt_id)
              OR (md.store_bill_id IS NOT NULL AND l2.store_bill_id = md.store_bill_id)
            )
          ORDER BY l2.id DESC
          LIMIT 1
        )
      WHERE md.workspace_key = ?
        AND md.mode_folder = ?
        AND md.is_unmatched = 0
        AND (md.daily_receipt_id IS NOT NULL OR COALESCE(md.is_brand_activity, 0) = 1)
        AND (md.store_bill_id IS NOT NULL OR COALESCE(md.is_brand_activity, 0) = 1)
        AND (md.customer_rebate_krw IS NOT NULL OR md.customer_rebate_usd IS NOT NULL)
      ORDER BY md.passport_no, md.name, md.id
    `).all(workspaceKey, folder);
  }

  return { checkReadiness, run };
}

// 最终数据 xlsx 使用未来稳定通用模板:客户汇总 / 明细 / 小票 / 做账单。
// 各桶可有不同明细列,但不再按月份切换 sheet 名或列结构。
async function writeFinalDataWorkbook({ filePath, rows, folder }) {
  if (fs.existsSync(filePath)) {
    try { fs.unlinkSync(filePath); } catch { /* best-effort cleanup */ }
  }
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: filePath,
    useStyles: true,
    useSharedStrings: true,
  });
  const template = finalTemplateForFolder(folder);
  writeSummarySheet(workbook, rows, {
    sheetName: template.summarySheetName || '客户汇总',
    columns: template.summaryColumns || SUMMARY_COLUMNS,
  });
  writeArraySheet(workbook, template.detailSheetName || '明细', template.detailColumns, rows, { rawFirst: true });
  if (template.receiptSheetName !== null) {
    writeReceiptSheet(workbook, rows, {
      sheetName: template.receiptSheetName || '小票',
      columns: template.receiptColumns || RECEIPT_COLUMNS,
    });
  }
  writeArraySheet(workbook, template.billingSheetName || '做账单', template.billingColumns, rows, { rawFirst: true });
  await workbook.commit();
}

// 流式:创建一个套了统一样式的表格 sheet(冻结表头/自动筛选/横向窄边距打印+表头每页重复),
// 并把「自动生成的表头行」就地上样式后 commit。返回逐行写正文所需的 types/columnCount。
// 只加视觉层:列定义经 styledColumnDefs 保留列宽/numFmt,表头值仍取自各列 header(不改)。
function beginStyledDataSheet(workbook, name, columns) {
  const columnCount = columns.length;
  // views 必须在 addWorksheet 时传入:流式 writer 在构造函数即写出 sheetViews,事后再设无效。
  const sheet = workbook.addWorksheet(name, {
    views: [{ state: 'frozen', xSplit: 0, ySplit: 1 }], // 冻结表头(freezeCols=0:首列非序号/客户组/编号)
    autoFilter: { from: { row: 1, column: 1 }, to: { row: 1, column: columnCount } },
    pageSetup: {
      orientation: 'landscape',
      horizontalCentered: true,
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      printTitlesRow: '1:1', // 表头每页重复
      margins: { left: 0.3, right: 0.3, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
    },
  });
  // 设列定义会用各列 header 自动填充第 1 行(exceljs 行为),故不再另行 addRow(表头)。
  sheet.columns = styledColumnDefs(columns);
  const headerRow = sheet.getRow(1);
  styleHeaderRowInPlace(headerRow, columnCount);
  headerRow.commit();
  return { sheet, types: resolveColumnTypes(columns), columnCount };
}

function writeArraySheet(workbook, name, columns, rows, options = {}) {
  const { sheet, types, columnCount } = beginStyledDataSheet(workbook, name, columns);
  let dataIndex = 0;
  for (const row of rows) {
    dataIndex += 1;
    const dataRow = sheet.addRow(columns.map((col) => valueForColumn(row, col, options)));
    styleBodyRowInPlace(dataRow, { types, dataIndex, columnCount });
    dataRow.commit();
  }
  sheet.commit();
}

function writeSummarySheet(workbook, rows, { sheetName = '客户汇总', columns = SUMMARY_COLUMNS } = {}) {
  const { sheet, types, columnCount } = beginStyledDataSheet(workbook, sheetName, columns);
  let dataIndex = 0;
  for (const customer of groupRowsByCustomer(rows).sort((a, b) => a.name.localeCompare(b.name))) {
    const row = {
      name: customer.name,
      full_name: customer.fullName || customer.name,
      passport_no: customer.passportNo,
      departure_date: customer.latestDepartureDate,
      customer_rebate_krw: customer.totalRebateKrw,
    };
    dataIndex += 1;
    const dataRow = sheet.addRow(columns.map((col) => valueForColumn(row, col)));
    styleBodyRowInPlace(dataRow, { types, dataIndex, columnCount });
    dataRow.commit();
  }
  sheet.commit();
}

// 按 receipt_no 聚合:同一小票多商品行 → 打票表 1 行。
function writeReceiptSheet(workbook, rows, { sheetName = '小票', columns = RECEIPT_COLUMNS } = {}) {
  const map = new Map();
  for (const row of rows) {
    const key = row.receipt_no || '';
    if (!map.has(key)) {
      map.set(key, {
        receipt_no: formatMonthlyReceiptNo(row),
        agent: valueForColumn(row, c('代理', 'agent')) || '',
        departure_date: valueForColumn(row, c('出境日期', 'departure_date')),
        received: 1,
        name: row.name || '',
        passport_no: row.passport_no || '',
        owner: row.trace_daily_modified_by || row.trace_daily_agent_code || '',
        // 收票日期 = 我们收到并上传小票那天(客户建档日 CLyyyymmdd,KST 上传日),
        // 而非台账 receipt_date(=审核通过/结算当天)。兜底链已收进共享 helper 内部
        // (客户编号 → trace_daily_receipt_date → imported_at,0801 用户拍板);
        // 这里不再自带第二套,否则同一个"收票日期"又变回三个读法。
        receive_date: resolveCollectedDateFromLedgerRow(row) || '',
        receipt_mode_group: row.mode_raw || row.mode_folder || '',
      });
    }
  }
  writeArraySheet(workbook, sheetName, columns, Array.from(map.values()));
}

function finalTemplateForFolder(folder) {
  const fallback = DEFAULT_FINAL_TEMPLATES[folder] || DEFAULT_FINAL_TEMPLATES.乐天首尔;
  return {
    summarySheetName: '客户汇总',
    detailSheetName: '明细',
    receiptSheetName: '小票',
    receiptColumns: RECEIPT_COLUMNS,
    billingSheetName: '做账单',
    ...fallback,
  };
}

function c(header, key) {
  return { header, key };
}

function valueForColumn(row, col, options = {}) {
  const key = col.key;
  if (!key || /^blank_/.test(key)) return null;
  if (key === 'receipt_no') return formatMonthlyReceiptNo(row); // 现代补杠2-6-3-5,其余纯数字原样
  if (key === 'received') return row.received ?? 1;
  if (key === 'fixed_one') return pickRaw(row, ['1']) ?? 1;
  if (key === 'full_name') return pickRaw(row, ['完整姓名']) ?? row.full_name ?? row.name ?? null;
  if (key === 'system_name') return pickRaw(row, ['系统姓名']) ?? row.system_name ?? row.name ?? null;
  if (key === 'remark2') return pickRawStrict(row, ['备注2']);
  if (key === 'branch_purchase_tour') {
    return pickRaw(row, ['免税分店&购买日期&团号']);
  }
  if (key === 'category_tertiary') {
    return pickRaw(row, ['区分', '分类']) ?? row.category_secondary ?? row.category ?? null;
  }
  if (key === 'special') return pickRaw(row, ['1', '特殊']);
  if (key === 'owner') return row.owner || row.trace_daily_modified_by || row.trace_daily_agent_code || null;
  if (key === 'receive_date') return row.receive_date || row.trace_daily_receipt_date || null;
  if (key === 'receipt_mode_group') return row.receipt_mode_group || row.mode_raw || row.mode_folder || null;

  const rawKeys = aliasesForKey(key, col.header);
  if (options.rawFirst && !directFirstExportKey(key)) {
    const rawValue = pickRawStrict(row, rawKeys);
    if (rawValue !== undefined && rawValue !== null) return rawValue;
  }

  const direct = cellScalar(row[key]);
  if (direct !== null && direct !== '') return direct;
  return pickRaw(row, rawKeys);
}

function directFirstExportKey(key) {
  return new Set([
    'customer_points',
    'customer_rebate_krw',
    'customer_rebate_usd',
    'received',
    'owner',
    'receive_date',
    'receipt_mode_group',
  ]).has(key);
}

function aliasesForKey(key, header) {
  const aliases = {
    stmt_date: ['日期'],
    statement_date: ['出账日期'],
    payment_mode: ['付款模式'],
    mode_raw: ['返点模式', '付款模式', '模式'],
    shop: ['免税店'],
    branch: ['免税分店'],
    upstream: ['上家'],
    entry_company: ['入店公司'],
    tour_guide: ['导游'],
    agent: ['代理'],
    original_date: ['原日期'],
    purchase_date: ['购买日期'],
    tour_no: ['团号', '단체번호'],
    name: ['姓名'],
    passport_no: ['护照号', '护照'],
    departure_date: ['出境日期'],
    receipt_no: ['小票号'],
    original_receipt_no: ['原小票号'],
    category: ['分类'],
    brand: ['品牌'],
    sku: ['SKU'],
    product_name: ['产品名称'],
    ref_no: ['REF NO', 'REF_NO', 'RefNo'],
    qty: ['数量'],
    gross_usd: ['总卖出($)', '总卖出（$）'],
    gross_krw: ['总卖出(￦)', '总卖出（￦）'],
    net_usd: ['纯卖出($)', '纯卖出（$）'],
    net_krw: ['纯卖出(￦)', '纯卖出（￦）'],
    dc_usd: ['DC($)', 'DC（$）'],
    dc_krw: ['DC(￦)', 'DC（￦）'],
    discount_rate: ['折扣率', '折扣'],
    voucher_amount: ['商品券金额'],
    voucher_deduction: ['扣点商品券'],
    customer_points: ['客人点数', '点数'],
    customer_rebate_krw: ['客人返点金额', '返点金额'],
    store_base_points: ['免税店点数', '免税店基本点', '基本点', 'D基本点', 'S基本点'],
    store_base_rebate: ['免税店返点', '免税店返点金额', '基本返点', '返点', 'D基本返点'],
    store_extra_points: ['免税店追加点', '免税店追加点数', '免税店追加', '追加点', 'S追加点', 'D追加'],
    store_extra_amount: ['追加金额', '免税店追加金额', 'S追加金额', 'D追加金额'],
    store_final_rebate: ['免税店最终返点', '最终返点', '最终返点金额', 'S最终返点', 'D最终返点'],
    category_secondary: ['分类'],
    remark: ['备注'],
  };
  return aliases[key] || [header].filter(Boolean);
}

function pickRaw(row, keys) {
  const raw = rawPayload(row);
  if (!raw) return null;
  for (const key of keys || []) {
    if (!key) continue;
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      const value = cellScalar(raw[key]);
      if (value !== null && value !== '') return value;
    }
  }
  return null;
}

function pickRawStrict(row, keys) {
  const raw = rawPayload(row);
  if (!raw) return undefined;
  for (const key of keys || []) {
    if (!key) continue;
    if (Object.prototype.hasOwnProperty.call(raw, key)) return cellScalar(raw[key]);
  }
  return undefined;
}

function rawPayload(row) {
  if (!row || !row.trace_bill_raw_payload) return null;
  if (row.__billRawPayload !== undefined) return row.__billRawPayload;
  try {
    row.__billRawPayload = JSON.parse(row.trace_bill_raw_payload);
  } catch {
    row.__billRawPayload = null;
  }
  return row.__billRawPayload;
}

function cellScalar(value) {
  if (value == null) return null;
  if (typeof value === 'object') {
    if (Object.prototype.hasOwnProperty.call(value, 'result')) return cellScalar(value.result);
    if (Object.prototype.hasOwnProperty.call(value, 'text')) return cellScalar(value.text);
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text || '').join('');
  }
  return value;
}

async function writeReceiptWorkbook({ filePath, rows, workspaceKey, folder }) {
  if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Sign Workbench';
  workbook.created = new Date();

  const sheet1 = workbook.addWorksheet('Sheet1');
  sheet1.columns = [
    { header: '英文名', key: 'englishName', width: 24 },
    { header: '护照号', key: 'passportNo', width: 18 },
    { header: '支付金额', key: 'paymentAmount', width: 16, style: { numFmt: '#,##0' } },
    { header: '日期', key: 'departureDate', width: 14 },
    // 2026-06-13 中文签名下线:删除残留的 签名1/签名2 空列(从不填值,签字时代遗留)
  ];

  const customers = groupRowsByCustomer(rows);
  for (const customer of customers) {
    sheet1.addRow({
      englishName: customer.name,
      passportNo: customer.passportNo,
      paymentAmount: floorToThousand(customer.totalRebateKrw),
      departureDate: customer.latestDepartureDate,
    });
  }

  const sheet2 = workbook.addWorksheet('Sheet2');
  sheet2.columns = [
    { header: '客户名', key: 'name', width: 20 },
    { header: '英文名', key: 'englishName', width: 20 },
    { header: '护照号', key: 'passportNo', width: 18 },
    { header: '购买日期', key: 'purchaseDate', width: 14 },
    { header: '小票号', key: 'receiptNo', width: 20 },
    { header: '团号', key: 'tourNo', width: 14 },
    { header: '模式', key: 'modeFolder', width: 16 },
    { header: '纯卖出KRW', key: 'netKrw', width: 16, style: { numFmt: '#,##0' } },
    { header: '纯卖出USD', key: 'netUsd', width: 16, style: { numFmt: '#,##0.00' } },
    { header: '客人点数', key: 'customerPoints', width: 12, style: { numFmt: '0.0000' } },
    { header: '返点KRW', key: 'customerRebateKrw', width: 16, style: { numFmt: '#,##0' } },
    { header: '返点USD', key: 'customerRebateUsd', width: 16, style: { numFmt: '#,##0.00' } },
  ];
  for (const row of rows) {
    sheet2.addRow({
      name: row.name || '',
      englishName: row.name || '',
      passportNo: row.passport_no || '',
      purchaseDate: fmtDate(row.purchase_date),
      receiptNo: row.receipt_no || '',
      tourNo: row.tour_no || '',
      modeFolder: row.mode_folder || folder,
      netKrw: numberOrNull(row.net_krw),
      netUsd: numberOrNull(row.net_usd),
      customerPoints: numberOrNull(row.customer_points),
      customerRebateKrw: numberOrNull(row.customer_rebate_krw),
      customerRebateUsd: numberOrNull(row.customer_rebate_usd),
    });
  }

  const info = workbook.addWorksheet('生成说明');
  info.addRow(['工作月份', workspaceKey]);
  info.addRow(['业务桶', folder]);
  info.addRow(['客户数', customers.length]);
  info.addRow(['明细行数', rows.length]);
  info.addRow(['金额规则', 'Sheet1 支付金额按客户返点KRW合计后千位抹零']);
  await workbook.xlsx.writeFile(filePath);
  return customers.length;
}

function groupRowsByCustomer(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = `${row.passport_no || ''}|${row.name || ''}`;
    if (!map.has(key)) {
      const display = row.name || row.passport_no || `customer-${row.id}`;
      map.set(key, {
        key,
        fileName: `${display}_${row.passport_no || 'NO_PASSPORT'}`,
        name: display,
        passportNo: row.passport_no || '',
        latestDepartureDate: fmtDate(row.departure_date),
        totalRebateKrw: 0,
        totalRebateUsd: 0,
        rows: [],
        warnings: [],
      });
    }
    const customer = map.get(key);
    customer.rows.push(row);
    customer.totalRebateKrw += Number(row.customer_rebate_krw || 0);
    customer.totalRebateUsd += Number(row.customer_rebate_usd || 0);
    if (fmtDate(row.departure_date) > customer.latestDepartureDate) {
      customer.latestDepartureDate = fmtDate(row.departure_date);
    }
  }
  // 浮点累加会产生分钱漂移,客户汇总定额舍入:KRW 取整、USD 两位小数
  // 文件夹/PDF 命名对齐参照样本:「客户名 护照前4位」(空格分隔,如 BAI FEIFEI EK35)。
  // 前缀撞名时退回完整护照号、再撞加序号,保证唯一,避免一个客户的交付包覆盖另一个。
  const seenNames = new Set();
  for (const customer of map.values()) {
    customer.totalRebateKrw = Math.round(customer.totalRebateKrw || 0);
    customer.totalRebateUsd = Math.round((customer.totalRebateUsd || 0) * 100) / 100;
    const passport = customer.passportNo || 'NOPASS';
    let base = `${customer.name} ${passport.slice(0, 4)}`;
    if (seenNames.has(base)) base = `${customer.name} ${passport}`;
    let unique = base;
    let i = 2;
    while (seenNames.has(unique)) unique = `${base} (${i++})`;
    seenNames.add(unique);
    customer.fileName = unique;
  }
  return Array.from(map.values());
}

function parseWsYearMonth(workspaceKey) {
  const m = /(\d{4})-(\d{2})/.exec(String(workspaceKey || ''));
  if (!m) return { yy: '', mm: '', fullYear: '' };
  return { yy: m[1].slice(2), mm: String(Number(m[2])), fullYear: m[1] };
}

function splitYmd(dateStr) {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr || ''));
  if (!m) return null;
  return { y: m[1], m: String(Number(m[2])), d: String(Number(m[3])) };
}

// 画带边框的明细表(landscape 页),自动翻页;每格小字。
function drawGridTable(doc, { x, cols, rows, useCjk, headerFs = 8, rowFs = 8 }) {
  const rowH = 18;
  const bottomMargin = 36;
  let y = doc.y;
  const drawHeader = () => {
    let cx = x;
    doc.lineWidth(0.6);
    for (const c of cols) {
      doc.rect(cx, y, c.w, rowH).stroke();
      doc.fontSize(headerFs).text(String(c.h), cx + 2, y + 5, { width: c.w - 4, align: 'center' });
      cx += c.w;
    }
    y += rowH;
  };
  if (useCjk) doc.font('CN');
  drawHeader();
  for (const r of rows) {
    if (y + rowH > doc.page.height - bottomMargin) {
      doc.addPage({ size: 'A4', layout: 'landscape' });
      if (useCjk) doc.font('CN');
      y = doc.y;
      drawHeader();
    }
    let cx = x;
    doc.lineWidth(0.6);
    for (const c of cols) {
      doc.rect(cx, y, c.w, rowH).stroke();
      const v = c.k(r);
      if (v != null && v !== '') {
        doc.fontSize(rowFs).text(String(v), cx + 2, y + 5, { width: c.w - 4, align: c.align || 'left' });
      }
      cx += c.w;
    }
    y += rowH;
  }
  doc.y = y + 6;
}

// 改造H: 客户 PDF 中文化。CJK 字体来源优先级:项目 assets/fonts → 随包 paddleocr 字体 → Windows 系统字体。
// 不把 10MB 字体二进制提交进仓库,改为运行时解析第一个存在的候选路径。
const CJK_FONT_CANDIDATES = Object.freeze([
  // 客户 PDF 标题/声明含韩文(수수료 수령증),字体必须同时覆盖 Hangul + 汉字。
  // NotoSansSC/simfang/Deng 均无谚文字形,会把韩文渲染成方框 — 优先 Noto Sans CJK。
  '/opt/sign-data/fonts/NotoSansCJK-Regular.ttf', // 服务器持久数据目录(不随 release 切换)
  path.join(__dirname, '../../assets/fonts/NotoSansCJK-Regular.ttf'),
  'C:/Windows/Fonts/NotoSansCJKkr-Regular.ttf', // 本地开发机
  path.join(__dirname, '../../assets/fonts/NotoSansSC-Regular.ttf'),
  path.join(__dirname, '../../assets/fonts/cjk.ttf'),
  path.join(__dirname, '../../paddleocr_standalone/training/vendor/PaddleOCR-v2.9.1/doc/fonts/simfang.ttf'),
  'C:/Windows/Fonts/simfang.ttf',
  'C:/Windows/Fonts/Deng.ttf',
]);

let cjkFontPathCache;
function resolveCjkFontPath() {
  if (cjkFontPathCache !== undefined) return cjkFontPathCache;
  cjkFontPathCache = null;
  for (const candidate of CJK_FONT_CANDIDATES) {
    try {
      if (candidate && fs.existsSync(candidate)) {
        cjkFontPathCache = candidate;
        break;
      }
    } catch { /* ignore unreadable candidate */ }
  }
  return cjkFontPathCache;
}

function writeCustomerPdf({ filePath, customer, workspaceKey, assets = {} }) {
  return new Promise((resolve, reject) => {
    const warnings = [];
    let imageCount = 0;
    const doc = new PDFDocument({ size: 'A4', margin: 48 });
    const out = fs.createWriteStream(filePath);
    out.on('finish', () => resolve({ imageCount, warnings }));
    out.on('error', reject);
    doc.on('error', reject);
    doc.pipe(out);

    const cjkFontPath = resolveCjkFontPath();
    let useCjk = false;
    if (cjkFontPath) {
      try {
        doc.registerFont('CN', cjkFontPath);
        doc.font('CN');
        useCjk = true;
      } catch (error) {
        warnings.push({ type: 'cjk_font_register_failed', message: error.message });
      }
    }
    if (!useCjk) {
      warnings.push({ type: 'cjk_font_missing', customer: customer.name, passportNo: customer.passportNo });
    }
    // CJK 字体可用时直接输出中文;否则降级为 ASCII 标签,并把非 ASCII 字符替换为 ?。
    const label = (zh, en) => (useCjk ? zh : en);
    const txt = (value) => (useCjk ? String(value ?? '') : safePdfText(value));

    // 单元格:画边框 + 居中文本(对齐参照「수수료 수령증/收款凭证」样式)
    const cell = (x, y0, w, h, text, { fs = 11, align = 'left' } = {}) => {
      doc.lineWidth(0.8).rect(x, y0, w, h).stroke();
      if (text != null && text !== '') {
        doc.fontSize(fs);
        const lines = String(text).split('\n').length;
        const ty = y0 + (h - lines * doc.currentLineHeight()) / 2;
        doc.text(String(text), x + 6, ty, { width: w - 12, align });
      }
    };

    // ── 第 1 页:收款凭证(수수료 수령증)──────────────────────
    // 标题两行均 18 号粗体居中,对齐样本 账单-*.xlsx 수령증 sheet R4/R5
    const { yy, mm } = parseWsYearMonth(workspaceKey);
    // 「월」漏在 label() 外面了(2026-08-01):没有 CJK 字体时 useCjk=false,
    // 整行里别的字都降级成了英文,只有这个韩文字符被原样丢给 pdfkit 默认的
    // Helvetica(WinAnsi 编码)—— 渲染成 .notdef 方块/乱码。
    // 这条本机永远看不见:8 个字体候选里 Windows 那三个必命中,useCjk 恒为 true;
    // 而仓库里**一个字体文件都没有**(git ls-files 查 ttf/otf/ttc = 0),
    // 所以 Linux/CI 上恒走降级分支 —— 两边各跑一半,谁也覆盖不到对方。
    doc.fontSize(18).text(
      `${yy}.${mm}${label('월', '/')} ${label('수수료 수령증', 'Fee Receipt')}`,
      { align: 'center' },
    );
    doc.fontSize(18).text(label('(收款凭证)', '(Receipt)'), { align: 'center' });
    doc.moveDown(1.2);

    const left = 70;
    const cw = [95, 180, 180]; // 收款人 | 标签 | 值
    const rh = 52;
    const amtH = 46;
    let ty0 = doc.y;
    const x0 = left, x1 = left + cw[0], x2 = left + cw[0] + cw[1];
    // 左侧「수령인(收款人)」合并跨 3 行
    cell(x0, ty0, cw[0], rh * 3, label('수령인\n(收款人)', 'Payee'), { align: 'center' });
    const infoRows = [
      [label('성명(姓名)', 'Name'), txt(customer.name)],
      [label('주민번호/여권번호\n(身份证号码/护照号码)', 'ID/Passport No.'), txt(customer.passportNo)],
      [label('연락처(联系电话)', 'Tel'), ''],
    ];
    infoRows.forEach((r, i) => {
      const ry = ty0 + rh * i;
      cell(x1, ry, cw[1], rh, r[0], { fs: 10, align: 'left' });
      cell(x2, ry, cw[2], rh, r[1], { fs: 11, align: 'left' });
    });
    ty0 += rh * 3;
    // 付款金额(千位抹零)
    const payable = floorToThousand(customer.totalRebateKrw);
    cell(x0, ty0, cw[0] + cw[1], amtH, label('현금 지급금액(付款金额)', 'Cash Paid'), { fs: 12, align: 'center' });
    cell(x2, ty0, cw[2], amtH, payable.toLocaleString('en-US'), { fs: 13, align: 'right' });
    ty0 += amtH;

    // 画完表格后 doc.x 停在最后一个单元格(偏右),复位到左边距,
    // 否则下面 align:'center' 只在「当前x→右边距」间居中,声明/日期/签字会整体偏右(不居中)。
    doc.x = doc.page.margins.left;
    doc.y = ty0 + 26;
    doc.fontSize(11).text(label('상기 금액을 이상없이 수령하였기에 서명, 날인합니다.', 'Received the above amount in full.'), { align: 'center' });
    if (useCjk) doc.text('今收到上述收款金额，特此收据。', { align: 'center' });
    doc.moveDown(1.6);
    const ymd = splitYmd(customer.latestDepartureDate) || splitYmd(fmtDate(`${parseWsYearMonth(workspaceKey).fullYear}-${mm}-01`));
    if (ymd) {
      doc.fontSize(12).text(`${ymd.y}${label('년', '/')}        ${ymd.m}${label('월', '/')}        ${ymd.d}${label('일', '')}`, { align: 'center' });
    }
    doc.moveDown(2.4);
    // 签字横线(留空给客户手签,不放任何签名)
    doc.fontSize(12).text(`${label('수령자(收款人签字)', 'Signature')} : ________________________        (${label('인', 'seal')})`, { align: 'center' });

    // ── 第 2 页:小票明细表(landscape)── 运营要求:明细紧跟收款凭证放第二页(图片在后)
    doc.addPage({ size: 'A4', layout: 'landscape' });
    if (useCjk) doc.font('CN');
    doc.fontSize(13).text(label('小票明细', 'Receipt Detail'));
    doc.moveDown(0.4);
    // 15 列对齐样本 账单-*.xlsx 明细 sheet:补 总卖出($)/纯卖出($),客人点数按
    // 样本显示原始小数(0.34)而非百分比。
    const num = (v) => (v == null || v === '' ? '' : Number(v).toLocaleString('en-US'));
    const dec = (v) => (v == null || v === '' ? '' : String(Number(v)));
    const cols = [
      { h: label('返点模式', 'mode'), w: 50, k: (r) => txt(r.mode_folder || r.mode_raw || '') },
      { h: label('免税分店', 'branch'), w: 48, k: (r) => txt(r.branch || '') },
      { h: label('购买日期', 'purchase'), w: 52, k: (r) => txt(fmtDate(r.purchase_date)) },
      { h: label('团号', 'tour'), w: 42, k: (r) => txt(r.tour_no || '') },
      { h: label('姓名', 'name'), w: 64, k: (r) => txt(r.name || '') },
      { h: label('护照号', 'passport'), w: 62, k: (r) => txt(r.passport_no || '') },
      { h: label('小票号', 'receipt'), w: 80, k: (r) => txt(r.receipt_no || '') },
      { h: label('品牌', 'brand'), w: 62, k: (r) => txt(r.brand || '') },
      { h: label('数量', 'qty'), w: 26, align: 'right', k: (r) => num(r.qty) },
      { h: label('总卖出($)', 'gross$'), w: 48, align: 'right', k: (r) => num(r.gross_usd) },
      { h: label('总卖出(￦)', 'gross'), w: 60, align: 'right', k: (r) => num(r.gross_krw) },
      { h: label('纯卖出($)', 'net$'), w: 48, align: 'right', k: (r) => num(r.net_usd) },
      { h: label('纯卖出(￦)', 'net'), w: 60, align: 'right', k: (r) => num(r.net_krw) },
      { h: label('客人点数', 'pts'), w: 36, align: 'right', k: (r) => dec(r.customer_points) },
      { h: label('客人返点金额', 'rebate'), w: 56, align: 'right', k: (r) => num(r.customer_rebate_krw) },
    ];
    drawGridTable(doc, { x: 24, cols, rows: customer.rows, useCjk });

    // ── 第 3 页起:图片证明(护照/航班/小票,各一页)
    const images = Array.isArray(assets.images) ? assets.images : [];
    if (!images.length) {
      warnings.push({ type: 'image_source_missing', customer: customer.name, passportNo: customer.passportNo });
    } else {
      for (const image of images) {
        try {
          doc.addPage({ size: 'A4' });
          if (useCjk) doc.font('CN');
          doc.fontSize(11).text(`${image.kind.toUpperCase()} - ${txt(image.label)}`);
          doc.moveDown(0.4);
          doc.image(image.path, { fit: [480, 640], align: 'center', valign: 'center' });
          imageCount += 1;
        } catch (error) {
          warnings.push({ type: 'image_embed_failed', customer: customer.name, passportNo: customer.passportNo, image: image.label, message: error.message });
        }
      }
    }
    doc.end();
  });
}

async function writeCustomerDataPackage({ targetDir, customer, assets = {}, pdfPath }) {
  resetDir(targetDir);
  const warnings = [];
  let billCount = 0;

  if (pdfPath && fs.existsSync(pdfPath)) {
    fs.copyFileSync(pdfPath, path.join(targetDir, CUSTOMER_PDF_FILENAME));
  }

  if (assets.billPath && fs.existsSync(assets.billPath)) {
    fs.copyFileSync(assets.billPath, path.join(targetDir, CUSTOMER_BILL_FILENAME));
    billCount = 1;
  } else {
    warnings.push({ type: 'customer_bill_missing', customer: customer.name, passportNo: customer.passportNo });
    await writeCustomerBillFallbackWorkbook(path.join(targetDir, CUSTOMER_BILL_FILENAME), customer);
  }

  await writeCustomerLedgerWorkbook(path.join(targetDir, CUSTOMER_LEDGER_FILENAME), customer);
  const imageCount = copyCustomerImagesToPackage(assets.images || [], targetDir);
  writeCustomerDataManifest(targetDir, customer, { billCount, imageCount });
  return { billCount, imageCount, warnings };
}

async function writeCustomerBillFallbackWorkbook(filePath, customer) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('\u5ba2\u6237\u8d26\u5355');
  sheet.columns = [
    { header: 'Customer', key: 'customer', width: 24 },
    { header: 'Passport', key: 'passport', width: 18 },
    { header: 'Receipt No', key: 'receiptNo', width: 22 },
    { header: 'Rebate KRW', key: 'rebateKrw', width: 16, style: { numFmt: '#,##0' } },
    { header: 'Rebate USD', key: 'rebateUsd', width: 16, style: { numFmt: '#,##0.00' } },
  ];
  for (const row of customer.rows) {
    sheet.addRow({
      customer: customer.name,
      passport: customer.passportNo,
      receiptNo: row.receipt_no || '',
      rebateKrw: numberOrNull(row.customer_rebate_krw),
      rebateUsd: numberOrNull(row.customer_rebate_usd),
    });
  }
  await workbook.xlsx.writeFile(filePath);
}

async function writeCustomerLedgerWorkbook(filePath, customer) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('\u53f0\u8d26\u660e\u7ec6');
  sheet.columns = [
    { header: 'Customer', key: 'customer', width: 22 },
    { header: 'Passport', key: 'passportNo', width: 18 },
    { header: 'Purchase Date', key: 'purchaseDate', width: 14 },
    { header: 'Departure Date', key: 'departureDate', width: 14 },
    { header: 'Receipt No', key: 'receiptNo', width: 22 },
    { header: 'Tour No', key: 'tourNo', width: 14 },
    { header: 'Mode', key: 'modeFolder', width: 18 },
    { header: 'Net KRW', key: 'netKrw', width: 16, style: { numFmt: '#,##0' } },
    { header: 'Net USD', key: 'netUsd', width: 16, style: { numFmt: '#,##0.00' } },
    { header: 'Rebate KRW', key: 'rebateKrw', width: 16, style: { numFmt: '#,##0' } },
    { header: 'Rebate USD', key: 'rebateUsd', width: 16, style: { numFmt: '#,##0.00' } },
  ];
  for (const row of customer.rows) {
    sheet.addRow({
      customer: customer.name,
      passportNo: customer.passportNo,
      purchaseDate: fmtDate(row.purchase_date),
      departureDate: fmtDate(row.departure_date),
      receiptNo: row.receipt_no || '',
      tourNo: row.tour_no || '',
      modeFolder: row.mode_folder || '',
      netKrw: numberOrNull(row.net_krw),
      netUsd: numberOrNull(row.net_usd),
      rebateKrw: numberOrNull(row.customer_rebate_krw),
      rebateUsd: numberOrNull(row.customer_rebate_usd),
    });
  }
  await workbook.xlsx.writeFile(filePath);
}

function copyCustomerImagesToPackage(images, targetDir) {
  let copied = 0;
  const perKind = new Map();
  for (const image of images) {
    if (!image?.path || !fs.existsSync(image.path)) continue;
    const kind = IMAGE_KIND_DIRS[image.kind] ? image.kind : 'other';
    const kindDir = path.join(targetDir, IMAGE_DIR, IMAGE_KIND_DIRS[kind]);
    ensureDir(kindDir);
    const count = (perKind.get(kind) || 0) + 1;
    perKind.set(kind, count);
    const ext = path.extname(image.path) || '.jpg';
    const targetName = `${String(count).padStart(3, '0')}-${kind}${ext}`;
    fs.copyFileSync(image.path, path.join(kindDir, targetName));
    copied += 1;
  }
  return copied;
}

function writeCustomerDataManifest(targetDir, customer, counts) {
  const payload = {
    customerName: customer.name,
    passportNo: customer.passportNo,
    receiptCount: customer.rows.length,
    billCount: counts.billCount,
    imageCount: counts.imageCount,
    receipts: customer.rows.map((row) => ({
      receiptNo: row.receipt_no || '',
      purchaseDate: fmtDate(row.purchase_date),
      departureDate: fmtDate(row.departure_date),
      rebateKrw: numberOrNull(row.customer_rebate_krw),
      rebateUsd: numberOrNull(row.customer_rebate_usd),
    })),
  };
  fs.writeFileSync(path.join(targetDir, CUSTOMER_MANIFEST_FILENAME), JSON.stringify(payload, null, 2), 'utf8');
}

function createCustomerLookup({ customerLibraryRepository, batchRepository }) {
  const workspaceCache = new Map();
  const batchCache = new Map();
  return { customerLibraryRepository, batchRepository, workspaceCache, batchCache };
}

function resolveCustomerAssets(customer, lookup) {
  const resolved = resolveCustomerForDelivery(customer, lookup);
  if (!resolved?.customer || !resolved.customerDir) {
    return { customer: null, customerDir: '', billPath: '', images: [] };
  }
  return {
    customer: resolved.customer,
    customerDir: resolved.customerDir,
    billPath: resolveCustomerBillPath(resolved.customerDir, resolved.customer),
    images: resolveCustomerImages(resolved.customerDir, resolved.customer),
  };
}

function resolveCustomerForDelivery(customer, lookup) {
  const repo = lookup?.customerLibraryRepository;
  if (!repo) return null;
  const preferred = resolveCustomerReferenceFromRows(customer.rows, lookup);
  if (preferred?.workspaceKey && preferred?.customerId) {
    const direct = loadCustomerIfExists(repo, preferred.workspaceKey, preferred.customerId);
    if (direct) return direct;
  }
  const sourceCustomerId = customer.rows
    .map((row) => String(row.trace_source_customer_id || '').trim())
    .find(Boolean);
  if (sourceCustomerId) {
    return findCustomerById(repo, sourceCustomerId, lookup.workspaceCache);
  }
  return null;
}

function resolveCustomerReferenceFromRows(rows, lookup) {
  const batchRepository = lookup?.batchRepository;
  if (!batchRepository || typeof batchRepository.loadBatch !== 'function') return null;
  for (const row of rows) {
    const batchId = String(row.trace_source_batch_id || '').trim();
    const taskId = String(row.trace_source_task_id || '').trim();
    if (!batchId || !taskId) continue;
    let batch = lookup.batchCache.get(batchId);
    if (!lookup.batchCache.has(batchId)) {
      try {
        batch = batchRepository.loadBatch(batchId);
      } catch (_error) {
        batch = null;
      }
      lookup.batchCache.set(batchId, batch);
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
const { parseCustomerRefFromPath: parseCustomerReferenceFromSourcePath } = require('../../lib/customer_ref');

function findCustomerById(customerLibraryRepository, customerId, workspaceCache) {
  if (!customerId) return null;
  for (const workspaceKey of customerLibraryRepository.listWorkspaces()) {
    if (!workspaceCache.has(workspaceKey)) {
      workspaceCache.set(workspaceKey, customerLibraryRepository.listCustomers(workspaceKey));
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

function resolveInside(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const fullPath = path.resolve(resolvedRoot, String(relativePath || ''));
  if (fullPath !== resolvedRoot && !fullPath.startsWith(`${resolvedRoot}${path.sep}`)) return '';
  return fullPath;
}

function resolveCustomerBillPath(customerDir, customer) {
  const relPath = String(customer?.template?.finalOutputPath || '').trim();
  if (!relPath) return '';
  const filePath = resolveInside(customerDir, relPath);
  return filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile() ? filePath : '';
}

function resolveCustomerImages(customerDir, customer) {
  const images = Array.isArray(customer?.images) ? customer.images : [];
  return images
    .map((image) => {
      const relPath = String(image?.relativePath || image?.fileName || '').trim();
      const filePath = resolveInside(customerDir, relPath);
      if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
      return {
        kind: classifyImageKind(image, filePath),
        label: image?.originalFileName || path.basename(filePath),
        path: filePath,
      };
    })
    .filter(Boolean);
}

function classifyImageKind(image, filePath) {
  const haystack = [
    image?.originalFileName,
    image?.relativePath,
    image?.fileName,
    image?.imageId,
    path.basename(filePath),
  ].join(' ').toLowerCase();
  if (haystack.includes('passport') || haystack.includes('\u62a4\u7167')) return 'passport';
  if (haystack.includes('receipt') || haystack.includes('\u5c0f\u7968')) return 'receipt';
  if (
    haystack.includes('ticket')
    || haystack.includes('flight')
    || haystack.includes('air')
    || haystack.includes('\u673a\u7968')
  ) {
    return 'ticket';
  }
  return 'other';
}

function floorToThousand(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return 0;
  // 千位抹零 = 抹掉尾数,语义是"往绝对值小的方向取"。负净额(退货冲减客户)若用
  // Math.floor 会把 -1500 变 -2000(放大欠款),必须 trunc:-1500 → -1000。
  return Math.trunc(n / 1000) * 1000;
}

function resetDir(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  ensureDir(dir);
}

function publicFileInfo(file) {
  return {
    kind: file.kind,
    folder: file.folder || null,
    filename: path.basename(file.path),
    rows: file.rows || 0,
  };
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

function safePdfText(value) {
  return String(value || '').replace(/[^\x20-\x7E]/g, '?');
}

module.exports = {
  createFinalDeliveryExportService,
  formatMonthlyReceiptNo, // 月结票号格式化(现代补杠2-6-3-5),供测试
  floorToThousand,
  // 导出内部构件供测试/样例生成复用(客户分组 + 客户 PDF / 数据包写盘)
  groupRowsByCustomer,
  writeCustomerPdf,
  writeCustomerDataPackage,
  // 启动检查用:客户 PDF 韩文依赖 CJK 字体,缺失会静默降级成方框/ASCII
  resolveCjkFontPath,
  // 0729 A1:交付说明生成(纯函数,直测)
  buildFinalDeliveryNotes,
};
