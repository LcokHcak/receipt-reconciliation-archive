'use strict';

/**
 * daily_receipt mapper — parses one row from 每日收票表-员工序号.xlsx
 * (42 fixed columns; exported by OCR review at 阶段 1).
 *
 * Column order (fixed by 小票规则 specification):
 *   1 日期         15 护照号        29 DC($)
 *   2 出账日期     16 出境日期      30 DC(￦)
 *   3 付款模式     17 小票号        31 折扣率
 *   4 返点模式     18 原小票号      32 商品券金额
 *   5 免税店       19 分类          33 扣点商品券
 *   6 免税分店     20 品牌          34 客人点数
 *   7 上家         21 SKU           35 客人返点金额
 *   8 入店公司     22 产品名称      36 免税店点数
 *   9 导游         23 REF NO        37 免税店返点
 *  10 代理         24 数量          38 免税店追加点
 *  11 原日期       25 总卖出($)     39 追加金额
 *  12 购买日期     26 总卖出(￦)     40 免税店最终返点
 *  13 团号         27 纯卖出($)     41 分类 (secondary)
 *  14 姓名         28 纯卖出(￦)     42 备注
 */

const { hashRow } = require('./row_hasher');
const { parseCellDate, fallbackYearFromWorkspace } = require('./date_parsers');
const { normalizeMode } = require('./mode_normalizer');

const FIELD_ALIASES = Object.freeze({
  stmtDate: ['日期'],
  statementDate: ['出账日期'],
  paymentMode: ['付款模式'],
  modeRaw: ['返点模式', '模式'],
  shop: ['免税店'],
  branch: ['免税分店'],
  upstream: ['上家'],
  entryCompany: ['入店公司'],
  tourGuide: ['导游'],
  agent: ['代理'],
  originalDate: ['原日期'],
  purchaseDate: ['购买日期'],
  tourNo: ['团号'],
  name: ['姓名'],
  passportNo: ['护照号', '护照号码'],
  departureDate: ['出境日期'],
  // 0731:每日收票表表头改成「小票号/交易编号」(百货行填的就是交易编号)。
  // 旧名放前面、继续认——存量台账不能因为改个表头就读不进来。
  receiptNo: ['小票号', '小票号/交易编号', '交易编号'],
  originalReceiptNo: ['原小票号'],
  category: ['分类'],
  brand: ['品牌'],
  sku: ['SKU'],
  productName: ['产品名称'],
  refNo: ['REF NO', 'REF_NO', 'RefNo'],
  qty: ['数量'],
  grossUsd: ['总卖出($)', '总卖出（$）'],
  grossKrw: ['总卖出(￦)', '总卖出（￦）'],
  netUsd: ['纯卖出($)', '纯卖出（$）'],
  netKrw: ['纯卖出(￦)', '纯卖出（￦）'],
  dcUsd: ['DC($)', 'DC（$）'],
  dcKrw: ['DC(￦)', 'DC（￦）'],
  discountRate: ['折扣率'],
  voucherAmount: ['商品券金额'],
  voucherDeduction: ['扣点商品券'],
  customerPoints: ['客人点数'],
  customerRebate: ['客人返点金额'],
  storeBasePoints: ['免税店点数', '免税店基本点'],
  storeBaseRebate: ['免税店返点', '基本返点'],
  storeExtraPoints: ['免税店追加点'],
  storeExtraAmount: ['追加金额'],
  storeFinalRebate: ['免税店最终返点'],
  remark: ['备注'],
});

// Pick value from row using headers, but also handle duplicate "分类" (cols 19 and 41):
// - first occurrence -> category
// - second occurrence -> category_secondary
function pickSimple(row, keys) {
  for (const key of keys) {
    if (row[key] != null && row[key] !== '') return row[key];
  }
  return null;
}

function mapDailyReceiptRow({
  asObject,
  rawValues,
  headers,
  workspaceKey,
  sheetName,
  sourceFile,
  sourceRow,
  importedAt,
  importJobId,
  sourceCustomerId,
}) {
  // Identity guard
  const receiptNo = trim(pickSimple(asObject, FIELD_ALIASES.receiptNo));
  const passportNo = trim(pickSimple(asObject, FIELD_ALIASES.passportNo));
  const name = trim(pickSimple(asObject, FIELD_ALIASES.name));
  if (!receiptNo && !passportNo && !name) return null;

  const fallbackYear = fallbackYearFromWorkspace(workspaceKey);
  const modeRaw = trim(pickSimple(asObject, FIELD_ALIASES.modeRaw));
  const { code: modeNormalized } = modeRaw ? normalizeMode(modeRaw) : { code: null };

  // Duplicate-header "分类" handling: if both exist in raw values, prefer
  // positional (col 19 primary, col 41 secondary)
  let category = trim(pickSimple(asObject, FIELD_ALIASES.category));
  let categorySecondary = null;
  if (Array.isArray(headers) && Array.isArray(rawValues)) {
    const classifyIdxs = [];
    for (let i = 0; i < headers.length; i += 1) {
      if (String(headers[i]).trim() === '分类') classifyIdxs.push(i);
    }
    if (classifyIdxs.length >= 1) category = trim(rawValues[classifyIdxs[0]]);
    if (classifyIdxs.length >= 2) categorySecondary = trim(rawValues[classifyIdxs[1]]);
  }

  const canonical = {
    workspaceKey,
    sourceCustomerId: sourceCustomerId || null,
    stmtDate: parseCellDate(pickSimple(asObject, FIELD_ALIASES.stmtDate), { fallbackYear }),
    statementDate: parseCellDate(pickSimple(asObject, FIELD_ALIASES.statementDate), { fallbackYear }),
    paymentMode: trim(pickSimple(asObject, FIELD_ALIASES.paymentMode)),
    modeRaw,
    modeNormalized,
    shop: trim(pickSimple(asObject, FIELD_ALIASES.shop)),
    branch: trim(pickSimple(asObject, FIELD_ALIASES.branch)),
    upstream: trim(pickSimple(asObject, FIELD_ALIASES.upstream)),
    entryCompany: trim(pickSimple(asObject, FIELD_ALIASES.entryCompany)),
    tourGuide: trim(pickSimple(asObject, FIELD_ALIASES.tourGuide)),
    agent: trim(pickSimple(asObject, FIELD_ALIASES.agent)),
    originalDate: parseCellDate(pickSimple(asObject, FIELD_ALIASES.originalDate), { fallbackYear }),
    purchaseDate: parseCellDate(pickSimple(asObject, FIELD_ALIASES.purchaseDate), { fallbackYear }),
    // 副本漂移收口(2026-07-21):Excel 团号列写「无/无团号」的机场票,曾原样落库成字符串
    // 「无」→ tour_match 当真团号查表必 tour_not_found、confirmModesByGroup(IS NULL)盖不上。
    // 对齐台账桥口径:无团号哨兵 → 空串(insertMany 落 SQL NULL)。只动哨兵值不做全量归一,
    // 避免已导入历史行的 row_hash 漂移产生重复行。
    tourNo: (() => {
      const v = trim(pickSimple(asObject, FIELD_ALIASES.tourNo));
      return (v === '无' || v === '无团号') ? '' : v;
    })(),
    name,
    passportNo,
    departureDate: parseCellDate(pickSimple(asObject, FIELD_ALIASES.departureDate), { fallbackYear }),
    receiptNo,
    originalReceiptNo: trim(pickSimple(asObject, FIELD_ALIASES.originalReceiptNo)),
    category,
    categorySecondary,
    brand: trim(pickSimple(asObject, FIELD_ALIASES.brand)),
    sku: trim(pickSimple(asObject, FIELD_ALIASES.sku)),
    productName: trim(pickSimple(asObject, FIELD_ALIASES.productName)),
    refNo: trim(pickSimple(asObject, FIELD_ALIASES.refNo)),
    qty: numberOrNull(pickSimple(asObject, FIELD_ALIASES.qty)),
    grossUsd: numberOrNull(pickSimple(asObject, FIELD_ALIASES.grossUsd)),
    grossKrw: numberOrNull(pickSimple(asObject, FIELD_ALIASES.grossKrw)),
    netUsd: numberOrNull(pickSimple(asObject, FIELD_ALIASES.netUsd)),
    netKrw: numberOrNull(pickSimple(asObject, FIELD_ALIASES.netKrw)),
    dcUsd: numberOrNull(pickSimple(asObject, FIELD_ALIASES.dcUsd)),
    dcKrw: numberOrNull(pickSimple(asObject, FIELD_ALIASES.dcKrw)),
    discountRate: numberOrNull(pickSimple(asObject, FIELD_ALIASES.discountRate)),
    voucherAmount: numberOrNull(pickSimple(asObject, FIELD_ALIASES.voucherAmount)),
    voucherDeduction: numberOrNull(pickSimple(asObject, FIELD_ALIASES.voucherDeduction)),
    customerPoints: numberOrNull(pickSimple(asObject, FIELD_ALIASES.customerPoints)),
    customerRebate: numberOrNull(pickSimple(asObject, FIELD_ALIASES.customerRebate)),
    storeBasePoints: numberOrNull(pickSimple(asObject, FIELD_ALIASES.storeBasePoints)),
    storeBaseRebate: numberOrNull(pickSimple(asObject, FIELD_ALIASES.storeBaseRebate)),
    storeExtraPoints: numberOrNull(pickSimple(asObject, FIELD_ALIASES.storeExtraPoints)),
    storeExtraAmount: numberOrNull(pickSimple(asObject, FIELD_ALIASES.storeExtraAmount)),
    storeFinalRebate: numberOrNull(pickSimple(asObject, FIELD_ALIASES.storeFinalRebate)),
    remark: trim(pickSimple(asObject, FIELD_ALIASES.remark)),
    sourceFile,
    sourceSheet: sheetName,
    sourceRow,
  };

  return {
    ...canonical,
    billMatchStatus: 'unmatched',
    tourMatchStatus: 'pending',
    rawPayload: asObject,
    rowHash: hashRow({ ...canonical, sourceRow }),
    importedAt,
    importJobId,
  };
}

function trim(v) {
  if (v == null) return null;
  const text = String(v).trim();
  return text || null;
}

function numberOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 判定一行是否是日度台账(收票)表头行。用于 streamRows 的 detectHeader:
 * 操作员收票工作簿首行常是标题(「收票按照下面格式填信息」),真表头在第 2 行;
 * 汇总页/备份页/团号页没有这套表头 → 不命中 → 整张被跳过。
 *
 * 规则:必须含「小票号」(收票台账的辨识列),且在 {收票日期/购买日期/团号/护照号/姓名/模式}
 * 中再命中 ≥2 个。这样汇总页(星期/收票数量)、团号页(申请日期/团号/护照号但无小票号)都不会误判。
 * @param {Array<*>} values 一行的原始单元格值
 * @returns {boolean}
 */
function isDailyLedgerHeaderRow(values) {
  if (!Array.isArray(values)) return false;
  const cells = new Set(
    values.map((v) => String(v ?? '').trim()).filter(Boolean)
  );
  // 认表头也要跟着放宽:这是**判定"这张表是不是每日台账"**的必要条件,
  // 只认旧名的话,系统 0731 之后自己导出的表会被判成"不是台账"而整张跳过 ——
  // 而跳过是静默的,表现成"导出的东西回读时凭空少了一批"。
  if (!FIELD_ALIASES.receiptNo.some((h) => cells.has(h))) return false;
  const SIGNALS = ['收票日期', '购买日期', '团号', '护照号', '护照号码', '姓名', '模式', '返点模式', '出境日期'];
  let hits = 0;
  for (const tok of SIGNALS) if (cells.has(tok)) hits += 1;
  return hits >= 2;
}

module.exports = {
  mapDailyReceiptRow,
  isDailyLedgerHeaderRow,
  FIELD_ALIASES,
};
