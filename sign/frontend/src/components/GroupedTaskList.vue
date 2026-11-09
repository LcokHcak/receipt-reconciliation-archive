<script setup>
/**
 * GroupedTaskList — 把 tasks 按「客户组」分组折叠，替代原来的平铺表格。
 *
 * 分组键优先级：sourceGroupKey → sourceFolderPath → sourceGroupLabel → '未归组'
 * 显示名优先级：sourceGroupLabel → folderName → 分组键
 *
 * 折叠规则：
 *   - 默认展开「有待办」的组（pending > 0）
 *   - 已全部通过的组默认折叠 + 打 ✓
 *   - 用户手动点击切换的状态覆盖默认
 */

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { AlertTriangle, Camera, Check, CheckCheck, Clock, HelpCircle, Tag, Wrench } from 'lucide-vue-next'

import { reviewTier, reviewTierMeta } from '../lib/reviewTier'

// 「可疑」= 这条任务的框和同图另一条重叠、且票号相同 → 同一张票出了两条记录。
// 判据在后端(lib/review_doc_regions:suspect),这里**只消费不重算** ——
// 重算就会有第二套口径,而两套口径必漂(0731 刚被"框在哪"那件事教育过)。
//
// 为什么非要摆到队列上:它原来只在**点开那张图**之后才看得见。
// 可疑的后果是同一张票报两笔账,而审核员没有理由去点开一条"看起来正常"的任务 ——
// 于是这个信号在最需要它的时候是隐身的。
function isSuspectTask(task) {
  const regions = Array.isArray(task && task.docRegions) ? task.docRegions : []
  const mine = regions.find((r) => r && r.isCurrent)
  return Boolean(mine && mine.suspect)
}

// 组里有几条可疑。**单图组不渲染子行**(下面 v-if="group.total > 1"),
// 只把标挂在子行上的话,单图组里的可疑永远不会出现 —— 又是一次"看不见=没有"。
// 所以组头也要报。
function suspectCountOfGroup(group) {
  return (group && Array.isArray(group.tasks) ? group.tasks : []).filter(isSuspectTask).length
}
import {
  buildQueueSummary,
  buildReviewGroupDisplay,
  isTaskStanceLocked,
  sortTasksForReview,
  customerIdOfTask,
  formatQueueTime,
  friendlyTaskName,
  shortCustomerId,
  fullTimestamp,
  groupCreatedAt,
  groupKeyOfTask,
  isOriginalLikeTask,
  isTaskApproved,
  isTaskPending,
  matchedFieldOfGroup,
  matchesGroupSearch,
  normalizeDocType,
  normalizeQueueQuery,
  rawTaskName,
  rephotoReasonLabel,
  sortReviewGroups,
  waitTierOf,
} from '../lib/reviewDisplay'

const props = defineProps({
  tasks: { type: Array, default: () => [] },
  selectedTaskId: { type: String, default: '' },
  customerNameById: { type: Object, default: () => ({}) },
  // 组级结算状态(P2 实时队列):sourceGroupKey → { settlementStatus, settledAt }。
  // 来自 batch.sourceGroups(结算/确认模式时后端盖章),用于组状态徽章"已结算/待确认/待补救"。
  groupSettlementByKey: { type: Object, default: () => ({}) },
})

// go-remedy(P2 精准落位,2026-07-18):「待补救」徽章点击 → 父层跳补救台带批次+客户参数
// queue-change(任务流 2026-07-27):把**当前筛选+排序下**的队列顺序上报父层——
// 确认后的"下一组"必须跟着队列走,而不是存储顺序(改造前的核心缺口)。
// (上一/下一组按钮 2026-07-28 挪进父层面板头,i/N 由父层从 queue-change 自算,不再 emit)
const emit = defineEmits(['on-select', 'go-remedy', 'queue-change'])

// 组键/审核态判定复用共享真相源(与代理视图同口径,含"已拒绝");别在这里另写副本。
const groupKeyOf = groupKeyOfTask
const isPending = isTaskPending
const isApproved = isTaskApproved

function groupLabelOf(task) {
  return task.sourceGroupLabel
    || task.folderName
    || task.sourceFolderPath
    || task.sourceGroupKey
    || '未归组'
}

function groupFilterKey(group) {
  if (group.rephotoCount > 0) return 'rephoto'
  if (group.pendingCount === 0 && group.total > 0) return 'approved'
  return 'pending'
}

const activeFilter = ref('all')

// 队列排序(任务流 2026-07-27 扩到 5 种):oldest=FIFO 最早上传优先(**默认**,规格十二)/
// newest=最新上传在上/pendingFirst=待审优先/abnormalFirst=异常优先/agentGroup=代理连续。
// 记住选择(按浏览器,与 mergeSettleOnConfirm 同套路);老用户 localStorage 里的旧值不受默认切换影响。
const SORT_MODES = ['newest', 'oldest', 'pendingFirst', 'abnormalFirst', 'agentGroup']
function loadSortMode() {
  try {
    const saved = localStorage.getItem('reviewQueueSortMode')
    if (SORT_MODES.includes(saved)) return saved
  } catch { /* localStorage 不可用则用默认 */ }
  return 'oldest'
}
const sortMode = ref(loadSortMode())
watch(sortMode, (mode) => {
  try { localStorage.setItem('reviewQueueSortMode', mode) } catch { /* 忽略 */ }
})

// 相对时间需要"现在";每 60s 刷新一次让"8分钟前"不发霉(队列本身也常刷新触发重算)。
const nowMs = ref(Date.now())
let nowTimer = null
onMounted(() => { nowTimer = setInterval(() => { nowMs.value = Date.now() }, 60000) })
onBeforeUnmount(() => { if (nowTimer) clearInterval(nowTimer) })

// 组状态徽章:无待审工作时结算态优先(已结算/待确认模式/待补救),否则按审核进度。
// ⚠️结算后又追加图/重拍会产生新待审:此时结算态已过期,必须先按审核进度显示,
// 否则"已结算"徽章会把新活藏起来,违背实时队列初衷(reviewer HIGH)。
// 「下一步」胶囊(2026-07-11 用户拍板):一行只显示一颗,按动作优先级合成——
// 待匹配N > 重拍N > 待审N > 结算态(待确认/待补救/已结算) > 已审完。
// 原 状态徽章+待匹配chip+待审数+重拍chip 四件说的是同一件事,合并;分解进 title 悬停。
// 状态图标(2026-07-29 方案A,用户:原来那套"好像智障"):筛选页签与行内状态共用同一族。
// 原 ❗◐✕✓ 是四套不同字形的标点,笔画粗细/基线/光学尺寸都不一致,11px 窄栏里必然歪。
// 换 lucide 线性图标族:同笔画同方框;**形状自己说明含义**,颜色只作加强(色弱可用)。
//   待匹配=问号圈(系统不知道这票归谁,比"❗只是注意"精确)/ 待处理=时钟(在等,非出错)
//   需重拍=相机(直说要重拍)/ 已通过=对勾
// lucide-vue-next 是既有依赖(异常补救页/未收面板在用),零新增加载。
// 定义必须在 nextActionOf/queueFilters 之前(const 有 TDZ,别再挪到使用点之后)。
const QUEUE_STATUS_ICONS = Object.freeze({
  stance: HelpCircle,
  pending: Clock,
  rephoto: Camera,
  approved: Check,
})

function nextActionOf(group) {
  const stance = group.stanceLockedCount || 0
  const parts = []
  if (stance > 0) parts.push(`待匹配${stance}`)
  if (group.rephotoCount > 0) parts.push(`重拍${group.rephotoCount}`)
  const pureReview = Math.max(0, group.pendingCount - group.rephotoCount)
  if (pureReview > 0) parts.push(`待审${pureReview}`)
  const breakdown = parts.join(' · ')
  // icon:行内只出图标(需求③),text/tip 进悬停——图标与顶部筛选页签同一套符号。
  if (stance > 0) return { text: `待匹配 ${stance}`, icon: QUEUE_STATUS_ICONS.stance, cls: 'next-match', tip: breakdown }
  if (group.rephotoCount > 0) return { text: `重拍 ${group.rephotoCount}`, icon: QUEUE_STATUS_ICONS.rephoto, cls: 'next-rephoto', tip: breakdown }
  if (group.pendingCount > 0) return { text: `待审 ${group.pendingCount}`, icon: QUEUE_STATUS_ICONS.pending, cls: 'next-review', tip: breakdown }
  const settle = groupStatusOf(group)
  if (['settled', 'confirm', 'remedy'].includes(settle.cls)) {
    // 结算三态同族:已结算=双勾(审完+结算)/待确认模式=标签(要确认归哪个模式)/
    // 待补救=扳手(与「异常补救」页头同一个图标,跨页面一眼认得出是同一件事)
    const settleIcon = { settled: CheckCheck, confirm: Tag, remedy: Wrench }[settle.cls]
    return { text: settle.text, icon: settleIcon, cls: `next-${settle.cls}`, tip: settle.text }
  }
  return { text: '已审完', icon: QUEUE_STATUS_ICONS.approved, cls: 'next-done', tip: '组内全部处理完' }
}

// 图标的悬停文案:主状态 + 分解(仅当分解比主状态多出信息时才追加,
// 否则会出现「待审 1 · 待审1」这种自我重复)。
function statusTitleOf(next) {
  const text = String(next?.text || '')
  const tip = String(next?.tip || '')
  if (!tip) return text
  const same = tip.replace(/\s/g, '') === text.replace(/\s/g, '')
  return same ? text : `${text} · ${tip}`
}

function groupStatusOf(group) {
  const hasPendingWork = group.pendingCount > 0 || group.rephotoCount > 0
  const s = String((props.groupSettlementByKey[group.key] || {}).settlementStatus || '').trim()
  if (!hasPendingWork) {
    if (s === 'settled') return { text: '已结算', cls: 'settled' }
    if (s === 'needs_confirm') return { text: '待确认模式', cls: 'confirm' }
    if (s === 'needs_remedy') return { text: '待补救', cls: 'remedy' }
  }
  if (group.rephotoCount > 0) return { text: '需重拍', cls: 'rephoto' }
  if (group.total > 0 && group.pendingCount === 0) return { text: '已审完', cls: 'done' }
  if (group.approvedCount > 0) return { text: '审核中', cls: 'reviewing' }
  return { text: '待审核', cls: 'todo' }
}

const groups = computed(() => {
  const map = new Map()
  for (const task of props.tasks || []) {
    const key = groupKeyOf(task)
    if (!map.has(key)) {
      const display = buildReviewGroupDisplay(task, props.customerNameById)
      map.set(key, {
        key,
        label: groupLabelOf(task),
        displayName: display.name,
        customerId: display.id || customerIdOfTask(task),
        // 列表只显示末段序号(完整号在 title);与 displayName 相同则不显示(没有区分价值)
        shortId: (() => {
          const full = display.id || customerIdOfTask(task)
          return full && full !== display.name ? shortCustomerId(full) : ''
        })(),
        tasks: [],
        pendingCount: 0,
        rephotoCount: 0,
        approvedCount: 0,
        total: 0,
      })
    }
    const g = map.get(key)
    g.tasks.push(task)
    g.total += 1
    if (task.rephotoRequested) g.rephotoCount += 1
    if (isApproved(task)) g.approvedCount += 1
    if (isPending(task)) g.pendingCount += 1
    if (isTaskStanceLocked(task)) g.stanceLockedCount = (g.stanceLockedCount || 0) + 1
  }
  // 组时间 = 组创建时间(最早一张图);显示与排序都以它为准,稳定对应"第几个上传的组"。
  const enriched = Array.from(map.values()).map((g) => ({
    ...g,
    status: groupStatusOf(g),
    next: nextActionOf(g),
    createdAt: groupCreatedAt(g.tasks),
  }))
  // 排序逻辑抽到 reviewDisplay.sortReviewGroups(纯函数,享受行为测试;别在这里内联比较器)。
  return sortReviewGroups(enriched, sortMode.value)
})

const queueFilters = computed(() => {
  const items = [
    ['all', '全部', '', '全部客户组'],
    ['stance', '待匹配', QUEUE_STATUS_ICONS.stance, '组内还有小票没表态团号'],
    ['pending', '待处理', QUEUE_STATUS_ICONS.pending, '还有待审的图'],
    ['rephoto', '需重拍', QUEUE_STATUS_ICONS.rephoto, '有图被标了重拍'],
    ['approved', '已通过', QUEUE_STATUS_ICONS.approved, '组内已全部处理完'],
  ]
  return items.map(([key, label, icon, title]) => ({
    key,
    label,
    icon,
    title,
    count: key === 'all'
      ? groups.value.length
      : key === 'stance'
        ? groups.value.filter((group) => (group.stanceLockedCount || 0) > 0).length
        : groups.value.filter((group) => groupFilterKey(group) === key).length,
  }))
})

// 队列搜索(2026-07-13):按 姓名/护照号/团号/票号/客户号 找人。归一化大小写/空格/连字符。
// 0727#7 起搜索**无视状态页签**(全量搜):找人优先于页签收窄,见 visibleGroups 顶部注释。
const searchQuery = ref('')
const normalizedQuery = computed(() => normalizeQueueQuery(searchQuery.value))

// 显示已完成开关(任务流 P4,默认关):队列默认只留"还要处理的",审完的自动移出——
// 861 组滚动找下一条的时代结束。例外:①点「已通过」页签=明确要看完成件,照常显示;
// ②搜索态=找人必须全量搜(人可能已审完)。记 localStorage,跨会话保持。
const showCompleted = ref((() => {
  try { return localStorage.getItem('reviewQueueShowCompleted') === '1' } catch { return false }
})())
watch(showCompleted, (v) => {
  try { localStorage.setItem('reviewQueueShowCompleted', v ? '1' : '0') } catch { /* 忽略 */ }
})

const visibleGroups = computed(() => {
  // 搜索态全量搜,无视状态页签(0727反馈#7:小票号搜不回客户组)——
  // 原来搜索与页签取交集:人站在「待处理」页签搜一张已通过/需重拍组的票号,交集=空,
  // 用户感知就是"搜不到这张票"。找人必须跨状态(与 P4 "搜索态必须全量"同一原则),
  // 命中组行上本就带状态徽章,不丢上下文;清空搜索后页签筛选原样恢复。
  if (normalizedQuery.value) {
    return groups.value.filter((group) => matchesGroupSearch(group, normalizedQuery.value))
  }
  let list = groups.value
  if (activeFilter.value === 'stance') {
    // 待匹配=组内还有未表态小票(票级两步流),与审核进度筛选正交。
    list = list.filter((group) => (group.stanceLockedCount || 0) > 0)
  } else if (activeFilter.value !== 'all') {
    list = list.filter((group) => groupFilterKey(group) === activeFilter.value)
  } else if (!showCompleted.value) {
    // 「全部」页签 + 开关关 → 隐藏已审完的组(P4 默认只看待办;搜索态已在上面提前返回)
    list = list.filter((group) => groupFilterKey(group) !== 'approved')
  }
  return list
})

// 「全部」页签的诚实标注(0729 生产复查):页签算的是**全部组**(860),而 P4 默认
// 把已审完的滤掉了,列表实际只有 100 行。760 的落差界面上一个字都没说,操作员滑到底
// 只会得出"我的组丢了"。开关「显示已完成」在工具行里,但没人会把两件事联系起来——
// 缺口出现在哪就在哪解释,所以说明放列表末尾(人正是在那里发现数不对的)。
const hiddenDoneCount = computed(() => {
  if (normalizedQuery.value) return 0 // 搜索态本来就全量搜,不存在隐藏
  if (activeFilter.value !== 'all' || showCompleted.value) return 0
  return groups.value.filter((group) => groupFilterKey(group) === 'approved').length
})

// ── 任务流(2026-07-27)────────────────────────────────────────────────────
// 概览三桶(与页签计数同一函数推导,天然一致)+ 当前组定位 + 队列顺序上报。
const summary = computed(() => buildQueueSummary(groups.value))

const selectedGroupKey = computed(() => {
  const task = (props.tasks || []).find((t) => t && t.id === props.selectedTaskId)
  return task ? groupKeyOf(task) : ''
})

// 队列顺序上报:确认后的"下一组"必须跟当前筛选+排序走。上报的是**按队列顺序展平的任务id**
// (组内按 护照→小票→其它 的显示序)。用 join 串比对防重复 emit(computed 每次都是新数组)。
let lastQueueSig = ''
watch(visibleGroups, (list) => {
  const taskIds = []
  for (const g of list) {
    for (const t of sortTasksForReview(g.tasks)) taskIds.push(t.id)
  }
  const sig = taskIds.join(',')
  if (sig === lastQueueSig) return
  lastQueueSig = sig
  // summary 一并上报(2026-07-28 完成卡):批次审完时右侧完成卡要报「已通过X组/需重拍Y组」,
  // 组桶口径必须与左栏概览同源(buildQueueSummary),不许父层对 tasks 另算一套。
  emit('queue-change', { taskIds, groupKeys: list.map((g) => g.key), summary: summary.value })
}, { immediate: true })

const manualToggle = ref(new Map())
const allExpanded = ref(false) // 展开/收起切换按钮状态

function isExpanded(group) {
  // 搜索态:命中的组本来就少,直接全展开省一次点击(找人场景=看这个人的票)
  if (normalizedQuery.value) return true
  if (manualToggle.value.has(group.key)) return manualToggle.value.get(group.key)
  // 默认：有待办就展开，全通过就折叠
  return group.pendingCount > 0
}

function toggle(group) {
  // 搜索态强制全展开,此时点标题若写 manualToggle=当下无反馈、清空搜索后组"幽灵折叠"
  // (体检 MEDIUM)——搜索中折叠开关直接不作用。
  if (normalizedQuery.value) return
  manualToggle.value.set(group.key, !isExpanded(group))
  // 触发响应式更新
  manualToggle.value = new Map(manualToggle.value)
}

function setAllGroups(expanded) {
  if (normalizedQuery.value) return // 同上:搜索态不写隐藏折叠状态
  const next = new Map()
  for (const group of visibleGroups.value) {
    next.set(group.key, expanded)
  }
  manualToggle.value = next
}

// 选中的文件所在组必须展开;展开后滚到该行(错误横幅「定位到这张图」跳长列表时,
// 只展开不滚动等于没定位——2026-07-12 报障:操作员点了定位还是找不到那张小票)。
const rootEl = ref(null)
watch(() => props.selectedTaskId, (id) => {
  if (!id) return
  const task = (props.tasks || []).find((t) => t.id === id)
  if (!task) return
  const key = groupKeyOf(task)
  if (!isExpanded({ key, pendingCount: 0 })) {
    manualToggle.value.set(key, true)
    manualToggle.value = new Map(manualToggle.value)
  }
  nextTick(() => {
    // 任务流 P3:当前项居中(nearest 会贴边,连续确认时下一条永远压在视口底缘,看不到再下面排的什么)。
    // 单图组无子行(P5),滚动目标退到组头。
    const target = rootEl.value?.querySelector?.('.task-row.active')
      || rootEl.value?.querySelector?.('.group-header.current')
    target?.scrollIntoView?.({ block: 'center' })
  })
})

function select(task) {
  emit('on-select', task.id)
}

// 组头点击(任务流 P5):单图组直接选中那张图开审——「客户组→原图→点击」三层砍成一层;
// 多图组保持展开/收起(要看清组里有什么)。
function onHeaderClick(group) {
  if (group.total === 1 && group.tasks[0]) {
    select(group.tasks[0])
    return
  }
  toggle(group)
}

// 「定位到这张图」联动(体检 HIGH#2):搜索词/状态筛选可能把目标组整个滤掉,
// 定位就静默失效(0fc6e4a 刚修的症状换个根因复现)。父层跳转前先调这里清障。
function revealForLocate() {
  searchQuery.value = ''
  activeFilter.value = 'all'
  showCompleted.value = true // 目标组可能已审完被 P4 默认隐藏——定位前必须放出来
}
// Ctrl+F / Esc(任务流 P8):父层全局快捷键需要够到这里的搜索框
const searchInputRef = ref(null)
function focusSearch() {
  searchInputRef.value?.focus?.()
  searchInputRef.value?.select?.()
}
function clearSearch() {
  searchQuery.value = ''
}
// setFilter(2026-07-28 完成卡联动):批次审完后右侧「处理需重拍」一键把队列切到 ✕ 筛选
function setFilter(key) {
  activeFilter.value = key
}
defineExpose({ revealForLocate, focusSearch, clearSearch, setFilter })

// 子行状态图标:与组状态/筛选页签同一套符号(2026-07-28 参考图对齐,替代四字文字徽章)。
// 优先级同组级 nextActionOf:重拍 > 待匹配团号 > 已通过 > 待处理。
function taskStatusIcon(task) {
  if (task.rephotoRequested) {
    // 原因分键(0727反馈#10):有原因带上(重拍·模糊),前台补拍不用猜;旧数据无原因照旧
    const reason = rephotoReasonLabel(task.rephotoReason)
    return { icon: QUEUE_STATUS_ICONS.rephoto, cls: 'next-rephoto', text: reason ? `重拍·${reason}` : '需重拍' }
  }
  if (isTaskStanceLocked(task)) return { icon: QUEUE_STATUS_ICONS.stance, cls: 'next-match', text: '待匹配团号' }
  if (isApproved(task)) return { icon: QUEUE_STATUS_ICONS.approved, cls: 'next-done', text: '已通过' }
  return { icon: QUEUE_STATUS_ICONS.pending, cls: 'next-review', text: '待处理' }
}

function displayTasks(group) {
  const counters = new Map()
  // 组内显示顺序:护照→小票→其它(原图殿后);只排显示不动存储(共享 sortTasksForReview)。
  return sortTasksForReview(group.tasks).map((task) => {
    let sequence = 1
    if (!isOriginalLikeTask(task)) {
      const type = normalizeDocType(task)
      sequence = (counters.get(type) || 0) + 1
      counters.set(type, sequence)
    }
    return {
      task,
      name: friendlyTaskName(task, sequence),
      rawName: rawTaskName(task),
      meta: task.docTypeFinal || task.docTypeAuto || task.docType || '未分类',
      statusIcon: taskStatusIcon(task),
    }
  })
}
</script>

<template>
  <div ref="rootEl" class="grouped-list">
    <div v-if="groups.length === 0" class="empty">暂无客户组</div>
    <div v-else class="grouped-list-toolbar">
      <!-- 搜索置顶(2026-07-26 用户需求①):搜索是进队列的第一动作,放在筛选之上。
           0731 再往上提到「任务概览」之前 —— 两份需求抢过同一个位置:
           用户 0724-C2-1 要「搜索框放到【客户组队列】上方」,而 GPT 那份规格要在标题下加概览块,
           概览先渲染就把搜索顶下去了(实机实测:搜索框距左栏顶 99px)。
           取舍理由:概览是**看**的(24组/完成/待办,扫一眼,在哪都看得见),
           搜索是**够**的(要用手点、靠肌肉记忆),够的东西必须位置固定且靠上。
           所以搜索置顶、概览让位 —— 两个需求都还在,只换了顺序。 -->
      <div class="queue-search-row">
        <span class="queue-search-icon" aria-hidden="true">🔍</span>
        <input
          ref="searchInputRef"
          v-model="searchQuery"
          type="search"
          class="queue-search-input"
          placeholder="搜 姓名/护照/团号/票号(仅本批次)"
          title="搜索:姓名/护照号/团号/小票号/客户号 —— 快捷键 Ctrl+F&#10;⚠️ 只搜「本批次」已加载的客户组。别的批次的票号在这里搜不到(不是号错了),要跨批次找请去客户中心的搜索框。"
          aria-label="搜索客户组(仅本批次)"
        >
        <button v-if="searchQuery" type="button" class="queue-search-clear" title="清空搜索" @click="searchQuery = ''">✕</button>
        <span v-if="normalizedQuery" class="queue-search-count">{{ visibleGroups.length }} 组命中</span>
        <!-- 0 命中时把范围说出来(2026-08-01):搜不到的最常见原因不是"号错了",而是
             这个框只搜本批次 —— 客服拿着别的批次的票号来问,审核员在这儿永远搜不到,
             而界面此前一个字都没交代。给一条去处,别让人卡在"我明明有这个号"。 -->
        <span v-if="normalizedQuery && visibleGroups.length === 0" class="queue-search-scope">
          本批次没有。跨批次找请去<RouterLink to="/agents">客户中心</RouterLink>搜。
        </span>
      </div>
      <!-- 任务概览(任务流 P6):三桶与页签计数同一函数推导,数字天然一致;固定不随列表滚动 -->
      <div class="queue-summary" aria-label="本批次任务概览">
        <div class="qs-nums">
          <!-- 标签短写(2026-07-28 部署前边界复查):按生产真实数字实测,「本批次143组 已完成128
               待处理132 异常15」全上三位数时 255px > 247px 又会换行。面板头已有「客户组队列」
               语境,「本批次/已/处理」都是冗余字。短写后全三位数 209px、四位数总数也不破行。 -->
          <span class="qs-total" title="本批次客户组总数"><strong>{{ summary.total }}</strong> 组</span>
          <span class="qs-done" title="已完成(组内全部处理完)">完成 {{ summary.done }}</span>
          <span class="qs-pending" title="待办(还有待审/待匹配的图)">待办 {{ summary.pending }}</span>
          <span v-if="summary.abnormal" class="qs-abn" title="异常(有图被标了重拍)">异常 {{ summary.abnormal }}</span>
          <!-- ‹ i/N › 导航已挪到面板头(2026-07-28 参考图对齐):塞在这行必换行,拥挤元凶之一 -->
        </div>
        <div class="qs-bar" aria-hidden="true"><i :style="{ width: `${Math.round(summary.ratio * 100)}%` }" /></div>
      </div>
      <!-- 筛选页签带状态图标(需求③):图标与下方行内状态图标同一套,一眼对得上 -->
      <div class="queue-filter-row" role="tablist" aria-label="客户组状态筛选">
        <!-- 零值页签压暗(UI评估④):位置保留(肌肉记忆),但视觉退后——「待匹配 0」和
             「待匹配 2」长得一样重,就是在骗注意力。 -->
        <button
          v-for="filter in queueFilters"
          :key="filter.key"
          type="button"
          :class="[{ active: activeFilter === filter.key, 'qf-zero': filter.count === 0 && filter.key !== 'all' }, `qf-${filter.key}`]"
          :title="filter.title"
          @click="activeFilter = filter.key"
        >
          <component :is="filter.icon" v-if="filter.icon" class="qf-icon" :size="12" :stroke-width="2" aria-hidden="true" />
          <!-- 图标+数字(2026-07-28 参考图对齐):「❗待匹配 2」五个页签带全文字必然挤成三行,
               图标就是含义(与行内状态同一套符号),文字进 title/aria。只有「全部」保留文字。 -->
          <span v-if="filter.key === 'all'" class="qf-label">{{ filter.label }}</span>
          <span v-else class="sr-only">{{ filter.label }}</span>
          <em>{{ filter.count }}</em>
        </button>
      </div>
      <div class="queue-tools-row">
        <!-- 选项文案短写(UI评估③):280px 面板里「待审优先(已通过沉底)」一项就吃掉 150px,
             把右边的开关和按钮全挤出可视区。语义解释挪进 title。 -->
        <!-- 「排序」二字省掉(2026-07-28 收行宽):下拉本身就是排序,label 进 aria/title -->
        <label class="queue-sort" title="排序方式——FIFO=最早上传的组排最前;待审优先=已通过沉底;异常优先=重拍组置顶;代理连续=同代理的组连着审">
          <select v-model="sortMode" aria-label="队列排序方式">
            <option value="oldest">最早在前(FIFO)</option>
            <option value="newest">最新在前</option>
            <option value="pendingFirst">待审优先</option>
            <option value="abnormalFirst">异常优先</option>
            <option value="agentGroup">代理连续</option>
          </select>
        </label>
        <!-- P4:默认只看待办;开了才显示已审完的组(点「已通过」页签或搜索时不受此限) -->
        <label class="queue-show-done" title="默认隐藏已审完的组;需要回看时打开">
          <input v-model="showCompleted" type="checkbox"> 显示已完成
        </label>
        <!-- 「全部」二字省掉(实测工具行 267>247px 差 20px,这里省 24px 正好收进一行);
             语义在 title 里,按钮作用域本来就是全部组。 -->
        <button type="button" :title="allExpanded ? '收起全部客户组' : '展开全部客户组'" @click="setAllGroups(!allExpanded); allExpanded = !allExpanded">
          {{ allExpanded ? '收起' : '展开' }}
        </button>
      </div>
    </div>
    <div v-if="groups.length > 0 && visibleGroups.length === 0" class="empty">当前筛选下暂无客户组</div>
    <section v-for="group in visibleGroups" :key="group.key" class="group">
      <!-- 组头三合一(任务流):①当前组高亮(左蓝条+浅蓝底+「当前审核」)②单图组点击直接开审
           (P5,无 caret 无子层)③时间改相对等待时长+超时分级(十一,绝对时间在悬停) -->
      <header
        class="group-header"
        :class="{
          done: group.pendingCount === 0 && group.total > 0,
          current: group.key === selectedGroupKey,
          'single-direct': group.total === 1,
        }"
        @click="onHeaderClick(group)"
      >
        <span v-if="group.total > 1" class="caret">{{ isExpanded(group) ? '▾' : '▸' }}</span>
        <span v-else class="caret caret-single" title="单图客户组:点击直接开审">·</span>
        <div class="group-title">
          <strong>{{ group.displayName }}</strong>
          <!-- 客户号:组名代理化(2026-07-14)后同一代理多组同名,靠它区分是哪位客户。
               2026-07-26 只留末段序号(完整号在悬停里)——CL+日期段与批次建档日重复,
               列宽不够时会被截成没用的「C…」。 -->
          <span
            v-if="group.shortId"
            class="group-id"
            :title="group.customerId"
          >{{ group.shortId }}</span>
          <em v-if="group.key === selectedGroupKey" class="current-group-tag">当前审核</em>
          <em v-if="normalizedQuery" class="hit-field">{{ matchedFieldOfGroup(group, normalizedQuery) ? `命中:${matchedFieldOfGroup(group, normalizedQuery)}` : '' }}</em>
        </div>
        <div class="group-counters">
          <span
            v-if="group.createdAt"
            class="group-time"
            :class="`wait-${waitTierOf(group.createdAt, nowMs, group.pendingCount > 0 || group.rephotoCount > 0)}`"
            :title="`上传于 ${fullTimestamp(group.createdAt)}`"
          >{{ formatQueueTime(group.createdAt, nowMs) }}</span>
          <!-- 状态改图标(需求③):不再堆文字。完整文案(含 待匹配3·重拍1 分解)进悬停。
               待补救仍可点(P2 精准落位):直达补救台该批次+该客户。 -->
          <span
            v-if="group.next.cls === 'next-remedy'"
            class="group-next next-remedy group-next-clickable"
            role="button"
            :title="`${group.next.text} —— 点击去补救台处理该客户`"
            @click.stop="emit('go-remedy', group)"
          ><component :is="group.next.icon" :size="12" :stroke-width="2" /></span>
          <span
            v-else
            class="group-next"
            :class="group.next.cls"
            :title="statusTitleOf(group.next)"
          ><component :is="group.next.icon" :size="12" :stroke-width="2" /></span>
          <!-- 组头也报可疑数:单图组不渲染子行(下面 v-if="group.total > 1"),
               只挂子行的话,单图组里的可疑永远看不见 —— 又一次"看不见=没有"。
               多图组折叠时同理。 -->
          <span
            v-if="suspectCountOfGroup(group)"
            class="group-suspect"
            :title="`本组 ${suspectCountOfGroup(group)} 条疑似重复(框重叠且票号相同)—— 不核对会按两笔账报出去`"
          ><AlertTriangle :size="12" :stroke-width="2" aria-hidden="true" />{{ suspectCountOfGroup(group) }}</span>
        </div>
      </header>
      <!-- 单图组不渲染子层(P5):组头即任务;多图组保持展开列表 -->
      <ul v-if="group.total > 1 && isExpanded(group)" class="group-tasks">
        <li
          v-for="item in displayTasks(group)"
          :key="item.task.id"
          :class="['task-row', { active: item.task.id === selectedTaskId }]"
          :title="item.rawName"
          @click="select(item.task)"
        >
          <span
            class="tier-dot"
            :style="{ background: reviewTierMeta(reviewTier(item.task)).dot }"
            :title="reviewTierMeta(reviewTier(item.task)).label"
            aria-hidden="true"
          />
          <div class="task-main">
            <!-- 「当前」pill 删除(2026-07-28 参考图对齐):行高亮(蓝左条+蓝底)已标当前,
                 组头又有「当前审核」标签,三处同词是纯噪音。 -->
            <span class="task-name">{{ item.name }}</span>
            <!-- 可疑 = 要处理 → 按硬规则用琥珀(不是蓝、也不做成胶囊:它是状态不是数量) -->
            <AlertTriangle
              v-if="isSuspectTask(item.task)"
              class="task-suspect"
              :size="12"
              :stroke-width="2"
              title="疑似和同图另一条是同一张票(框重叠且票号相同)—— 不核对会按两笔账报出去"
            />
          </div>
          <!-- 文字徽章 → 圆形图标(与组状态/筛选页签同一套符号):参考图子行只有一个 ✓,
               「已通过/需重拍」四字徽章 × 几十行 = 一整列重复文字。文案进 title。 -->
          <span
            class="group-next"
            :class="item.statusIcon.cls"
            :title="item.statusIcon.text"
          ><component :is="item.statusIcon.icon" :size="12" :stroke-width="2" aria-hidden="true" /></span>
        </li>
      </ul>
    </section>
    <!-- 列表末尾交代被 P4 隐藏的组:数字对不上的困惑正是在滑到底那一刻产生的 -->
    <p v-if="hiddenDoneCount > 0" class="queue-hidden-note">
      另有 {{ hiddenDoneCount }} 组已审完,默认不显示
      <button type="button" class="queue-hidden-show" @click="showCompleted = true">显示</button>
    </p>
  </div>
</template>

<style scoped>
.grouped-list {
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: 8px 8px 0;
  /* 兜底(UI评估①):280px 面板里任何一行溢出都会给整栏挂上横向滚动条,
     把队列变成"左右都要滚"的双轴地狱。上面已让各行可换行,这里把底封死。 */
  max-width: 100%;
  overflow-x: hidden;
}

.grouped-list-toolbar {
  position: sticky;
  top: -8px;
  z-index: 2;
  display: grid;
  gap: 5px; /* 2026-07-28 收紧:工具区目标 4 行 ≈150px,行距一起省 */
  margin: -8px -8px 0;
  padding: 8px;
  border-bottom: 1px solid var(--line);
  background: var(--surface);
}

.queue-filter-row {
  display: flex;
  flex-wrap: wrap;
  gap: 3px; /* 999组压测:全桶三位数时 4px 间隙仍差 12px 换行,收到 3px */
}

/* image9 设计稿(0728 去皮):页签不再是描边/填充胶囊——无边框安静文字行,
   选中=下划线+主文本色。胶囊只作状态不作筛选(d70b9cc4 硬规则同源)。 */
.queue-filter-row button {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  min-height: 24px;
  border: none;
  border-bottom: 2px solid transparent;
  border-radius: 0;
  padding: 0 4px;
  background: transparent;
  color: var(--muted);
  /* 11px(999组压测):12px 下全桶三位数合计 259 > 247 仍换行;11px 后 ~212,
     四位数也有余量。计数是扫读数字,11px 足够。 */
  font-size: 11px;
  font-weight: 500; /* 硬规则:全站 400/500 两级,700 作废 */
}

.queue-filter-row button.active {
  border-bottom-color: var(--accent);
  color: var(--text);
}

.queue-filter-row em {
  font-style: normal;
  opacity: 0.72;
}

/* 零值页签:压暗但不消失(位置稳定=可盲点),选中态不压(用户主动点的要看清) */
.queue-filter-row button.qf-zero:not(.active) { opacity: 0.45; }

/* 仅供读屏:图标页签的文字含义不丢(视觉上收进 title 悬停) */
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

/* ── 任务概览(P6):数字行 + 细进度条;克制配色(绿=完成/蓝灰=待处理/红=异常) ──
   ⚠️面板固定 280px(style.css review-console-layout):这行**必须可换行**。
   上一版 nowrap 直接把 ‹1/6› 顶出右缘 + 撑出横向滚动条(2026-07-27 生产截图实锤)。 */
.queue-summary { display: grid; gap: 5px; min-width: 0; padding-bottom: 7px; border-bottom: 1px solid var(--line); }
.qs-nums {
  display: flex; flex-wrap: wrap; align-items: center;
  gap: 3px 8px; font-size: 12px; color: var(--muted); min-width: 0;
}
.qs-nums > span { white-space: nowrap; } /* 单项内部不断字,断行发生在项之间 */
.qs-total { color: var(--text); }
.qs-total strong { font-size: 14px; }
.qs-done { color: #475569; }
.qs-pending { color: #1e40af; }
.qs-abn { color: #b91c1c; font-weight: 500; }
/* (‹ i/N › 导航 2026-07-28 挪进面板头,样式在 ReviewView .queue-nav) */
.qs-bar { height: 4px; border-radius: 999px; background: var(--line); overflow: hidden; }
.qs-bar i { display: block; height: 100%; background: #94a3b8; border-radius: 999px; transition: width 0.25s; }

.queue-show-done {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 11px; color: var(--muted); font-weight: 500; cursor: pointer; white-space: nowrap;
}

.queue-search-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.queue-search-icon { flex: none; font-size: 12px; opacity: 0.55; }
/* 筛选页签:图标 + 名称 + 计数,与行内状态同一套符号 */
.queue-filter-row .qf-icon { display: block; flex: none; }
.queue-filter-row .qf-stance .qf-icon { color: #075985; }
.queue-filter-row .qf-pending .qf-icon { color: #b45309; }
.queue-filter-row .qf-rephoto .qf-icon { color: #b91c1c; }
.queue-filter-row .qf-approved .qf-icon { color: #64748b; } /* 0729 绿删补漏:已通过=正常态灰阶 */

.queue-search-input {
  flex: 1;
  min-width: 0;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 13px;
}

.queue-search-input:focus {
  border-color: var(--accent, #2563eb);
  outline: none;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.12);
}

.queue-search-clear {
  border: none;
  background: #eef2f7;
  border-radius: 6px;
  padding: 4px 8px;
  cursor: pointer;
  font-size: 12px;
  color: #475569;
}

.queue-search-count {
  flex: 0 0 auto;
  font-size: 12px;
  color: #2563eb;
  white-space: nowrap;
}
/* 0 命中时的范围说明:琥珀=待人处理,与全站状态色一致(搜不到不是错误,是范围不对) */
.queue-search-scope {
  flex: 1 1 100%;
  font-size: 12px;
  color: #92400e;
  margin-top: 4px;
}
.queue-search-scope a { color: #1863c6; }

.queue-tools-row {
  display: flex;
  flex-wrap: wrap; /* 280px 面板:放不下就换行,绝不截断控件(UI评估③) */
  align-items: center;
  justify-content: space-between;
  gap: 4px 6px;
}

.queue-sort {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--muted);
  font-weight: 500;
}

.queue-sort select {
  min-height: 24px; /* 2026-07-28 收紧:排序/开关/展开三件必须同排一行 */
  max-width: 118px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  padding: 0 4px;
  background: #fff;
  color: var(--text);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}

.queue-tools-row button {
  min-height: 24px;
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  padding: 0 8px;
  background: #fff;
  color: var(--text);
  font-size: 12px;
  font-weight: 500;
}

.queue-tools-row button:hover,
.queue-filter-row button:hover {
  background: var(--surface-soft);
}

.queue-filter-row button.active:hover {
  background: var(--accent);
}

/* 紧凑队列(P3):连续单行,分隔线代替卡片间距,一屏可见组数 6→15 */
.group {
  border-bottom: 1px solid var(--line);
  background: var(--surface);
}
.group:last-child { border-bottom: none; }

.group-header {
  display: grid;
  grid-template-columns: 16px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 11px 8px;
  cursor: pointer;
  transition: background 0.12s;
}

.group-header:hover {
  background: #eef3fa;
}

/* 0729 绿删补漏:审完的组行原本淡绿底 #f6fbf8。审完=不用管了,底色只需比未审的
   稍暗一点点表示"已归档",不该用绿色继续宣告成功。 */
.group-header.done {
  background: #f8fafc;
}

.caret {
  color: var(--muted);
  font-size: 11px;
  text-align: center;
}

/* 单行横排:名 · id · 文件数 · 状态徽章 · 模式;名过长省略,整体不换行 */
.group-title {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  overflow: hidden;
}

.group-title strong {
  flex: 1;
  min-width: 64px;
  font-size: 14px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.group-id {
  flex-shrink: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.group-title .muted {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--muted);
}
.files-count::after { content: '文件'; opacity: 0.7; }
/* 状态徽章移到右侧固定列(下面 .group-counters),不被标题行的省略裁掉 */

/* 「下一步」胶囊:一行一颗,颜色即含义,永不换行(竖字bug根除) */
/* 行内状态改纯图标(2026-07-26 需求③):圆形色底 + 符号,文案进 title 悬停。
   固定 18px 圆点,几十行叠起来右缘对齐、不再被长短不一的文字撑得参差。 */
.group-next {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 500;
  line-height: 1;
  flex-shrink: 0;
}
.group-next.next-match { background: #e0f2fe; color: #075985; }
.group-next.next-rephoto { background: #fee2e2; color: #b91c1c; }
.group-next.next-review { background: #fff4dd; color: #b45309; }
.group-next.next-settled { background: #f1f5f9; color: #475569; }

/* 可疑重复(0731):同一张票出了两条记录 → 不核对就按两笔账报出去,属「要处理」,
   所以用琥珀。**不给底色不给圆角**:组头那个带数字,套上胶囊正好踩「胶囊只作状态」。
   子行那个是纯状态,但和它做成一套更省一个视觉概念。 */
.task-suspect {
  color: var(--warning);
  flex-shrink: 0;
  margin-left: 4px;
}
.group-suspect {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  color: var(--warning);
  font-size: 11px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.group-next.next-confirm { background: #e0f2fe; color: #075985; }
.group-next.next-remedy { background: #fef3c7; color: #b45309; }
.group-next.next-done { background: #f1f5f9; color: #475569; } /* 0729 绿删补漏:已审完=正常,灰阶 */

/* 列表末尾的隐藏说明:纯交代事实 → 灰阶;「显示」是动作 → 蓝(硬规则:蓝只给可点击) */
.queue-hidden-note {
  margin: 8px 0 4px;
  padding: 0 4px;
  font-size: 11px;
  color: var(--muted);
  text-align: center;
}
.queue-hidden-show {
  border: none;
  background: none;
  padding: 0 2px;
  font-size: 11px;
  color: var(--accent);
  cursor: pointer;
  text-decoration: underline;
}

/* 待补救徽章可点(P2 精准落位):hover 提亮+描边,明示这是入口不是纯状态 */
.group-next-clickable { cursor: pointer; border: 1px solid #f59e0b55; }
.group-next-clickable:hover { background: #fde68a; text-decoration: underline; }

.group-counters {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
}


/* 组上传时间(任务流十一):相对等待时长 + 超时分级着色;绝对时间在悬停 */
.group-time {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--muted);
  white-space: nowrap;
  cursor: default;
}
.group-time.wait-warning { color: #b45309; }
.group-time.wait-overdue { color: #b91c1c; }

/* 当前组高亮(任务流七):左蓝定位条 + 浅蓝底 + 「当前审核」标签;单图组组头即任务 */
.group-header.current {
  border-left: 4px solid var(--accent);
  background: var(--accent-weak);
  box-shadow: inset 0 0 0 1px var(--accent);
}
/* 「当前审核」降噪(0728 image9 对齐):行高亮(蓝左条+浅蓝底)已是主标识,
   标签从实心蓝胶囊降为蓝字纯文字——任务流规格要标签在,硬规则要少填色,两头都占。 */
.current-group-tag {
  flex: 0 0 auto;
  padding: 0;
  background: transparent;
  color: var(--accent);
  font-size: 10px;
  font-style: normal;
  font-weight: 500;
}
.hit-field { flex: 0 0 auto; font-size: 10px; font-style: normal; color: #2563eb; }
.caret-single { opacity: 0.4; }




.group-tasks {
  list-style: none;
  margin: 0;
  padding: 0;
  border-top: 1px solid var(--line);
}

.tier-dot {
  position: absolute;
  left: 16px;
  top: 50%;
  transform: translateY(-50%);
  width: 9px;
  height: 9px;
  border-radius: 50%;
}

.task-row {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 12px;
  align-items: center;
  padding: 6px 14px 6px 38px;
  cursor: pointer;
  border-left: 4px solid transparent;
  border-bottom: 1px solid var(--line);
  transition: background 0.1s;
}

.task-row:last-child {
  border-bottom: none;
}

.task-row:hover {
  background: var(--surface-soft);
}

.task-row.active {
  border-left-color: var(--accent);
  box-shadow: inset 0 0 0 1px var(--accent);
  background: var(--accent-weak);
}

.task-main {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.task-name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}


.task-meta {
  font-size: 11px;
  color: var(--muted);
}

.empty {
  padding: 24px;
  text-align: center;
  color: var(--muted);
  font-size: 13px;
}
</style>
