'use strict';

/**
 * field_diff — compares two records (daily_receipt vs store_bill) field
 * by field using canonical keys, returning a list of conflicts.
 *
 * Two records can share different field names (daily uses `tourNo`, bill
 * uses `tourNo` too but different camelCase keys elsewhere). This helper
 * maps both through a shared key list.
 */

// (dailyKey, billKey) — both canonical camelCase
const COMPARABLE_FIELDS = Object.freeze([
  'receiptNo',
  'passportNo',
  'purchaseDate',
  'departureDate',
  'tourNo',
  'name',
  'netKrw',
]);

// Bill rows use slightly different naming in some cases
const BILL_ALIAS = Object.freeze({
  shop: 'storeFamily',
  branch: 'storeBranch',
});

const DATE_FIELDS = new Set(['purchaseDate', 'departureDate']);
const MONEY_FIELDS = new Set(['netKrw']);
const NAME_FIELDS = new Set(['name']);

// daily-side placeholder names that carry no real identity (e.g. "无护照").
// When the ledger name is one of these, the bill name is authoritative —
// see conflict_policy.planMerge (backfill instead of human review).
const NAME_PLACEHOLDER_RE = /无护照|無護照|^-+$|^null$/i;

function normalizeString(v) {
  if (v == null) return '';
  return String(v).trim().toLowerCase().replace(/\s+/g, ' ');
}

// Names are compared with ALL whitespace removed so that bill-side spacing
// quirks ("TEH SIEW CHYI" vs "TEH SIEWCHYI") do not register as conflicts.
function normalizeName(v) {
  if (v == null) return '';
  return String(v).trim().toLowerCase().replace(/\s+/g, '');
}

// 代理(导游名)归一化为 token 集合,用于 tour_match 的代理比对。
// 真实数据里"同一个人"会有几种写法:
//   - 一格塞多个导游:"西雅国际/涛士"、"陈灏铭/梓陌"  → 按分隔符拆开
//   - 名字后跟护照码:"陈强E87617470"               → 去掉尾部 [字母+6位以上数字]
//   - 现场/登记标记:"涛士现场"、"蜜蜂登记群"        → 仅当剥完仍有名字时才去后缀
// 关键安全性:最终是「精确 token 比对」,不是子串包含,所以两个真正不同的名字
// (涛士 vs 蜜蜂)绝不会被合并。"备用""主号"这类占位词不在剥除清单里,保持原样
// (与真实代理对不上 → 仍判为冲突,进待补救)。
function normalizeAgentTokens(raw) {
  if (raw == null) return [];
  return String(raw)
    .split(/[/、,，;；]+/)
    .map((s) => s.trim().toLowerCase().replace(/\s+/g, ''))
    .map((s) => s.replace(/([a-z]{1,2}\d{6,})$/i, ''))
    .map((s) => {
      const stripped = s.replace(/(现场|登记群|登记)$/u, '');
      return stripped.length > 0 ? stripped : s;
    })
    .filter(Boolean);
}

// 两个代理是否算同一人。任一方为空 → 不算冲突(沿用原逻辑:缺数据不拦)。
function agentMatches(a, b) {
  const setA = new Set(normalizeAgentTokens(a));
  const tokensB = normalizeAgentTokens(b);
  if (setA.size === 0 || tokensB.length === 0) return true;
  return tokensB.some((t) => setA.has(t));
}

function isPlaceholderName(v) {
  if (v == null) return false;
  const s = String(v).trim();
  if (!s) return false;
  return NAME_PLACEHOLDER_RE.test(s);
}

function normalizeDate(v) {
  if (v == null) return '';
  const s = String(v).trim();
  if (!s) return '';
  // accept both '2026-01-15' and '2026/01/15'
  return s.replace(/[./]/g, '-').slice(0, 10);
}

function isEmptyValue(v) {
  if (v == null) return true;
  const s = String(v).trim();
  if (!s) return true;
  if (s === '-' || s === '--' || s === 'null') return true;
  // ① 账单侧护照占位码(爱宝客 HDC_PKG100 等)当空 → 台账真护照权威,不算冲突
  if (/^HDC_PKG/i.test(s)) return true;
  return false;
}

// ① 姓名截断容忍: 同一笔交易,账单姓名常被截断到固定宽度(TANG vs TANG ZHE)。
// 去空格后一方是另一方前缀(且都≥2字符)→ 视为同一人,不算冲突。
function nameTruncationEqual(a, b) {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length >= 2 && y.length >= 2 && (x.startsWith(y) || y.startsWith(x))) return true;
  return false;
}

function normalizeMoney(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {object} daily — daily_receipt row (camelCase)
 * @param {object} bill  — store_bill row (camelCase)
 * @param {{ fields?: string[] }} [opts]
 * @returns {{ field, dailyValue, billValue }[]}  conflicts only
 */
function diffDailyVsBill(daily, bill, opts = {}) {
  const out = [];
  const fields = opts.fields || COMPARABLE_FIELDS;
  for (const field of fields) {
    const billField = BILL_ALIAS[field] || field;
    const dailyRaw = daily?.[field];
    const billRaw = bill?.[billField];
    if (isEmptyValue(dailyRaw) || isEmptyValue(billRaw)) continue; // any-empty → no conflict
    let different;
    if (DATE_FIELDS.has(field)) {
      different = normalizeDate(dailyRaw) !== normalizeDate(billRaw);
    } else if (MONEY_FIELDS.has(field)) {
      const a = normalizeMoney(dailyRaw);
      const b = normalizeMoney(billRaw);
      different = a != null && b != null && Math.abs(a - b) > 1;
    } else if (NAME_FIELDS.has(field)) {
      // ① 截断容忍: 一方是另一方前缀(账单截断)→ 同一人,不算冲突
      different = !nameTruncationEqual(dailyRaw, billRaw);
    } else {
      different = normalizeString(dailyRaw) !== normalizeString(billRaw);
    }
    if (different) {
      out.push({ field, dailyValue: dailyRaw, billValue: billRaw });
    }
  }
  return out;
}

module.exports = {
  COMPARABLE_FIELDS,
  BILL_ALIAS,
  diffDailyVsBill,
  isEmptyValue,
  isPlaceholderName,
  normalizeString,
  normalizeName,
  normalizeAgentTokens,
  agentMatches,
  normalizeDate,
};
