// 代理工作台 V2 — query/筛选/竞态 纯逻辑(Task 9)。
// 放纯模块的原因:当前前端没有 Vitest,这里的东西用根仓库 Node test 直接验
// (tests/agent_workspace_frontend_state.test.js);Vue 组件流程归 Task 12 Playwright。
// 本模块禁止 import vue/pinia/router——保持可在 Node 里裸跑。

// 2026-07-16 代理视图P1:加 search(姓名/护照号/小票号/团号 一键搜);2026-07-24 加 day(按日筛选)
export const FILTER_KEYS = ['month', 'agentKey', 'mode', 'reviewStatus', 'ownerUserId', 'search', 'day'];

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function cleanStr(value) {
  return String(value == null ? '' : value).trim();
}

// route.query → 筛选状态。非法月丢弃(让默认月接管);ownerUserId 只收数字串。
export function filtersFromQuery(query = {}) {
  const month = cleanStr(query.month);
  const ownerRaw = cleanStr(query.ownerUserId);
  return {
    month: MONTH_RE.test(month) ? month : '',
    agentKey: cleanStr(query.agentKey),
    mode: cleanStr(query.mode),
    reviewStatus: cleanStr(query.reviewStatus),
    ownerUserId: /^\d+$/.test(ownerRaw) ? ownerRaw : '',
    search: cleanStr(query.search).slice(0, 60), // 搜索词入 URL 可分享;钳长防滥用
    day: DAY_RE.test(cleanStr(query.day)) ? cleanStr(query.day) : '', // 按日筛选(YYYY-MM-DD),非法丢弃
  };
}

// 筛选状态 → route.query(空值省略,保持 URL 干净可分享)。
export function queryFromFilters(filters = {}) {
  const query = {};
  for (const key of FILTER_KEYS) {
    const value = cleanStr(filters[key]);
    if (value) query[key] = value;
  }
  return query;
}

export function sameFilters(a = {}, b = {}) {
  return FILTER_KEYS.every((key) => cleanStr(a[key]) === cleanStr(b[key]));
}

// 默认月 = 最近有数据的月份(API /months 已按月倒序)。禁止从 workspaceKey 推导。
export function pickDefaultMonth(months = []) {
  for (const item of months) {
    const month = cleanStr(item && item.month);
    if (MONTH_RE.test(month)) return month;
  }
  return '';
}

// 竞态门:每列一个。后发请求覆盖先发——发起时 next() 领号,响应回来 isCurrent(token)
// 不是最新号就整包丢弃(不能只丢一半;切代理时旧响应晚到会污染新列表)。
export function createRaceGate() {
  let current = 0;
  return {
    next() {
      current += 1;
      return current;
    },
    isCurrent(token) {
      return token === current;
    },
    invalidate() {
      current += 1;
    },
  };
}

// 客户分页合并:只 append 当前筛选的响应;按 customerPk 去重(60s 轻刷/重试可能重叠)。
export function mergeCustomersPage(existing = [], incoming = [], { reset = false } = {}) {
  const base = reset ? [] : [...existing];
  const seen = new Set(base.map((c) => c && c.customerPk));
  for (const customer of incoming) {
    const pk = customer && customer.customerPk;
    if (!pk || seen.has(pk)) continue;
    seen.add(pk);
    base.push(customer);
  }
  return base;
}

// 60s 轻刷是否允许整页替换客户列表:翻过页(游标推进过)就不动,保滚动与选中。
export function canSoftRefreshCustomers({ loadedCount = 0, pageSize = 50, hasPaginated = false } = {}) {
  return !hasPaginated && loadedCount <= pageSize;
}
