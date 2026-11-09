// 代理工作台 V2 — 展示口径纯模块(Task 10)。
// 状态文案克制(文本标签,不搞整页多彩 badge);候选模式必须带「候选」标记,
// 绝不能和已确认模式长得一样(V2 红线:候选≠已确认)。

export const STATUS_LABELS = Object.freeze({
  rephoto: '待重拍',
  recognizing: '识别中',
  ready_for_sync: '待建档',
  tour_pending: '待确认团号',
  review_pending: '待审核',
  needs_remedy: '待补救',
  needs_confirm: '待结算确认',
  passed: '已通过',
});

export function statusLabel(status) {
  return STATUS_LABELS[String(status || '')] || String(status || '—');
}

// 右栏任务列已下线(2026-07-18 用户拍板):groupTasksForRail/taskSourceMonthTag/
// taskSubtypeLabel/TASK_SUBTYPE_LABELS 随之移除(行内徽章只显数量,不用子类文案)。
// 后端 workflow_task 体系(回执/催收任务)照常运转,只是 A 页不再展示任务列。

// 客户行的模式展示:确认模式为主(实心),候选模式必须带「候选」前缀(空心)。
export function customerModeChips(customer = {}) {
  const confirmed = Array.isArray(customer.confirmedModes) ? customer.confirmedModes : [];
  const candidates = Array.isArray(customer.candidateModes) ? customer.candidateModes : [];
  const chips = confirmed.map((mode) => ({ mode, kind: 'confirmed', label: mode }));
  for (const mode of candidates) {
    if (confirmed.includes(mode)) continue;
    chips.push({ mode, kind: 'candidate', label: `候选·${mode}` });
  }
  return chips;
}

export function formatReceivedAt(iso) {
  const t = Date.parse(String(iso || ''));
  if (!Number.isFinite(t)) return '—';
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 收票日(2026-07-24 P2:列改「收票日」,按日即可,时刻精度意义不大;相对时间「N天前」另作副行)。
export function formatReceivedDay(iso) {
  const t = Date.parse(String(iso || ''));
  if (!Number.isFinite(t)) return '—';
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 收票时间第二行:相对时间「刚刚 / N分钟前 / N小时前 / N天前」(nowMs 可注入便于测试)。
export function relativeTime(iso, nowMs = Date.now()) {
  const t = Date.parse(String(iso || ''));
  if (!Number.isFinite(t)) return '';
  const diff = Math.max(0, nowMs - t);
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min}分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}小时前`;
  return `${Math.floor(hr / 24)}天前`;
}

// 免税店:仓库 storeKeys 是 canonical(LOTTE/THE SHILLA/*_DEPT…),表格展示中文短名。
const STORE_DISPLAY = Object.freeze({
  LOTTE: '乐天',
  'THE SHILLA': '新罗',
  'SHILLA IPARK': '爱宝客',
  SHINSEGAE: '新世界',
  HYUNDAI: '现代',
  LOTTE_DEPT: '乐天百货',
  SHINSEGAE_DEPT: '新世界百货',
  HYUNDAI_DEPT: '现代百货',
});
export function storeDisplayName(key) {
  const k = String(key || '').trim();
  return STORE_DISPLAY[k] || k;
}
// 一个客户可能跨多店(罕见),去重后中文串接;空则「—」。
export function customerStoresText(customer = {}) {
  const keys = Array.isArray(customer.storeKeys) ? customer.storeKeys : [];
  const names = [...new Set(keys.map(storeDisplayName).filter(Boolean))];
  return names.length ? names.join('/') : '—';
}

// 审核状态取色(规格:纯文字,只有已通过绿,其余黑)。返回 CSS class 后缀。
export function statusColorKind(status) {
  return String(status || '') === 'passed' ? 'ok' : 'plain';
}

// ── 顶部统计卡(2026-07-24 改版:X/Y = 当前代理/全部代理)────────────────────
// 旧口径(至 2026-07-13)桶互相重叠、加起来≠总数(needs_remedy 同时进「未完全通过」和「异常」),
// 用户一加发现对不上=看着不准。改版铁律:主行 3 桶建在 8 个**互斥** review_status 之上,
// 已完成+流程中+待人处理 = 客户组总数(可对账);活动/量指标进副行,不混进状态桶。
// review_status 全集(status_policy.STATUS_PRIORITY,8 个,单客户单一态):
//   rephoto / recognizing / ready_for_sync / tour_pending / review_pending / needs_remedy / needs_confirm / passed
// 2026-07-27 需求E③:「流程中/待人处理」用户反馈看不懂 —— 换成说人话的名字 + 一句话解释。
// 桶成员不变(仍互斥、和=总数),只改怎么念:
//   排队待审 = 识别中/待同步/待匹配团号/待审核 —— 正常往前走,没人卡着,不用管;
//   要人处理 = 重拍/待补救/待确认         —— 卡住了,不去动它就永远不动。
// 2026-07-30 第三轮:「要人处理」还是看不懂,而且「要人/待人」会被读成一个词
// (要人=重要人物、待人=对待他人),断词歧义是真的。改叫「待处理」。
// **不叫「异常」**——生产实测这个桶 18084 组里的分布是:
//   needs_confirm 4586(68.1%)= 必审全干完但组未结算 → **审完了等你点结算,不是异常**
//   rephoto        1745(25.9%)= 要重拍
//   needs_remedy    400( 5.9%)= 待补救(才是真异常,对应「异常补救」页)
// 68% 是正常流程的下一步,叫「异常」等于说系统有 4586 个毛病。
// hint 顺序也按真实占比重排(原来把 68% 那项放最后),并把「待确认」写全成
// 「待确认结算」——原词没说清确认什么。
const STAT_CARD_DEFS = Object.freeze([
  // 主行(互斥,和=总数)
  { key: 'total', label: '客户组总数', kind: 'total', row: 'main', tone: 'total', hint: '本月(或选中日)全部客户组' },
  { key: 'done', label: '已完成', statuses: ['passed'], row: 'main', tone: 'ok', hint: '已通过审核,不用再管' },
  {
    key: 'inflow',
    label: '排队待审',
    statuses: ['recognizing', 'ready_for_sync', 'tour_pending', 'review_pending'],
    row: 'main',
    tone: 'accent',
    // 0729 用词补漏:「待同步」违反 0727 拍板(界面不出现「同步」二字——那是全自动的
    // 内部管道,操作员既不用管也点不动)。该规则当时只在建档页落实,这里漏了。
    // ready_for_sync 的业务含义 = 识别完了、等着进审核批次,与建档页「已进审核」成对。
    hint: '识别中 / 待进审核 / 待匹配团号 / 待审核——都在正常队列里排着,轮到就处理,不用特别去动',
  },
  {
    key: 'needs',
    label: '待处理',
    statuses: ['rephoto', 'needs_remedy', 'needs_confirm'],
    row: 'main',
    tone: 'warn',
    hint: '待确认结算(最多)/ 要重拍 / 待补救——系统能做的都做完了,只能人动手;不去动它就一直停在这儿',
  },
  // 副行(活动 + 量,不进状态桶)
  // unit 写死 group:todayCount 是 COUNT(*) 客户组数,与「按组/按票」口径无关。
  // 不写死的话切到「按票」会显示「当日新增 7 张」——数字是组数、单位是张,纯误导。
  { key: 'today', label: '今日新增', dayLabel: '当日新增', kind: 'today', row: 'aux', tone: 'plain', unit: 'group' },
  { key: 'todayBatches', label: '今日已审', dayLabel: '当日已审', kind: 'todayBatches', row: 'aux', tone: 'plain', unit: 'batch' },
  { key: 'images', label: '总图数', kind: 'images', row: 'aux', tone: 'plain', unit: 'image' }, // 合计上方「图片数」列
]);

// P3 真票数下钻:unit='receipt' 时主行桶/总数用「小票数」口径(receiptsByStatus/totalReceipts),
// unit='group'(默认)用「客户组」口径(byStatus/totalCustomers)。互斥铁律两口径都成立
// (每客户的 receipt_count 归属其单一状态,各态票数之和=总票数)。
function cardValueOf(block, def, unit) {
  if (!block) return 0;
  if (def.kind === 'total') return (unit === 'receipt' ? block.totalReceipts : block.totalCustomers) || 0;
  if (def.kind === 'today') return block.todayCount || 0;
  // null = 该口径不适用(选了历史日:投影时间不是审核时间,后端拒绝给一个假的 0)。
  // 保留 null 一路传到组件,渲染成「—」;`|| 0` 会把"不知道"变成"是 0",正是要避免的。
  if (def.kind === 'todayBatches') {
    return block.todayReviewedBatches == null ? null : Number(block.todayReviewedBatches) || 0;
  }
  if (def.kind === 'images') return block.totalImages || 0;
  const byStatus = (unit === 'receipt' ? block.receiptsByStatus : block.byStatus) || {};
  return (def.statuses || []).reduce((n, s) => n + (byStatus[s] || 0), 0);
}

// 返回卡片:allCount(全部代理)/agentCount(当前代理,未选=null)/ratio/row('main'|'aux')/tone。
// 主行 3 状态桶互斥、和=总数。unit='group'|'receipt' 切换客户组/小票数口径(仅换主行数值,
// 总数卡标签随之变「客户组总数/总票数」;副行活动/图数不变)。
// 2026-07-27 需求E④:数字要带单位——「2700」看不出是组还是张。主行随口径切「组/张」,
// 副行按各自本义固定(批次/图)。dayActive=选中了某日 → 「今日」改称「当日」。
const UNIT_TEXT = Object.freeze({ group: '组', receipt: '张', batch: '批', image: '图' });

export function buildStatCards(summary, unit = 'group', dayActive = false) {
  const u = unit === 'receipt' ? 'receipt' : 'group';
  const all = summary?.visibleAll || null;
  const agent = summary?.selectedAgent || null;
  const hasAgent = Boolean(agent);
  return STAT_CARD_DEFS.map((def) => {
    const allCount = cardValueOf(all, def, u);
    const agentCount = hasAgent ? cardValueOf(agent, def, u) : null;
    const ratio = hasAgent && allCount > 0 && agentCount != null ? Math.min(1, agentCount / allCount) : 0;
    let label = (dayActive && def.dayLabel) ? def.dayLabel : def.label;
    if (def.key === 'total' && u === 'receipt') label = '总票数';
    return {
      key: def.key,
      label,
      hint: def.hint || '',
      unitText: UNIT_TEXT[def.unit || u] || '',
      allCount,
      agentCount,
      hasAgent,
      ratio,
      row: def.row,
      tone: def.tone,
    };
  });
}

// 投影落后提示:超过 5 分钟才提示(轻微滞后是常态,别拿黄条吓人)。
export function projectionLagText(lagMs) {
  if (!Number.isFinite(lagMs) || lagMs < 5 * 60 * 1000) return '';
  const minutes = Math.round(lagMs / 60000);
  // 同上:不出现「同步」。操作员要知道的只是"这页数字有多旧",不是内部管道叫什么。
  return `数据约 ${minutes} 分钟前的`;
}

// ── 2026-07-16 代理视图P1:行内四节点任务进度(用户A2:删回执列→组内可视化任务)──
// 节点语义只从投影真实字段推导,绝不造假绿:
//   收图=有原图;识别=状态已越过识别中;审核=必审全部完成(待结算确认/已通过);
//   结算=passed(口径:passed 必须 settled,见 status_policy)。
// rephoto 特殊:识别节点标警告(warn)——图有问题要重拍,后续节点不亮。
const PROGRESS_DONE_REVIEW = new Set(['needs_confirm', 'passed']);
const PROGRESS_RECOGNIZED = new Set(['ready_for_sync', 'tour_pending', 'review_pending', 'needs_remedy', 'needs_confirm', 'passed']);

export function customerProgressNodes(customer = {}) {
  const status = String(customer.reviewStatus || '');
  const hasImages = Number(customer.originalImageCount || 0) > 0;
  const isRephoto = status === 'rephoto';
  return [
    { key: 'intake', label: '收图', state: hasImages ? 'done' : 'todo' },
    {
      key: 'ocr',
      label: '识别',
      state: isRephoto ? 'warn' : (PROGRESS_RECOGNIZED.has(status) ? 'done' : (hasImages ? 'doing' : 'todo')),
    },
    {
      key: 'review',
      label: '审核',
      state: PROGRESS_DONE_REVIEW.has(status) ? 'done'
        : (['tour_pending', 'review_pending', 'needs_remedy'].includes(status) ? 'doing' : 'todo'),
    },
    { key: 'settle', label: '结算', state: status === 'passed' ? 'done' : 'todo' },
  ];
}

// 2026-07-27 需求E③:「下一步任务」原先渲染 收图/识别/审核/结算 四节点进度条——
// 每行都是同样四个词、状态只靠颜色深浅区分,读者只看到"每行都一样",等于没信息;
// 而且它讲的是审核进度(左边状态徽章已经说了),不是"任务"。
// 改为只渲染**真实存在的 pending 运营任务**(workflow_task,与配置台任务设置同源),
// 一条没有就留空 —— 空白本身就是"这组不用你管"的信号,比四个灰字有用。
const TASK_TYPE_LABEL = Object.freeze({
  send_upstream: '发上家',
  unreceived_followup: '催未收',
});
const TASK_SUBTYPE_LABEL = Object.freeze({
  correction: '发更正',
  s_activity: 'S活动',
  send_12: '12点前发',
  send_17: '17点前发',
  send_18: '18点前发',
});

// 任务 → 行内短标签。subtype 有更精确说法就用 subtype(如「发更正」比「发上家」有用得多)。
export function taskChipLabel(task = {}) {
  const sub = String(task.subtype || '');
  if (TASK_SUBTYPE_LABEL[sub]) {
    const base = TASK_TYPE_LABEL[String(task.taskType || '')] || '';
    // 时效类 subtype 是"什么时候发",要跟"发上家"一起念才完整;correction 自成一句。
    return sub === 'correction' ? TASK_SUBTYPE_LABEL[sub] : `${base}·${TASK_SUBTYPE_LABEL[sub]}`;
  }
  return TASK_TYPE_LABEL[String(task.taskType || '')] || String(task.taskType || '任务');
}

// 客户 → 该客户 pending 任务(行内徽章;确认勾选仍在右栏任务列,同一套 workflow_task)。
export function pendingTasksByCustomer(tasks = []) {
  const map = new Map();
  for (const task of tasks) {
    if (!task || task.status !== 'pending' || !task.customerId) continue;
    if (!map.has(task.customerId)) map.set(task.customerId, []);
    map.get(task.customerId).push(task);
  }
  return map;
}
