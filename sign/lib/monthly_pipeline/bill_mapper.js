'use strict';

const { hashRow } = require('../monthly_pipeline/row_hasher');
const { parseCellDate, fallbackYearFromWorkspace } = require('../monthly_pipeline/date_parsers');
const { normalizeMode } = require('../monthly_pipeline/mode_normalizer');
const { isDetailSheet, detectFamily, detectBranch } = require('../monthly_pipeline/store_family_detector');
const { classifyBillFolder } = require('../monthly_pipeline/mode_folder_classifier');

// 品牌活动(活动数据)的返点模式取值。命中则该行不进 store_bill,改进 brand_activity 桶。
const BRAND_ACTIVITY_MODES = Object.freeze(new Set(['品牌活动', '限时活动']));

function isBrandActivityRow(asObject) {
  if (!asObject || typeof asObject !== 'object') return false;
  const mode = trim(pickFromRow(asObject, FIELD_ALIASES.mode));
  return mode != null && BRAND_ACTIVITY_MODES.has(mode);
}

/**
 * 把一行"品牌活动数据"映射成 brand_activity 桶的 DB shape。
 * 键 = 护照 + 品牌 + 购买日(无小票号/团号);返点已在"客人返点金额"列算好。
 * 归桶用 免税店/分店(实测全是乐天 → 乐天首尔)。
 */
function mapBrandActivityRow({
  asObject,
  workspaceKey,
  sheetName,
  sourceFile,
  sourceRow,
  importedAt,
  importJobId,
}) {
  const passportNo = trim(pickFromRow(asObject, FIELD_ALIASES.passportNo));
  const name = trim(pickFromRow(asObject, FIELD_ALIASES.name));
  if (!passportNo && !name) return null;

  const fallbackYear = fallbackYearFromWorkspace(workspaceKey);
  const modeRaw = trim(pickFromRow(asObject, FIELD_ALIASES.mode));
  const storeFamily = trim(pickFromRow(asObject, FIELD_ALIASES.storeFamily));
  const storeBranch = trim(pickFromRow(asObject, FIELD_ALIASES.storeBranch));
  const purchaseDate = parseCellDate(pickFromRow(asObject, FIELD_ALIASES.purchaseDate), { fallbackYear });
  const modeFolder = classifyBillFolder({ modeRaw, storeFamily, storeBranch, sourceFile, sourceSheet: sheetName });

  const canonical = {
    workspaceKey,
    passportNo,
    name,
    fullName: trim(pickFromRow(asObject, FIELD_ALIASES.fullName)),
    brand: trim(pickFromRow(asObject, FIELD_ALIASES.brand)),
    purchaseDate,
    originalDate: parseCellDate(pickFromRow(asObject, FIELD_ALIASES.originalDate), { fallbackYear }),
    storeFamily,
    storeBranch,
    mode: modeRaw,
    netUsd: numberOrNull(pickFromRow(asObject, FIELD_ALIASES.netUsd)),
    netKrw: numberOrNull(pickFromRow(asObject, FIELD_ALIASES.netKrw)),
    points: numberOrNull(pickFromRow(asObject, FIELD_ALIASES.points)),
    rebateAmount: numberOrNull(pickFromRow(asObject, FIELD_ALIASES.rebateAmount)),
  };

  return {
    ...canonical,
    modeNormalized: normalizeMode(modeRaw).code,
    modeFolder,
    sourceFile,
    sourceSheet: sheetName,
    sourceRow,
    rawPayload: asObject,
    rowHash: hashRow({ ...canonical, sheetName, sourceRow }),
    importedAt,
    importJobId,
  };
}

const FIELD_ALIASES = Object.freeze({
  mode: ['返点模式', '付款模式', '模式'],
  storeFamily: ['免税店'],
  storeBranch: ['免税分店'],
  tourNo: ['团号', '단체번호'],
  purchaseDate: ['购买日期'],
  originalDate: ['原日期'],
  departureDate: ['出境日期'],
  name: ['姓名'],
  fullName: ['完整姓名'],
  passportNo: ['护照号'],
  receiptNo: ['小票号'],
  originalReceiptNo: ['原小票号'],
  brand: ['品牌'],
  sku: ['SKU'],
  refNo: ['REF NO', 'REF_NO', 'RefNo'],
  category: ['分类'],
  qty: ['数量'],
  grossUsd: ['总卖出($)', '总卖出（$）'],
  grossKrw: ['总卖出(￦)', '总卖出（￦）'],
  netUsd: ['纯卖出($)', '纯卖出（$）'],
  netKrw: ['纯卖出(￦)', '纯卖出（￦）'],
  points: ['客人点数', '点数'],
  rebateAmount: ['客人返点金额', '返点金额'],
  // ③ 返点计算需要账单的免税店基本点 + 追加点(merge 用 基本点+追加点+扣点 算客人返点)
  storeBasePoints: ['免税店点数', '免税店基本点', '基本点', 'D基本点', 'S基本点'],
  storeExtraPoints: ['免税店追加点', '免税店追加', '追加点', 'S追加点', 'D追加'],
});

function pickFromRow(row, keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(row, key)) {
      const value = row[key];
      if (value !== undefined && value !== null && value !== '') return value;
    }
  }
  return null;
}

// G11c (#33): 退税/退货识别。扫所有 cell 的字符串值找关键字 + 看金额是否为负。
//   refund — 退税 / refund / 환급
//   return — 退货 / return / 반품
//   sale   — 默认 (含 null 等价 sale)
function detectTransactionType(asObject) {
  if (!asObject || typeof asObject !== 'object') return null;
  let textBlob = '';
  let hasNegativeAmount = false;
  for (const [key, val] of Object.entries(asObject)) {
    if (val == null) continue;
    const s = String(val);
    textBlob += ` ${key}=${s}`;
    // 金额相关的负值是退款/退货强信号
    if (/(卖出|金额|amount|总卖|纯卖)/i.test(String(key))) {
      const n = Number(s.replace(/[^\d.-]/g, ''));
      if (Number.isFinite(n) && n < 0) hasNegativeAmount = true;
    }
  }
  if (/退税|환급|refund/i.test(textBlob)) return 'refund';
  if (/退货|반품|return\b/i.test(textBlob)) return 'return';
  if (hasNegativeAmount) return 'refund'; // 兜底:金额负但没文字关键字,按 refund 计
  return null; // null 等价 sale (兼容历史数据)
}

/**
 * Map one xlsx row from a 账单表 into the DB shape. Keeps the raw payload
 * so the rule engine can revisit it without re-reading the xlsx.
 */
function mapStoreBillRow({
  asObject,
  workspaceKey,
  sheetName,
  sourceFile,
  sourceRow,
  importedAt,
  importJobId,
}) {
  const receiptNo = trim(pickFromRow(asObject, FIELD_ALIASES.receiptNo));
  const passportNo = trim(pickFromRow(asObject, FIELD_ALIASES.passportNo));
  const name = trim(pickFromRow(asObject, FIELD_ALIASES.name));
  if (!receiptNo && !passportNo && !name) return null;

  const fallbackYear = fallbackYearFromWorkspace(workspaceKey);
  const modeRaw = trim(pickFromRow(asObject, FIELD_ALIASES.mode));
  const modeInfo = normalizeMode(modeRaw);
  const { family: detectedFamily } = detectFamily({
    fileName: sourceFile,
    sheetName,
    hints: [trim(pickFromRow(asObject, FIELD_ALIASES.storeFamily))],
  });
  const storeFamily = trim(pickFromRow(asObject, FIELD_ALIASES.storeFamily)) || detectedFamily;
  const storeBranch = detectBranch({
    fileName: sourceFile,
    sheetName,
    row: {
      branch: trim(pickFromRow(asObject, FIELD_ALIASES.storeBranch)),
      shop: storeFamily,
      免税分店: trim(pickFromRow(asObject, FIELD_ALIASES.storeBranch)),
      免税店: storeFamily,
    },
  });

  const purchaseDate = parseCellDate(pickFromRow(asObject, FIELD_ALIASES.purchaseDate), { fallbackYear });
  const originalDate = parseCellDate(pickFromRow(asObject, FIELD_ALIASES.originalDate), { fallbackYear });
  const departureDate = parseCellDate(pickFromRow(asObject, FIELD_ALIASES.departureDate), { fallbackYear });

  const canonical = {
    workspaceKey,
    storeFamily,
    storeBranch,
    mode: modeRaw,
    tourNo: trim(pickFromRow(asObject, FIELD_ALIASES.tourNo)),
    purchaseDate,
    originalDate,
    departureDate,
    name,
    fullName: trim(pickFromRow(asObject, FIELD_ALIASES.fullName)),
    passportNo,
    receiptNo,
    originalReceiptNo: trim(pickFromRow(asObject, FIELD_ALIASES.originalReceiptNo)),
    brand: trim(pickFromRow(asObject, FIELD_ALIASES.brand)),
    sku: trim(pickFromRow(asObject, FIELD_ALIASES.sku)),
    refNo: trim(pickFromRow(asObject, FIELD_ALIASES.refNo)),
    category: trim(pickFromRow(asObject, FIELD_ALIASES.category)),
    // G11c (#33): 识别退税/退货关键字。命中则 transaction_type=refund/return,
    // bill_match 默认只关联 transaction_type IS NULL OR 'sale' 的行,避免退税单错锁原售单。
    transactionType: detectTransactionType(asObject),
    qty: numberOrNull(pickFromRow(asObject, FIELD_ALIASES.qty)),
    grossUsd: numberOrNull(pickFromRow(asObject, FIELD_ALIASES.grossUsd)),
    grossKrw: numberOrNull(pickFromRow(asObject, FIELD_ALIASES.grossKrw)),
    netUsd: numberOrNull(pickFromRow(asObject, FIELD_ALIASES.netUsd)),
    netKrw: numberOrNull(pickFromRow(asObject, FIELD_ALIASES.netKrw)),
    points: numberOrNull(pickFromRow(asObject, FIELD_ALIASES.points)),
    rebateAmount: numberOrNull(pickFromRow(asObject, FIELD_ALIASES.rebateAmount)),
    storeBasePoints: numberOrNull(pickFromRow(asObject, FIELD_ALIASES.storeBasePoints)),
    storeExtraPoints: numberOrNull(pickFromRow(asObject, FIELD_ALIASES.storeExtraPoints)),
    sourceFile,
    sourceSheet: sheetName,
    sourceRow,
  };

  return {
    ...canonical,
    modeNormalized: modeInfo.code,
    isDetailSheet: isDetailSheet(sheetName),
    rawPayload: asObject,
    rowHash: hashRow({ ...canonical, sheetName, sourceRow }),
    importedAt,
    importJobId,
  };
}

// ── SMG总账(上家账单,2026-07-21 拍板:进系统只做未收对账)─────────────────
// 对账 sheet 固定叫「卖出明细」(58列,滚动全量本月);只取未收对账需要的列,
// 不进账单匹配四桶(isDetailSheet=false 隔离:match/merge/桶汇总全部只吃 is_detail_sheet=1)。
const SMG_DETAIL_SHEET = '卖出明细';

// 总账独有列(其余复用 FIELD_ALIASES,与店家账单同名同义)
const SMG_FIELD_ALIASES = Object.freeze({
  statementDate: ['出账日期'],
  upstream: ['上家'],
  agent: ['代理'],
  remark: ['备注'],
});

// 退货/退税识别:复用店家账单同一套 detectTransactionType 启发式(禁副本),但只喂
// 窄集合列——总账里 商品券金额/S追加金额 等派生列偶发负值,全列扫会把正常售出误判 refund,
// 未收清单就会漏催这张票。文字关键字(退货/退税)只可能出现在 分类/备注/返点模式。
function detectSmgTransactionType(asObject) {
  const probe = {};
  for (const key of ['返点模式', '分类', SMG_FIELD_ALIASES.remark[0],
    '总卖出($)', '总卖出（$）', '总卖出(￦)', '总卖出（￦）',
    '纯卖出($)', '纯卖出（$）', '纯卖出(￦)', '纯卖出（￦）', '数量']) {
    if (Object.prototype.hasOwnProperty.call(asObject, key)) probe[key] = asObject[key];
  }
  return detectTransactionType(probe);
}

/**
 * Map one row of SMG总账「卖出明细」 into the store_bill DB shape.
 * 只取未收对账列(拍板):返点模式/免税店/免税分店/上家/代理/购买日期/团号/姓名/
 * 护照号/小票号/原小票号/品牌/出账日期/净额。rawPayload 存缩减版(上家/代理溯源),
 * 不落 58 列全量 — 28万行/周的滚动全量会把库撑爆。
 */
function mapSmgLedgerRow({
  asObject,
  workspaceKey,
  sheetName,
  sourceFile,
  sourceRow,
  importedAt,
  importJobId,
}) {
  const receiptNo = trim(pickFromRow(asObject, FIELD_ALIASES.receiptNo));
  const passportNo = trim(pickFromRow(asObject, FIELD_ALIASES.passportNo));
  const name = trim(pickFromRow(asObject, FIELD_ALIASES.name));
  if (!receiptNo && !passportNo && !name) return null;

  const fallbackYear = fallbackYearFromWorkspace(workspaceKey);
  const modeRaw = trim(pickFromRow(asObject, FIELD_ALIASES.mode));
  const upstream = trim(pickFromRow(asObject, SMG_FIELD_ALIASES.upstream));
  const agent = trim(pickFromRow(asObject, SMG_FIELD_ALIASES.agent));

  const canonical = {
    workspaceKey,
    storeFamily: trim(pickFromRow(asObject, FIELD_ALIASES.storeFamily)),
    storeBranch: trim(pickFromRow(asObject, FIELD_ALIASES.storeBranch)),
    mode: modeRaw,
    tourNo: trim(pickFromRow(asObject, FIELD_ALIASES.tourNo)),
    purchaseDate: parseCellDate(pickFromRow(asObject, FIELD_ALIASES.purchaseDate), { fallbackYear }),
    // 实测总账出账日期是 "07/02" 无年字符串 → 补账期年份归一 ISO
    statementDate: parseCellDate(pickFromRow(asObject, SMG_FIELD_ALIASES.statementDate), { fallbackYear }),
    name,
    fullName: trim(pickFromRow(asObject, FIELD_ALIASES.fullName)),
    passportNo,
    receiptNo,
    originalReceiptNo: trim(pickFromRow(asObject, FIELD_ALIASES.originalReceiptNo)),
    brand: trim(pickFromRow(asObject, FIELD_ALIASES.brand)),
    transactionType: detectSmgTransactionType(asObject),
    netUsd: numberOrNull(pickFromRow(asObject, FIELD_ALIASES.netUsd)),
    netKrw: numberOrNull(pickFromRow(asObject, FIELD_ALIASES.netKrw)),
    sourceFile,
    sourceSheet: sheetName,
    sourceRow,
  };

  const rawPayload = {};
  if (upstream) rawPayload['上家'] = upstream;
  if (agent) rawPayload['代理'] = agent;

  return {
    ...canonical,
    modeNormalized: normalizeMode(modeRaw).code,
    isDetailSheet: false, // ← 铁律:总账行绝不进账单匹配四桶/合并/桶汇总
    rawPayload: Object.keys(rawPayload).length ? rawPayload : null,
    rowHash: hashRow({ ...canonical, sheetName, sourceRow }),
    importedAt,
    importJobId,
  };
}

/**
 * Map one row from a 未收 xlsx (Sheet4 / 已填).
 */
function mapMissingReceiptRow({
  asObject,
  workspaceKey,
  sheetName,
  sourceFile,
  importedAt,
  importJobId,
}) {
  const receiptNo = trim(asObject['小票号']);
  const tourNo = trim(asObject['团号']);
  const brand = trim(asObject['品牌']);
  if (!receiptNo && !tourNo && !brand) return null;

  const fallbackYear = fallbackYearFromWorkspace(workspaceKey);
  const modeRaw = trim(asObject['返点模式']);
  const modeInfo = normalizeMode(modeRaw);
  const canonical = {
    workspaceKey,
    mode: modeRaw,
    tourNo,
    purchaseDate: parseCellDate(asObject['购买日期'], { fallbackYear }),
    name: trim(asObject['姓名']),
    fullName: trim(asObject['完整姓名']),
    passportNo: trim(asObject['护照号']),
    receiptNo,
    brand,
    netUsd: numberOrNull(asObject['求和项:纯卖出($)'] ?? asObject['纯卖出($)']),
    agent: trim(asObject['代理']),
    owner: trim(asObject['负责人'] ?? asObject[Object.keys(asObject).find((k) => /^代理$/.test(k)) || '']),
  };

  const status = /已填/.test(String(sheetName)) ? 'filled' : 'pending';

  return {
    ...canonical,
    modeNormalized: modeInfo.code,
    status,
    sourceFile,
    sourceSheet: sheetName,
    rawPayload: asObject,
    rowHash: hashRow({ ...canonical, sheetName }),
    importedAt,
    importJobId,
  };
}

function trim(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

module.exports = {
  mapStoreBillRow,
  mapMissingReceiptRow,
  mapBrandActivityRow,
  mapSmgLedgerRow,
  isBrandActivityRow,
  BRAND_ACTIVITY_MODES,
  FIELD_ALIASES,
  SMG_FIELD_ALIASES,
  SMG_DETAIL_SHEET,
};
