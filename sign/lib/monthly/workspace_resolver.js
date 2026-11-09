'use strict';

const { BadRequestError } = require('../errors');

function normalizeWorkspaceKey(explicitKey = null) {
  if (explicitKey) return String(explicitKey).trim();
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function parsePurchaseDate(value) {
  const raw = value == null ? '' : String(value).trim();
  if (!raw) return null;
  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(raw);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    return null;
  }
  const monthKey = `${match[1]}-${String(month).padStart(2, '0')}`;
  return {
    date: `${monthKey}-${String(day).padStart(2, '0')}`,
    monthKey,
  };
}

function isWithinSixMonthsOfNow(targetMonth, now = new Date()) {
  const currentIndex = now.getFullYear() * 12 + now.getMonth();
  const [year, month] = String(targetMonth || '').split('-').map(Number);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return false;
  const targetIndex = year * 12 + (month - 1);
  return Math.abs(targetIndex - currentIndex) <= 6;
}

// G11b: 未来日期比历史更要紧 — 没人买"未来"的小票。
// past:   ±6 月 (允许补录半年前数据)
// future: ≤ 90 天 (允许跨月底审,但不允许 2027-01 这种打错)
// 注: 这是 purchase_date 校验,不是入月时间。
const FUTURE_PURCHASE_DAYS_MAX = 90;

function isPurchaseDateInBusinessRange(purchaseDateISO, now = new Date()) {
  if (!purchaseDateISO) return true; // 缺日期走 caller 自己的兜底分支
  const target = new Date(`${purchaseDateISO}T00:00:00Z`);
  if (Number.isNaN(target.getTime())) return false;
  const diffDays = (target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
  if (diffDays > FUTURE_PURCHASE_DAYS_MAX) return false;        // 未来 > 90 天
  // 历史侧继续走"月级 ±6"判断,跟 isWithinSixMonthsOfNow 一致
  const [year, month] = purchaseDateISO.split('-').map(Number);
  if (Number.isFinite(year) && Number.isFinite(month)) {
    return isWithinSixMonthsOfNow(`${year}-${String(month).padStart(2, '0')}`, now);
  }
  return false;
}

function assertPurchaseMonthInRange({ purchaseDate, targetMonth }) {
  // 优先走业务上下文校验 (未来 90 天 + 历史 6 个月)
  if (purchaseDate && !isPurchaseDateInBusinessRange(purchaseDate)) {
    throw new BadRequestError(`purchaseDate ${purchaseDate} 超出业务范围 (未来最多 90 天, 历史 ±6 个月)`, {
      code: 'purchase_date_out_of_range',
    });
  }
  // 兜底保留旧的月级判断,以防只有 targetMonth 没有日的 caller
  if (isWithinSixMonthsOfNow(targetMonth)) return;
  throw new BadRequestError(`purchaseDate ${purchaseDate} 超出当前月 ±6 个月范围`, {
    code: 'purchase_date_out_of_range',
  });
}

function resolveOptionalWorkspaceForPurchaseDate({ purchaseDate, currentWorkspaceKey }) {
  const fallbackKey = normalizeWorkspaceKey(currentWorkspaceKey);
  const parsed = parsePurchaseDate(purchaseDate);
  if (!parsed) {
    return { workspaceKey: fallbackKey, purchaseDate: null, hasPurchaseDate: false };
  }
  assertPurchaseMonthInRange({ purchaseDate: parsed.date, targetMonth: parsed.monthKey });
  const demoPrefix = fallbackKey.startsWith('demo-') ? 'demo-' : '';
  return {
    workspaceKey: `${demoPrefix}${parsed.monthKey}`,
    purchaseDate: parsed.date,
    hasPurchaseDate: true,
  };
}

function resolveWorkspaceForPurchaseDate({ purchaseDate, currentWorkspaceKey }) {
  const currentKey = normalizeWorkspaceKey(currentWorkspaceKey);
  const parsed = parsePurchaseDate(purchaseDate);
  if (!parsed) {
    throw new BadRequestError('invalid purchaseDate', { code: 'invalid_purchase_date' });
  }
  assertPurchaseMonthInRange({ purchaseDate: parsed.date, targetMonth: parsed.monthKey });
  const isDemo = currentKey.startsWith('demo-');
  const targetWorkspaceKey = `${isDemo ? 'demo-' : ''}${parsed.monthKey}`;
  return {
    targetWorkspaceKey,
    purchaseDate: parsed.date,
    isCrossMonth: targetWorkspaceKey !== currentKey,
    isDemo,
  };
}

// G11d: 业务不变量 — purchaseDate ≤ departureDate (人没离境前不可能买完)
// 两个日期都给且都合法时才校验,任一缺失/格式错跳过 (单字段校验会处理)
function assertPurchaseBeforeDeparture({ purchaseDate, departureDate }) {
  const pd = purchaseDate ? String(purchaseDate).trim() : '';
  const dd = departureDate ? String(departureDate).trim() : '';
  if (!pd || !dd) return;
  // ISO YYYY-MM-DD 可以直接字符串比较,避免时区
  if (!/^\d{4}-\d{2}-\d{2}/.test(pd) || !/^\d{4}-\d{2}-\d{2}/.test(dd)) return;
  if (pd.slice(0, 10) > dd.slice(0, 10)) {
    throw new BadRequestError(
      `购物日 ${pd} 晚于离境日 ${dd},逻辑不可能 (人没离境前怎么买的?)`,
      { code: 'departure_before_purchase' }
    );
  }
}

module.exports = {
  FUTURE_PURCHASE_DAYS_MAX,
  assertPurchaseBeforeDeparture,
  assertPurchaseMonthInRange,
  isPurchaseDateInBusinessRange,
  isWithinSixMonthsOfNow,
  normalizeWorkspaceKey,
  parsePurchaseDate,
  resolveOptionalWorkspaceForPurchaseDate,
  resolveWorkspaceForPurchaseDate,
};
