// 代理工作台 V2 — 深链构造 / returnTo 白名单 / stale 引用判定(Task 11 纯模块)。
// 安全边界:returnTo 只允许站内白名单路径——拒绝绝对 URL(http/https)、协议相对(//)、
// 控制字符、.. 路径段等一切能把用户带出站或绕出白名单的形态;白名单外站内路径也拒
// (deep link 打开的目标页自己会重新验权,这里只管「回跳不能被劫持」)。
// ⚠️ 本文件必须保持 ASCII 转义写法(\x00 这种四字符序列),不许出现字面控制字节——
// 否则 git 把整个文件当二进制,这条安全防线的后续改动在 diff/PR 里完全不可审计(复审 HIGH)。

// 确认站/回发已下线(2026-07-14);「本批次按代理」已下线(2026-07-17,代理视角=/agents)。
// 白名单只剩 queue,一切旧链接(view=agent/confirm/sendback)统一兜底 queue。
export const REVIEW_VIEWS = Object.freeze(['queue']);

// 允许回跳的站内前缀(带 query 完整保留:代理页的月份/代理/游标都在 query 里)
// ⚠️ 白名单要与**真的会深链进审核台的页面**一一对应(2026-08-01 补):
// /library 的格式预检每行都有「去审核台改」,却不在白名单里 —— sanitizeReturnTo('/library')
// 返回空串,深链 query 里根本没有返回参数,返回按钮不渲染,人跳过去就回不来了。
// 加页面时:先问"这个页面会不会往审核台深链",会就得进这张表,否则那条路是单程票。
const RETURN_TO_WHITELIST = Object.freeze(['/agents', '/library']);

// 返回按钮的文案(2026-08-01):原来硬编码「← 返回代理工作台」,从资料库跳过去
// 就算放行也会说错地方。按 returnTo 的真实前缀取名,认不出就用中性说法。
const RETURN_TO_LABELS = Object.freeze({ '/agents': '代理工作台', '/library': '资料库交付' });
export function returnToLabel(raw) {
  const path = String(raw || '').split(/[?#]/)[0];
  for (const [prefix, label] of Object.entries(RETURN_TO_LABELS)) {
    if (path === prefix || path.startsWith(prefix + '/')) return label;
  }
  return '上一页';
}

export function sanitizeReturnTo(raw) {
  const value = String(raw == null ? '' : raw).trim();
  if (!value || !value.startsWith('/')) return ''; // 必须站内绝对路径
  if (value.startsWith('//')) return ''; // 协议相对 → 出站,拒
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(value)) return ''; // 控制字符,拒
  const pathOnly = value.split(/[?#]/)[0];
  // '..'/'.' 路径段 → 穿越出白名单前缀(/agents/../settings),拒(复审 HIGH)
  if (pathOnly.split('/').some((seg) => seg === '..' || seg === '.')) return '';
  const allowed = RETURN_TO_WHITELIST.some(
    (prefix) => pathOnly === prefix || pathOnly.startsWith(prefix + '/')
  );
  return allowed ? value : '';
}

// 审核页深链(router.push 的入参形状;纯数据,不碰 router 实例)。
export function buildReviewDeepLink({ batchId, view = 'queue', group = '', task = '', returnTo = '' } = {}) {
  const id = String(batchId || '').trim();
  if (!id) return null;
  const safeView = REVIEW_VIEWS.includes(view) ? view : 'queue';
  const query = { view: safeView };
  if (String(group || '').trim()) query.group = String(group).trim();
  if (String(task || '').trim()) query.task = String(task).trim();
  const rt = sanitizeReturnTo(returnTo);
  if (rt) query.returnTo = rt;
  return { name: 'review', params: { batchId: id }, query };
}

// stale 引用:深链指向的组/任务在当前数据里已不存在(被结算/移动/删除)。
// 约定:找不到必须显式提示「记录已变化」,绝不静默跳到别的客户(V2 红线)。
export function isRefPresent(items = [], wanted, keyOf = (x) => x && x.key) {
  const key = String(wanted == null ? '' : wanted).trim();
  if (!key) return true; // 没带引用 = 无需定位,不算 stale
  return items.some((item) => String(keyOf(item) || '') === key);
}

export const STALE_GROUP_MESSAGE = '客户组已变化(可能被结算或移动),请刷新后重试';
export const STALE_TASK_MESSAGE = '任务已变化(可能已完成或撤销),请刷新后重试';
