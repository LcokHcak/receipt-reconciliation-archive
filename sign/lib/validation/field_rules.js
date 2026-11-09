'use strict';

/**
 * 字段校验（规则表 v2，2026-05-11）。
 *
 * 校验失败时不改值，只返回 `{ ok: false, reason }`，调用方自己决定：
 * - analyzer 层会把失败的 reason 合并进 `needsReview` / `reviewReasons`
 * - receipt_field_model 层会在清洗时拒掉不合法值、保留 fallback
 *
 * 为什么每条规则都返回 `reason` 字符串常量而不是 enum：
 *   reason 会被持久化到 `pending_review.reviewReasons` 和 badcase 表里，
 *   将来 UI / SQL grep 要用。字符串常量 + 枚举 map 的组合是最好调试的。
 */

const REASONS = Object.freeze({
  CHINESE_NAME: 'field_chinese_name_invalid',
  ENGLISH_NAME: 'field_english_name_invalid',
  PASSPORT_NO: 'field_passport_no_invalid',
  STORE_FAMILY: 'field_store_family_invalid',
  RECEIPT_NO: 'field_receipt_no_invalid',
  TOUR_NO: 'field_tour_no_invalid',
  PURCHASE_DATE: 'field_purchase_date_invalid',
  DEPARTURE_DATE: 'field_departure_date_invalid',
  DATE_RANGE: 'field_date_range_invalid',
});

const STORE_FAMILIES = Object.freeze({
  LOTTE: 'LOTTE',
  SHILLA_IPARK: 'SHILLA IPARK',
  THE_SHILLA: 'THE SHILLA',
  // 新增识别(2026-07):票号/团号长度先不配 → 校验自动放宽(skip),只为让 store_family 不标红。
  // 待服务器攒够样本再进 RECEIPT_NO_LENGTH_BY_STORE / TOUR_NO_LENGTH_BY_STORE 收紧。
  SHINSEGAE: 'SHINSEGAE',
  HYUNDAI: 'HYUNDAI',
  // 百货(2026-07-06):无团号、图不切、真字段(金额/上家/门店/品牌)。是免税店的兄弟枚举,
  // 归一化时"百货关键词优先",否则「新世界百货」会被 includes('新世界') 误吞进新世界免税店。
  LOTTE_DEPT: 'LOTTE_DEPT',
  SHINSEGAE_DEPT: 'SHINSEGAE_DEPT',
  HYUNDAI_DEPT: 'HYUNDAI_DEPT',
});

// 百货标记词:中/韩/英。normalizeStoreFamily 先看这个,命中即走百货分支。
const DEPT_KEYWORDS = ['百货', '백화점', 'DEPT', 'DEPARTMENT'];
function isDeptStore(upperSpaced) {
  return DEPT_KEYWORDS.some((k) => upperSpaced.includes(k));
}

const RECEIPT_NO_LENGTH_BY_STORE = Object.freeze({
  [STORE_FAMILIES.LOTTE]: 14,
  [STORE_FAMILIES.SHILLA_IPARK]: 13,
  [STORE_FAMILIES.THE_SHILLA]: 13,
  // 2026-07-04 金标收口:新世界 16 位(498/511=97.5%)、现代 16 位(24/24)。
  // RECEIPT_NO_STRICT=false 期间仅作参考长度(识别期望值),重新收紧时自动生效。
  [STORE_FAMILIES.SHINSEGAE]: 16,
  [STORE_FAMILIES.HYUNDAI]: 16,
});

const TOUR_NO_LENGTH_BY_STORE = Object.freeze({
  [STORE_FAMILIES.LOTTE]: 8,
  [STORE_FAMILIES.SHILLA_IPARK]: 5,
  [STORE_FAMILIES.THE_SHILLA]: 5,
  [STORE_FAMILIES.SHINSEGAE]: 5, // 票面 [GT:79611] 实测 5 位(2026-07-03 生产样本)
});

function isEmpty(value) {
  return value == null || String(value).trim() === '';
}

function ok() {
  return { ok: true };
}

function fail(reason) {
  return { ok: false, reason };
}

function normalizeStoreFamily(value) {
  const s = String(value || '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (!s) return '';
  // ⭐百货优先(2026-07-06 撞名防线):百货串一定含"百货/백화점/DEPT",先在这里分流,
  // 否则「新世界百货」下面会被 includes('新世界') 误吞进 SHINSEGAE 免税店(第一天就串台)。
  if (isDeptStore(s)) {
    if (s.includes('LOTTE') || s.includes('乐天') || s.includes('롯데')) return STORE_FAMILIES.LOTTE_DEPT;
    if (s.includes('SHINSEGAE') || s.includes('新世界') || s.includes('신세계')) return STORE_FAMILIES.SHINSEGAE_DEPT;
    if (s.includes('HYUNDAI') || s.includes('现代') || s.includes('現代') || s.includes('현대')) return STORE_FAMILIES.HYUNDAI_DEPT;
    // 认出是百货但不知哪家 → 不猜(留空,审核员选);别掉进免税店分支
    return '';
  }
  // 允许常见变体(免税店)
  if (s === 'LOTTE' || s.startsWith('LOTTE ')) return STORE_FAMILIES.LOTTE;
  if (s === 'SHILLA IPARK' || s === 'SHILLAIPARK') return STORE_FAMILIES.SHILLA_IPARK;
  if (s === 'THE SHILLA' || s === 'THESHILLA') return STORE_FAMILIES.THE_SHILLA;
  // 新增识别(用 includes 容 "SHINSEGAE DUTY FREE" 这类整串;中/韩写法兜底)。
  if (s.includes('SHINSEGAE') || s.includes('新世界') || s.includes('신세계')) return STORE_FAMILIES.SHINSEGAE;
  if (s.includes('HYUNDAI') || s.includes('现代') || s.includes('現代') || s.includes('현대')) return STORE_FAMILIES.HYUNDAI;
  return '';
}

function validateChineseName(value) {
  if (isEmpty(value)) return fail(REASONS.CHINESE_NAME);
  const s = String(value).trim();
  // 2-10 位 CJK（Unified Ideographs + Extension A）
  if (!/^[㐀-鿿]{2,10}$/.test(s)) return fail(REASONS.CHINESE_NAME);
  return ok();
}

function validateEnglishName(value) {
  if (isEmpty(value)) return fail(REASONS.ENGLISH_NAME);
  const s = String(value).trim().toUpperCase();
  if (s.length < 2 || s.length > 50) return fail(REASONS.ENGLISH_NAME);
  // 允许字母 + 单个空格分隔的多段
  if (!/^[A-Z]+(?:\s[A-Z]+)*$/.test(s)) return fail(REASONS.ENGLISH_NAME);
  return ok();
}

function validatePassportNo(value) {
  if (isEmpty(value)) return fail(REASONS.PASSPORT_NO);
  const s = String(value).trim().toUpperCase().replace(/\s+/g, '');
  // 国际通用:6-12 位字母或数字(兼容外国护照,如阿根廷 AAJ554634 = 3 字母+6 数字)。
  if (!/^[A-Z0-9]{6,12}$/.test(s)) return fail(REASONS.PASSPORT_NO);
  return ok();
}

function validateStoreFamily(value) {
  if (isEmpty(value)) return fail(REASONS.STORE_FAMILY);
  const canonical = normalizeStoreFamily(value);
  if (!canonical) return fail(REASONS.STORE_FAMILY);
  return { ok: true, canonical };
}

// 小票号严格校验开关(2026-07 解禁):关闭期间不限长度/字母,非空即通过。
// 各店票号差异大(济州乐天末位字母 S、新世界/现代 16 位…),金标样本不足时硬限制会误红。
// 等金标数据攒够、按店长度规律稳了,把它设回 true 即恢复"纯数字 + 按店精确长度"校验。
const RECEIPT_NO_STRICT = false;

function validateReceiptNo(storeFamily, value) {
  if (isEmpty(value)) return fail(REASONS.RECEIPT_NO);
  if (!RECEIPT_NO_STRICT) return ok(); // 解禁:非空即通过,不看长度/字母
  const expected = RECEIPT_NO_LENGTH_BY_STORE[storeFamily];
  // storeFamily 无效时，这个校验自己不打 receipt_no_invalid —— 调用方已经打了 store_family
  if (!expected) return { ok: true, skipped: true };
  const s = String(value).trim().replace(/\s+/g, '');
  if (!/^\d+$/.test(s)) return fail(REASONS.RECEIPT_NO);
  if (s.length !== expected) return fail(REASONS.RECEIPT_NO);
  return ok();
}

function validateTourNo(storeFamily, value) {
  if (isEmpty(value)) return fail(REASONS.TOUR_NO);
  const expected = TOUR_NO_LENGTH_BY_STORE[storeFamily];
  if (!expected) return { ok: true, skipped: true };
  const s = String(value).trim().replace(/\s+/g, '');
  if (!/^\d+$/.test(s)) return fail(REASONS.TOUR_NO);
  if (s.length !== expected) return fail(REASONS.TOUR_NO);
  return ok();
}

function isIsoDate(value) {
  if (typeof value !== 'string') return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function parseIsoDate(value) {
  if (!isIsoDate(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  // 防止 "2026-02-31" 被接受
  const [y, m, day] = value.split('-').map(Number);
  if (d.getUTCFullYear() !== y || d.getUTCMonth() + 1 !== m || d.getUTCDate() !== day) return null;
  return d;
}

function validatePurchaseDate(value) {
  if (isEmpty(value)) return fail(REASONS.PURCHASE_DATE);
  if (!parseIsoDate(String(value).trim())) return fail(REASONS.PURCHASE_DATE);
  return ok();
}

function validateDepartureDate(value) {
  if (isEmpty(value)) return fail(REASONS.DEPARTURE_DATE);
  if (!parseIsoDate(String(value).trim())) return fail(REASONS.DEPARTURE_DATE);
  return ok();
}

/**
 * 跨字段：purchase_date ≤ departure_date。
 * 只在两边都是合法 ISO 日期时才判断；任一无效时跳过（各自的单字段校验会处理）。
 */
function validateDateRange(purchaseDate, departureDate) {
  const a = parseIsoDate(String(purchaseDate || '').trim());
  const b = parseIsoDate(String(departureDate || '').trim());
  if (!a || !b) return { ok: true, skipped: true };
  if (a.getTime() > b.getTime()) return fail(REASONS.DATE_RANGE);
  return ok();
}

/**
 * 一次跑完所有字段校验，返回 { reasons: string[], storeFamily: canonical|'' }。
 * 调用方把 reasons 合并进 analysis.reviewReasons 即可。
 */
function validateAll(fields = {}) {
  const reasons = new Set();

  const storeResult = validateStoreFamily(fields.storeFamily);
  if (!storeResult.ok) reasons.add(storeResult.reason);
  const canonicalStoreFamily = storeResult.canonical || '';

  const chineseName = validateChineseName(fields.chineseName);
  if (!chineseName.ok) reasons.add(chineseName.reason);

  const englishName = validateEnglishName(fields.englishName);
  if (!englishName.ok) reasons.add(englishName.reason);

  const passportNo = validatePassportNo(fields.passportNo);
  if (!passportNo.ok) reasons.add(passportNo.reason);

  const receiptNo = validateReceiptNo(canonicalStoreFamily, fields.receiptNo);
  if (!receiptNo.ok) reasons.add(receiptNo.reason);

  const tourNo = validateTourNo(canonicalStoreFamily, fields.tourNo);
  if (!tourNo.ok) reasons.add(tourNo.reason);

  const purchaseDate = validatePurchaseDate(fields.purchaseDate);
  if (!purchaseDate.ok) reasons.add(purchaseDate.reason);

  const departureDate = validateDepartureDate(fields.departureDate);
  if (!departureDate.ok) reasons.add(departureDate.reason);

  const range = validateDateRange(fields.purchaseDate, fields.departureDate);
  if (!range.ok) reasons.add(range.reason);

  return {
    reasons: Array.from(reasons),
    storeFamily: canonicalStoreFamily,
  };
}

module.exports = {
  REASONS,
  STORE_FAMILIES,
  RECEIPT_NO_LENGTH_BY_STORE,
  TOUR_NO_LENGTH_BY_STORE,
  normalizeStoreFamily,
  validateChineseName,
  validateEnglishName,
  validatePassportNo,
  validateStoreFamily,
  validateReceiptNo,
  validateTourNo,
  validatePurchaseDate,
  validateDepartureDate,
  validateDateRange,
  validateAll,
};
