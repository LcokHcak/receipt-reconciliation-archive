<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Wrench } from 'lucide-vue-next'

import Button from '@/components/ui/button.vue'
import Drawer from '@/components/ui/drawer.vue'
import StatusBadge from '@/components/ui/status-badge.vue'
import TabularNumber from '@/components/ui/tabular-number.vue'
import ImageViewer from '@/components/ImageViewer.vue'
import { buildReviewDeepLink } from '@/lib/agentWorkspaceLinks'
import { sortTasksForReview } from '@/lib/reviewDisplay'
import ReviewCenterTabs from '@/components/ReviewCenterTabs.vue'
import { fetchMonthlyWorkspaces } from '@/api/monthly'
import { fetchModeMapping } from '@/api/v2/setup'
import { fetchGroupCodes, fetchBatchGroupCodes, fetchBatchGroupCodeModes, rematchBatchTourMatch } from '@/api/v2/bills'
import { fetchLedger, updateLedgerFields } from '@/api/v2/ledger'
import { fetchBatch, replaceBatchGroupCode } from '@/api/workbench'
import { TOUR_MATCH_STATUS, TOUR_REMEDY_HINT } from '@/lib/statusLabels'

const route = useRoute()
const router = useRouter()
const routeWorkspaceKey = computed(() => String(route.params.workspaceKey || ''))

// 单一真相源:审核台页签的承接角标要用同一份口径(见 lib/remedyStatuses.js 顶部)
import { REMEDY_TOUR_STATUSES } from '@/lib/remedyStatuses'

const rows = ref([])
// 服务端口径的真实条数,与 rows.length(已加载条数)分开存 —— 两者不相等时
// 说明被截断了,而"截断了但不说"正是这条要修的病。
const serverTotalRows = ref(0)
const isTruncated = ref(false)
const batchSummaries = ref([])
// 团号表列表按「台账工作区月」分组(2026-07-27 设计整改)。
// ⚠️同一份团号表文件(同 hash)出现在两个月下**不是重复导入**:这里一行 = 一个
// (台账工作区月 × 审核批次),月份指的是这些**待补救行落在哪个月的台账**,不是文件的月份。
// 一份跨月团号表(如 6/30~7/2)被两个批次分别用掉、票分落两个月台账时,自然两个月各出现一次。
// 故标题必须写「归属台账月」,不能只写月份,否则会被误读成系统重复导入。
const batchSummaryGroups = computed(() => {
  const map = new Map()
  for (const e of batchSummaries.value) {
    const ws = String(e.workspaceKey || '(未归属)')
    if (!map.has(ws)) map.set(ws, { workspaceKey: ws, items: [], remedyTotal: 0 })
    map.get(ws).items.push(e)
    map.get(ws).remedyTotal += Number(e.remedyCount) || 0
  }
  // 组内已按待补救量降序(loadBatchSummaries 排过);组间也按待补救总量降序
  return [...map.values()].sort((a, b) => b.remedyTotal - a.remedyTotal)
})
// 团号表列表按月收起(0724 image46 备注「可一键全部收起/按日收起」):
// 月头可点折叠;右上「全部收起/展开」一键切换。默认全展开(待补救就是要看的)。
const collapsedMonths = ref(new Set())
function toggleMonth(ws) {
  const next = new Set(collapsedMonths.value)
  if (next.has(ws)) next.delete(ws)
  else next.add(ws)
  collapsedMonths.value = next
}
const allMonthsCollapsed = computed(() => batchSummaryGroups.value.length > 0
  && batchSummaryGroups.value.every((g) => collapsedMonths.value.has(g.workspaceKey)))
function toggleAllMonths() {
  collapsedMonths.value = allMonthsCollapsed.value
    ? new Set()
    : new Set(batchSummaryGroups.value.map((g) => g.workspaceKey))
}
// 待补救量的视觉分级:114 和 1 不该长得一模一样(全是同色胶囊 = 视觉上等价)。
// 按量级给字重/颜色,数字本身当主体,不再套胶囊。
function remedyWeightClass(n) {
  const v = Number(n) || 0
  if (v >= 50) return 'text-base font-medium text-status-error'
  if (v >= 10) return 'text-sm font-medium text-status-warn'
  return 'text-sm text-muted-foreground'
}
// 批次哈希降级展示:人读不了也记不住 30 字符哈希,只留尾 8 位供排查比对(完整值进 title)
function shortBatchId(batchId) {
  const s = String(batchId || '')
  return s ? `#${s.slice(-8)}` : ''
}
const selectedBatchKey = ref('') // '' = 全部批次;否则 `${workspaceKey}::${batchId}`
const rematchLoading = ref('') // 正在重匹配的 batchId
const pendingReplaceEntry = ref(null) // 等待选文件换表的批次
const groupCodeFileInput = ref(null)
const workspaces = ref([])
const loading = ref(false)
const actionLoading = ref('')
const errorMsg = ref('')
const successMsg = ref('')
const modeEdit = reactive({})
const modeOptionsByBatch = reactive({})
const showRemedyHelp = ref(false) // 说明默认收起(2026-07-27)
// 「或手填」改成下拉最后一项「手动输入…」:每行常驻一个空输入框 = 每行一个空洞。
// 记住哪些组点了手填,点了才展开输入框。
const manualModeGroups = reactive({})

const TOUR_STATUS_LABEL = TOUR_MATCH_STATUS // 统一字典,见 lib/statusLabels.js

// 为什么没匹配的人话解释:单一真相源在 lib/statusLabels(2026-07-18 收编,
// 审核台结算面板内联补救共用同一份,禁第二副本)
const REASON_HINT = TOUR_REMEDY_HINT

// 复查 Drawer
const reviewRow = ref(null)
const reviewGroupCodes = ref([])
const reviewLoading = ref(false)
const reviewSaving = ref(false)
// 三期:可编辑缓冲(改正客户信息 + 模式)
const editBuf = reactive({ name: '', passportNo: '', tourNo: '', agent: '', modeRaw: '' })
// 二期:护照/小票原图
const imageTask = ref(null)
const imageLoading = ref(false)
const imageMsg = ref('')
const reviewImageUrl = computed(() => imageTask.value?.imageUrl || imageTask.value?.sourceImageUrl || '')

async function openReview(row) {
  reviewRow.value = row
  reviewGroupCodes.value = []
  imageTask.value = null
  imageMsg.value = ''
  editBuf.name = row.name || ''
  editBuf.passportNo = row.passportNo || ''
  editBuf.tourNo = row.tourNo || ''
  editBuf.agent = row.agent || ''
  editBuf.modeRaw = ''
  reviewLoading.value = true
  try {
    const tourNo = String(row.tourNo || '').trim()
    if (tourNo) {
      // tour_match 的真正匹配来源是「审核批次团号表」(batch_group_code),不是工作区 group_code。
      // 月度场景下工作区 group_code 常为空,所以必须先按 sourceBatchId 查批次团号表,
      // 否则会误报「团号表没有这个团号」(其实是有的、只是日期越窗/代理不符)。
      let rows = []
      if (row.sourceBatchId) {
        const batchPayload = await fetchBatchGroupCodes(row._workspaceKey, { batchId: row.sourceBatchId, tourNo })
        rows = (batchPayload?.rows || []).filter((g) => String(g.tourNo || '').trim() === tourNo)
      }
      // 兜底:批次表没有再查工作区 group_code(历史/补录入口导入的)
      if (!rows.length) {
        const payload = await fetchGroupCodes(row._workspaceKey, { query: tourNo, limit: 50 })
        rows = (payload?.rows || []).filter((g) => String(g.tourNo || '').trim() === tourNo)
      }
      reviewGroupCodes.value = rows
    }
  } catch (error) {
    errorMsg.value = decodeError(error, '加载团号表信息失败')
  } finally {
    reviewLoading.value = false
  }
}
function closeReview() {
  reviewRow.value = null
  reviewGroupCodes.value = []
  imageTask.value = null
  imageMsg.value = ''
}

// 定位到审核台源客户组(2026-07-13):台账行早就落了 sourceBatchId/sourceCustomerId,只差个入口。
// 只有 sourceType==='workbench'(审核台建档产生)的行,这两个键才对应审核台批次+组;
// 'imported'(旧Excel批量导入)/'manual'/'bill_backfill' 的 sourceBatchId 是导入作业号,不是审核台批次,
// 这样跳会指向不存在/别的批次 → 按钮置灰,并提示改用姓名/护照/团号去审核台搜索框搜。
function canLocateInReview(row) {
  return row?.sourceType === 'workbench' && !!row?.sourceBatchId && !!row?.sourceCustomerId
}
function locateInReview(row) {
  if (!canLocateInReview(row)) return
  const link = buildReviewDeepLink({
    batchId: row.sourceBatchId,
    group: row.sourceCustomerId,
    task: row.sourceTaskId || '',
  })
  if (link) router.push(link)
}

// P2 组卡片级「定位审核台」(2026-07-18 设计):组内可定位行同属一个审核批次才能整组跳
// (团号组横跨多客户,跳批次队列即可);跨批次/全导入行退回逐行定位。
function groupReviewTarget(group) {
  const locatable = (group?.rows || []).filter((r) => canLocateInReview(r))
  if (!locatable.length) return null
  const batchIds = new Set(locatable.map((r) => r.sourceBatchId))
  return batchIds.size === 1 ? locatable[0] : null
}
function locateGroupInReview(group) {
  const target = groupReviewTarget(group)
  if (!target) return
  const link = buildReviewDeepLink({ batchId: target.sourceBatchId })
  if (link) router.push(link)
}

// P2 客户信息弹窗(2026-07-18 设计):按行 sourceBatchId 回溯审核批次,取同 sourceGroupKey
// (=台账 sourceCustomerId)的全部任务=该客户护照+全部票+原图,补救时一眼看全人,不用切页。
const customerInfo = reactive({ row: null, loading: false, error: '', tasks: [], activeTask: null })
async function openCustomerInfo(row) {
  customerInfo.row = row
  customerInfo.tasks = []
  customerInfo.activeTask = null
  customerInfo.error = ''
  customerInfo.loading = false
  if (row?.sourceType !== 'workbench' || !row?.sourceBatchId || !row?.sourceCustomerId) {
    customerInfo.error = '该行不是审核台建档产生(批量导入/手工录入),没有可回溯的客户档案。'
    return
  }
  customerInfo.loading = true
  try {
    const batch = await fetchBatch(row.sourceBatchId)
    const tasks = batch?.tasks || batch?.batch?.tasks || []
    const groupTasks = tasks.filter((t) => String(t.sourceGroupKey || '') === String(row.sourceCustomerId))
    // 护照→小票→其它 的审核台顺序(共享排序,只排显示)
    customerInfo.tasks = sortTasksForReview(groupTasks)
    customerInfo.activeTask = customerInfo.tasks.find((t) => t.imageUrl || t.sourceImageUrl) || null
    if (!groupTasks.length) customerInfo.error = '批次里没找到该客户的任务(批次可能已清理)。'
  } catch (error) {
    customerInfo.error = decodeError(error, '加载客户信息失败')
  } finally {
    customerInfo.loading = false
  }
}
function closeCustomerInfo() {
  customerInfo.row = null
  customerInfo.tasks = []
  customerInfo.activeTask = null
  customerInfo.error = ''
}
const TASK_DOC_LABEL = { passport: '护照', receipt: '小票' }
function taskDocLabel(task) {
  const d = String(task?.docTypeFinal || task?.docTypeAuto || '').toLowerCase()
  return TASK_DOC_LABEL[d] || task?.docTypeFinal || task?.docTypeAuto || '其它'
}
function taskField(task, finalKey, autoKey) {
  return String(task?.[finalKey] || task?.[autoKey] || '').trim() || '—'
}

// 二期:看护照/小票原图 —— 收票行带 sourceBatchId+sourceTaskId,取批次找到那条任务,复用 ImageViewer
async function loadImage() {
  const row = reviewRow.value
  if (!row?.sourceBatchId || !row?.sourceTaskId) {
    imageMsg.value = '这条收票没有关联的原始扫描(可能是手工录入)。'
    return
  }
  imageLoading.value = true
  imageMsg.value = ''
  try {
    const batch = await fetchBatch(row.sourceBatchId)
    const tasks = batch?.tasks || batch?.batch?.tasks || []
    const task = tasks.find((t) => String(t.id) === String(row.sourceTaskId)) || null
    if (!task) {
      imageMsg.value = '在批次里没找到对应的扫描任务。'
    } else if (!(task.imageUrl || task.sourceImageUrl)) {
      imageMsg.value = '该任务没有可显示的图片。'
    } else {
      imageTask.value = task
    }
  } catch (error) {
    imageMsg.value = decodeError(error, '加载图片失败')
  } finally {
    imageLoading.value = false
  }
}

// 三期:保存改正 + 重新匹配
async function saveReview() {
  const row = reviewRow.value
  if (!row) return
  const payload = {}
  if (editBuf.name !== (row.name || '')) payload.name = editBuf.name || null
  if (editBuf.passportNo !== (row.passportNo || '')) payload.passportNo = editBuf.passportNo || null
  if (editBuf.tourNo !== (row.tourNo || '')) payload.tourNo = editBuf.tourNo || null
  if (editBuf.agent !== (row.agent || '')) payload.agent = editBuf.agent || null
  if (editBuf.modeRaw) payload.modeRaw = editBuf.modeRaw
  if (Object.keys(payload).length === 0) {
    errorMsg.value = '没有任何改动'
    return
  }
  // 选了模式才确认重新匹配为 matched;只改信息不强制
  if (editBuf.modeRaw) payload.manualRemedyConfirm = true
  reviewSaving.value = true
  errorMsg.value = ''
  try {
    await updateLedgerFields(row._workspaceKey, row.id, payload)
    successMsg.value = `已保存 ${row._workspaceKey} #${row.id} 的改正${editBuf.modeRaw ? ',并重新匹配' : ''}`
    closeReview()
    await load()
  } catch (error) {
    errorMsg.value = decodeError(error, '保存失败')
  } finally {
    reviewSaving.value = false
  }
}
const fmtDate = (v) => {
  if (!v) return '—'
  const s = String(v)
  return s.length > 10 ? s.slice(0, 10) : s
}

// 服务端 limit 上限 500(routes/monthly/listing_routes.js: clampInt(...,1,500,50))。
// 顶到上限只是把悬崖往后挪,**真正的修法是把截断说出来** —— 参见 0730 那次
// 「代理视图下一步任务 LIMIT 50」:少数据本身不致命,致命的是少了还装作没少,
// 于是操作员把"看不见"读成"没有"。
const REMEDY_PAGE_LIMIT = 500

async function load() {
  loading.value = true
  errorMsg.value = ''
  successMsg.value = ''
  try {
    const keys = await resolveWorkspaceKeys()
    workspaces.value = keys
    let total = 0
    let truncated = false
    const results = await Promise.all(keys.flatMap((workspaceKey) =>
      REMEDY_TOUR_STATUSES.map(async (status) => {
        const payload = await fetchLedger(workspaceKey, {
          tourMatchStatus: status,
          limit: REMEDY_PAGE_LIMIT,
          offset: 0,
        }).catch(() => ({ rows: [], total: 0 }))
        const got = payload?.rows || []
        // total 是服务端一直在返的(listing_routes.js:35 res.json({rows, total, ...})),
        // 页面从来没接过 —— 于是抬头那句「共 N 条」写的是**已加载条数**,
        // 一旦截断,那个「共」字就在说假话。
        const serverTotal = Number(payload?.total)
        total += Number.isFinite(serverTotal) ? serverTotal : got.length
        if (Number.isFinite(serverTotal) && got.length < serverTotal) truncated = true
        return got.map((row) => ({ ...row, _workspaceKey: workspaceKey }))
      }),
    ))
    rows.value = dedupeRows(results.flat())
    serverTotalRows.value = total
    isTruncated.value = truncated
    await Promise.all([loadModeOptions(rows.value), loadBatchSummaries(rows.value)])
  } catch (error) {
    errorMsg.value = decodeError(error, '加载日度待补救失败')
    rows.value = []
    serverTotalRows.value = 0
    isTruncated.value = false
  } finally {
    loading.value = false
  }
}

async function resolveWorkspaceKeys() {
  if (routeWorkspaceKey.value) return [routeWorkspaceKey.value]
  const payload = await fetchMonthlyWorkspaces({ mode: 'all' })
  const items = Array.isArray(payload?.workspaces) ? payload.workspaces
    : Array.isArray(payload?.items) ? payload.items
      : Array.isArray(payload) ? payload
        : []
  return items
    .map((item) => String(item.workspaceKey || item.key || item))
    .filter(Boolean)
    .sort()
    .reverse()
}

function dedupeRows(list) {
  const seen = new Set()
  const out = []
  for (const row of list) {
    const key = `${row._workspaceKey}:${row.id}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(row)
  }
  return out
}

function batchKeyOf(row) {
  return `${row._workspaceKey || ''}::${row.sourceBatchId || ''}`
}
// P2 精准落位(2026-07-18 设计):审核台「待补救」徽章/结算面板深链带 ?customer=<sourceCustomerId>
// 跳过来 → 只看该客户的待补救行。纯视图过滤,可一键清除回全量。
const customerFilter = ref('')
// 选中某批次后,表格 / 一键补救只作用于该批次。纯前端视图筛选 —— 不动任何数据,不影响月度对账。
const filteredRows = computed(() => {
  let list = selectedBatchKey.value
    ? rows.value.filter((r) => batchKeyOf(r) === selectedBatchKey.value)
    : rows.value
  if (customerFilter.value) {
    list = list.filter((r) => String(r.sourceCustomerId || '') === customerFilter.value)
  }
  return list
})
function toggleBatch(entry) {
  const k = `${entry.workspaceKey || ''}::${entry.batchId || ''}`
  selectedBatchKey.value = selectedBatchKey.value === k ? '' : k
}

function rematchSummary(label, batchId, r) {
  const reset = r?.resetCount ?? 0
  const matched = r?.matched ?? 0
  return `批次 ${batchId} ${label}:重置 ${reset} 行,其中重新命中 ${matched} 行(其余仍需人工补救)`
}

// 换团号表并重新匹配:选新 xlsx → 替换本批次团号表 → 立即按新表重跑该批次未命中行。
function triggerReplaceAndRematch(entry) {
  if (!entry?.batchId) return
  pendingReplaceEntry.value = entry
  groupCodeFileInput.value?.click()
}
async function onGroupCodeFile(e) {
  const file = e.target.files?.[0]
  if (e.target) e.target.value = '' // 允许重选同名文件
  const entry = pendingReplaceEntry.value
  pendingReplaceEntry.value = null
  if (!file || !entry?.batchId) return
  if (!window.confirm(`替换批次 ${entry.batchId} 的团号表,并按新表重新匹配未命中行?\n\n· 已匹配 / 已人工确认的行不动\n· 核对、出包会在下次进入时自动重算`)) return
  rematchLoading.value = entry.batchId
  errorMsg.value = ''
  successMsg.value = ''
  try {
    await replaceBatchGroupCode(entry.batchId, file)
    const r = await rematchBatchTourMatch(entry.workspaceKey, entry.batchId)
    successMsg.value = rematchSummary('换表后重新匹配', entry.batchId, r)
    await load()
  } catch (error) {
    errorMsg.value = decodeError(error, '换表重匹配失败')
  } finally {
    rematchLoading.value = ''
  }
}
// 仅重新匹配:不换表,用当前批次团号表重跑未命中行。
async function rematchOnly(entry) {
  if (!entry?.batchId) return
  if (!window.confirm(`用当前团号表重新匹配批次 ${entry.batchId} 的未命中行?`)) return
  rematchLoading.value = entry.batchId
  errorMsg.value = ''
  successMsg.value = ''
  try {
    const r = await rematchBatchTourMatch(entry.workspaceKey, entry.batchId)
    successMsg.value = rematchSummary('重新匹配', entry.batchId, r)
    await load()
  } catch (error) {
    errorMsg.value = decodeError(error, '重新匹配失败')
  } finally {
    rematchLoading.value = ''
  }
}

// Q2: 这些待补救行分别来自哪个批次,各批次用的是哪份团号表(文件名/条数/模式数/导入时间),
// 还剩多少待补救 —— 让操作员"看得见换了什么表"。纯展示,复用现有 batch-group-codes 接口。
async function loadBatchSummaries(list) {
  const map = new Map()
  for (const r of list || []) {
    const batchId = r.sourceBatchId || ''
    const key = `${r._workspaceKey}::${batchId}`
    if (!map.has(key)) {
      map.set(key, {
        workspaceKey: r._workspaceKey, batchId,
        remedyCount: 0, sourceFile: null, importedAt: null, count: 0, modeCount: 0,
      })
    }
    map.get(key).remedyCount += 1
  }
  const entries = Array.from(map.values())
  await Promise.all(entries.map(async (e) => {
    if (!e.batchId) return // 手工录入/无批次行,没有批次团号表可查
    try {
      const gc = await fetchBatchGroupCodes(e.workspaceKey, { batchId: e.batchId, limit: 1 })
      const sample = (gc?.rows || [])[0] || null
      e.sourceFile = sample?.sourceFile || null
      e.importedAt = sample?.importedAt || null
      e.count = gc?.total ?? (gc?.rows?.length || 0)
    } catch { /* 批次无团号表 → 留空 */ }
    try {
      const mm = await fetchBatchGroupCodeModes(e.workspaceKey, { batchId: e.batchId })
      e.modeCount = (mm?.modes || []).length
    } catch { /* 模式统计失败不影响主信息 */ }
  }))
  // 排序口径(2026-07-27 设计整改):按**待补救量**降序 —— 最该处理的排最前,不再按
  // 工作区名/导入时间(那样第一行是不是最急纯属巧合)。
  batchSummaries.value = entries.sort((a, b) => (b.remedyCount - a.remedyCount)
    || String(b.workspaceKey).localeCompare(String(a.workspaceKey)))
}

async function loadModeOptions(list) {
  // 全枚举:工作区台账里出现的全部「团号模式」(组合 = 店铺·分店·返点模式),与「模式分桶」同源。
  // 收票自带的模式会写进台账 mode_raw(含未匹配/待补救行),这里把全集列给操作员选。
  const workspaces = Array.from(new Set((list || []).map((r) => r._workspaceKey).filter(Boolean)))
  await Promise.all(workspaces.map(async (workspaceKey) => {
    if (modeOptionsByBatch[workspaceKey]) return
    const set = new Set()
    try {
      const mm = await fetchModeMapping(workspaceKey)
      const items = mm?.items || mm?.data?.items || []
      const unmapped = mm?.unmapped || mm?.data?.unmapped || []
      items.forEach((it) => { const m = it.modeRaw ?? it.mode_raw; if (m) set.add(m) })
      unmapped.forEach((m) => { const v = typeof m === 'string' ? m : (m?.modeRaw ?? m?.mode_raw); if (v) set.add(v) })
    } catch { /* 工作区暂无模式 → 空列表 */ }
    modeOptionsByBatch[workspaceKey] = Array.from(set).sort()
  }))
}

function modeOptionsFor(row) {
  return modeOptionsByBatch[row?._workspaceKey || ''] || []
}

async function submitMode(row) {
  const mode = modeEdit[row.id]
  if (!mode) {
    errorMsg.value = '请先选一个模式'
    return
  }
  actionLoading.value = `submit:${row._workspaceKey}:${row.id}`
  errorMsg.value = ''
  try {
    await updateLedgerFields(row._workspaceKey, row.id, {
      modeRaw: mode,
      manualRemedyConfirm: true,
    })
    successMsg.value = `已选定 ${mode} · ${row._workspaceKey} #${row.id},该行会重新进入正常匹配流程`
    delete modeEdit[row.id]
    await load()
  } catch (error) {
    errorMsg.value = decodeError(error, '补救失败')
  } finally {
    actionLoading.value = ''
  }
}

// 一键补救:把当前列表里「已内联选好模式」的所有行,一次性提交补救(逐行调同一接口,
// 单行失败不影响其余,最后汇总成功/失败数,失败行保留选项可单独重试)。
const modePickedCount = computed(() => filteredRows.value.filter((r) => modeEdit[r.id]).length)

async function submitAllModes() {
  const picks = filteredRows.value.filter((r) => modeEdit[r.id])
  if (!picks.length) {
    errorMsg.value = '还没有任何行选好模式,先在「选择模式」列里选'
    return
  }
  actionLoading.value = 'submit-all'
  errorMsg.value = ''
  successMsg.value = ''
  let ok = 0
  const failed = []
  for (const row of picks) {
    try {
      await updateLedgerFields(row._workspaceKey, row.id, {
        modeRaw: modeEdit[row.id],
        manualRemedyConfirm: true,
      })
      delete modeEdit[row.id]
      ok += 1
    } catch (error) {
      failed.push(`#${row.id}(${decodeError(error, '失败')})`)
    }
  }
  successMsg.value = `一键补救完成:成功 ${ok} 行${failed.length ? `,失败 ${failed.length} 行` : ''}`
  if (failed.length) errorMsg.value = `以下行补救失败,请单独重试:${failed.slice(0, 5).join('、')}`
  actionLoading.value = ''
  await load()
}

// ── 按(团号 + 代理)分组,组级批量补救 ─────────────────────────────
// 同一团号+代理的待补救客户合成一组,选一次模式补救整组(复用 updateLedgerFields,后端不变)。
// 日期类原因(逐人购买日期不同)不并入组级,只展开逐行处理。
const viewMode = ref('group') // 'group' | 'flat'
const groupModeEdit = reactive({}) // groupKey → 该组选的模式
const expandedGroups = reactive({}) // groupKey → true 展开明细
const groupSubmitting = ref('') // 正在补救的 groupKey
const DATE_REASONS = new Set(['date_out_of_window', 'date_missing'])

function groupKeyOf(row) {
  return `${row._workspaceKey || ''}::${row.tourNo || ''}::${row.agent || ''}`
}
function modeOptionsForWs(ws) {
  return modeOptionsByBatch[ws] || []
}
function toggleExpand(key) {
  expandedGroups[key] = !expandedGroups[key]
}

// 同(月+团号)挂了几个代理 → 多代理团号提示(按团号+代理已分开成多组)
const tourMultiAgent = computed(() => {
  const m = new Map()
  for (const r of filteredRows.value) {
    const tk = `${r._workspaceKey || ''}::${r.tourNo || ''}`
    if (!m.has(tk)) m.set(tk, new Set())
    m.get(tk).add(r.agent || '')
  }
  return m
})

const groups = computed(() => {
  const map = new Map()
  for (const r of filteredRows.value) {
    const key = groupKeyOf(r)
    if (!map.has(key)) {
      map.set(key, { key, workspaceKey: r._workspaceKey || '', tourNo: r.tourNo || '', agent: r.agent || '', rows: [], reasons: new Set() })
    }
    const g = map.get(key)
    g.rows.push(r)
    g.reasons.add(r.tourMatchStatus)
  }
  return Array.from(map.values())
    .map((g) => ({
      ...g,
      count: g.rows.length,
      multiAgent: (tourMultiAgent.value.get(`${g.workspaceKey}::${g.tourNo}`)?.size || 1) > 1,
      rowByRowOnly: g.rows.every((r) => DATE_REASONS.has(r.tourMatchStatus)), // 纯日期类 → 逐行
      // F11:混合组组级补救只吃模式类行,按钮计数/提示都按它,不再虚报全组数
      dateRowCount: g.rows.filter((r) => DATE_REASONS.has(r.tourMatchStatus)).length,
    }))
    .sort((a, b) => b.count - a.count) // 客户多的组排前面
})

const groupPickedCount = computed(() => groups.value.filter((g) => !g.rowByRowOnly && groupModeEdit[g.key]).length)

// 下拉选择:选「手动输入…」只开输入框(清掉已选值,让用户自己填);选具体模式则关掉输入框。
function onGroupModeSelect(g, value) {
  if (value === '__manual__') {
    manualModeGroups[g.key] = true
    groupModeEdit[g.key] = ''
    return
  }
  manualModeGroups[g.key] = false
  groupModeEdit[g.key] = value
}

// P2-4 「按客户」视图(2026-07-18 设计,替代旧逐票平铺):同客户的票聚成一卡
// (姓名/护照/N张票/原因),卡内逐票补救。无 sourceCustomerId 的行(导入/手工)单票自成一卡。
const customerCards = computed(() => {
  const map = new Map()
  for (const r of filteredRows.value) {
    const key = r.sourceCustomerId
      ? `${r._workspaceKey}::${r.sourceBatchId || ''}::${r.sourceCustomerId}`
      : `row::${r._workspaceKey}::${r.id}`
    if (!map.has(key)) {
      map.set(key, { key, name: r.name || '', passportNo: r.passportNo || '', rows: [], reasons: new Set() })
    }
    const c = map.get(key)
    c.rows.push(r)
    c.reasons.add(r.tourMatchStatus)
    if (!c.name && r.name) c.name = r.name
    if (!c.passportNo && r.passportNo) c.passportNo = r.passportNo
  }
  return Array.from(map.values()).sort((a, b) => b.rows.length - a.rows.length)
})

// F11(2026-07-18 设计):混合组(模式类+日期类同组)一键同模式,日期类行必须排除——
// 日期问题逐人不同,拿组级模式硬 confirm 会把越窗日期背书成 matched(错绿)。跳过数明示。
function groupModeEligibleRows(group) {
  return group.rows.filter((r) => !DATE_REASONS.has(r.tourMatchStatus))
}

async function submitGroup(group) {
  const mode = groupModeEdit[group.key]
  if (!mode) { errorMsg.value = '请先给这组选一个模式'; return }
  const eligible = groupModeEligibleRows(group)
  const skippedDates = group.rows.length - eligible.length
  if (!eligible.length) { errorMsg.value = '这组只剩日期类问题,请展开逐行确认日期'; return }
  groupSubmitting.value = group.key
  errorMsg.value = ''
  successMsg.value = ''
  let ok = 0
  const failed = []
  for (const row of eligible) {
    try {
      await updateLedgerFields(row._workspaceKey, row.id, { modeRaw: mode, manualRemedyConfirm: true })
      ok += 1
    } catch { failed.push(`#${row.id}`) }
  }
  delete groupModeEdit[group.key]
  successMsg.value = `团号 ${group.tourNo}(代理 ${group.agent || '—'}):补救 ${ok} 个客户`
    + `${skippedDates ? `,跳过 ${skippedDates} 张日期类(展开逐行处理)` : ''}${failed.length ? `,失败 ${failed.length}` : ''}`
  if (failed.length) errorMsg.value = `失败 ${failed.length} 行,请重试:${failed.slice(0, 5).join('、')}`
  groupSubmitting.value = ''
  await load()
}

async function submitAllGroups() {
  const picks = groups.value.filter((g) => !g.rowByRowOnly && groupModeEdit[g.key])
  if (!picks.length) { errorMsg.value = '还没有任何组选好模式,先在组头「选择模式」里选'; return }
  actionLoading.value = 'submit-all-groups'
  errorMsg.value = ''
  successMsg.value = ''
  let okRows = 0
  let okGroups = 0
  let skippedDates = 0
  const failed = []
  for (const group of picks) {
    const mode = groupModeEdit[group.key]
    const eligible = groupModeEligibleRows(group)
    skippedDates += group.rows.length - eligible.length
    for (const row of eligible) {
      try {
        await updateLedgerFields(row._workspaceKey, row.id, { modeRaw: mode, manualRemedyConfirm: true })
        okRows += 1
      } catch { failed.push(`#${row.id}`) }
    }
    delete groupModeEdit[group.key]
    okGroups += 1
  }
  successMsg.value = `一键补救完成:${okGroups} 组 / ${okRows} 个客户`
    + `${skippedDates ? `,跳过 ${skippedDates} 张日期类(展开逐行处理)` : ''}${failed.length ? `,失败 ${failed.length}` : ''}`
  if (failed.length) errorMsg.value = `失败 ${failed.length} 行,请重试:${failed.slice(0, 5).join('、')}`
  actionLoading.value = ''
  await load()
}

function decodeError(error, fallback) {
  const data = error?.response?.data || {}
  if (data.code === 'service_unavailable') return `${data.service || '服务'} 不可用 (503)`
  return data.error || error?.message || fallback
}

// P2 精准落位:读深链 query(batch=ws::batchId 预选批次 / customer=sourceCustomerId 只看该客户 /
// tour=团号 自动展开对应组)。零后端,纯视图定位;参数不存在时照常全量。
onMounted(async () => {
  const q = route.query || {}
  if (q.batch) selectedBatchKey.value = String(q.batch)
  if (q.customer) customerFilter.value = String(q.customer)
  await load()
  const tour = String(q.tour || '').trim()
  if (tour) {
    for (const g of groups.value) {
      if (g.key.startsWith(`${g.workspaceKey}::${tour}::`)) expandedGroups[g.key] = true
    }
  }
})
</script>

<template>
  <!-- v2-layout(0728 用户拍板「翻亮对齐文档」):本页用 shadcn 令牌类(bg-card/
       text-status-warn 等)但路由在旧壳里,没有 .v2-layout 作用域时全部 hsl(var(--x))
       解析失败——琥珀/主色/边框全在裸奔。补上作用域,亮色令牌即刻生效。 -->
  <section class="v2-layout min-w-0 space-y-5 overflow-x-hidden">
    <ReviewCenterTabs />
    <header class="flex flex-wrap items-center gap-3 px-1">
      <!-- 硬规则「蓝只给可点击」:标题旁的装饰图标,点不动 -->
      <Wrench class="h-6 w-6 text-slate-500" />
      <div class="min-w-0 flex-1">
        <h1 class="text-xl font-medium text-foreground">日度待补救</h1>
        <p class="text-sm text-muted-foreground">
          审核批次导入台账后,团号未命中 / 日期越界 / 代理不符 / 模式无法归类的行在这里处理。
          共 <TabularNumber :value="serverTotalRows || rows.length" /> 条<span v-if="selectedBatchKey">,当前批次 <TabularNumber :value="filteredRows.length" /> 条</span>。
        </p>
        <!-- 截断必须说出来。「共 N 条」原来写的是已加载条数,截断时那个「共」字在说假话:
             操作员处理完屏幕上这些就以为清空了,实际还压着一批看不见的。 -->
        <p v-if="isTruncated" class="mt-1 text-sm text-amber-700">
          ⚠ 数据太多,当前只加载了前 <TabularNumber :value="rows.length" /> 条(每种状态各取前 {{ REMEDY_PAGE_LIMIT }} 条)。
          处理完这批后请点「刷新」再取下一批 —— 屏幕清空 ≠ 已经没有了。
        </p>
      </div>
      <div class="inline-flex overflow-hidden rounded-md border border-input text-xs">
        <button
          type="button"
          class="px-3 py-1.5 transition-colors"
          :class="viewMode === 'group' ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-muted'"
          @click="viewMode = 'group'"
        >
          按团号分组
        </button>
        <button
          type="button"
          class="px-3 py-1.5 transition-colors"
          :class="viewMode === 'flat' ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-muted'"
          @click="viewMode = 'flat'"
        >
          按客户
        </button>
      </div>
      <!-- 一键补救:选中数 > 0 才出现(2026-07-27 设计整改)。
           禁用的主按钮是最浪费注意力的控件——长得像主角却不能按,还是全页唯一的实心蓝。 -->
      <Button
        v-if="viewMode === 'group' && groupPickedCount > 0"
        size="sm"
        :disabled="loading || actionLoading === 'submit-all-groups'"
        @click="submitAllGroups"
      >
        {{ actionLoading === 'submit-all-groups' ? '补救中…' : `一键补救已选 ${groupPickedCount} 组` }}
      </Button>
      <Button
        v-else-if="viewMode !== 'group' && modePickedCount > 0"
        size="sm"
        :disabled="loading || actionLoading === 'submit-all'"
        @click="submitAllModes"
      >
        {{ actionLoading === 'submit-all' ? '补救中…' : `一键补救 ${modePickedCount} 行` }}
      </Button>
      <Button variant="ghost" size="sm" :disabled="loading" @click="load">刷新</Button>
    </header>

    <!-- 说明压成一行 + 可展开(2026-07-27 设计整改):这类文案第一天有用,第二天起全是负担。
         去掉蓝框蓝底 —— 它不是警告,不该长得像警告。 -->
    <p class="flex flex-wrap items-center gap-x-2 px-1 text-xs text-muted-foreground">
      <span>操作员只需选择正确模式 → 确认后重新走匹配流程</span>
      <button type="button" class="underline underline-offset-2 hover:text-foreground" @click="showRemedyHelp = !showRemedyHelp">
        {{ showRemedyHelp ? '收起' : '详细说明' }}
      </button>
    </p>
    <p v-if="showRemedyHelp" class="px-1 text-xs text-muted-foreground">
      候选模式来自本审核批次上传的团号表;没有时可在下拉里选「手动输入…」自己填。
      确认后系统会把该行重新放回正常团号匹配流程,已匹配 / 已确认的行不受影响。
    </p>

    <!-- P2 精准落位:审核台带 customer 参数跳来 → 只看该客户,一键清除回全量 -->
    <div v-if="customerFilter" class="flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-4 py-2 text-sm">
      <span>只看客户 <span class="font-mono font-medium">{{ customerFilter }}</span>(从审核台定位而来,共 <TabularNumber :value="filteredRows.length" /> 行)</span>
      <button
        type="button"
        class="rounded-md border border-input bg-background px-2 py-0.5 text-xs hover:bg-muted"
        @click="customerFilter = ''"
      >
        清除,看全部
      </button>
    </div>

    <!-- Q2: 各批次团号表概览 —— 这些待补救行来自哪个批次、各批次用的哪份团号表 -->
    <div v-if="batchSummaries.length" class="rounded-lg border border-border bg-card px-4 py-3">
      <div class="flex items-center justify-between gap-2">
        <h3 class="text-xs font-medium text-muted-foreground">各批次团号表<span class="ml-2 font-normal">按待补救量排序 · 点行只看该批次</span></h3>
        <div class="flex items-center gap-2">
          <!-- image46 备注:可一键全部收起/按月收起 -->
          <button
            type="button"
            class="rounded-md border border-input px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted"
            @click="toggleAllMonths"
          >
            {{ allMonthsCollapsed ? '全部展开' : '全部收起' }}
          </button>
          <button
            type="button"
            class="rounded-md border px-2 py-0.5 text-xs transition-colors"
            :class="selectedBatchKey ? 'border-input text-muted-foreground hover:bg-muted' : 'border-primary bg-primary/10 text-primary'"
            @click="selectedBatchKey = ''"
          >
            全部批次
          </button>
        </div>
      </div>
      <!-- 固定列(2026-07-27 设计整改):团号表 | 数据量 | 导入 | 待补救。
           原来一行是一条长句子(工作区+批次哈希+文件名+条数+导入+胶囊全挤在一行、宽度随内容浮动),
           眼睛没法垂直扫描比较 —— 现在锁进列,数字右对齐可比。 -->
      <div class="mt-2 grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-x-4 border-b border-border px-2 pb-1 text-[11px] text-muted-foreground">
        <span>团号表</span>
        <span class="text-right">数据量</span>
        <span class="text-right">导入</span>
        <span class="text-right">待补救</span>
      </div>
      <template v-for="grp in batchSummaryGroups" :key="grp.workspaceKey">
        <!-- 「归属台账月」:同一份表出现在两个月是正常的(见 batchSummaryGroups 注释),
             写清是"归属台账月"才不会被误读成重复导入 -->
        <button
          type="button"
          class="mt-2 flex w-full items-center gap-1 px-2 text-left text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          :title="'这些待补救行落在该月台账;同一份团号表可能被跨月的两个批次分别用到。点击收起/展开'"
          @click="toggleMonth(grp.workspaceKey)"
        >
          <span class="inline-block w-3">{{ collapsedMonths.has(grp.workspaceKey) ? '▸' : '▾' }}</span>
          <span>归属台账月 {{ grp.workspaceKey }}</span>
          <span v-if="collapsedMonths.has(grp.workspaceKey)" class="ml-1 font-normal">{{ grp.items.length }} 张表 · 待补救 {{ grp.remedyTotal }}</span>
        </button>
        <ul v-show="!collapsedMonths.has(grp.workspaceKey)" class="space-y-0.5">
          <li
            v-for="e in grp.items"
            :key="e.workspaceKey + '::' + e.batchId"
            class="grid cursor-pointer grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-x-4 rounded-md border px-2 py-1.5 text-sm transition-colors"
            :class="selectedBatchKey === (e.workspaceKey + '::' + e.batchId)
              ? 'border-primary bg-primary/10'
              : 'border-transparent hover:bg-muted/50'"
            @click="toggleBatch(e)"
          >
            <!-- 文件名当主体(有辨识度),批次哈希降级成尾 8 位灰小字(完整值进 title 供排查) -->
            <span class="min-w-0 truncate">
              <span class="font-medium text-foreground">{{ e.batchId ? (e.sourceFile || '— 未导入团号表') : '(手工录入 / 无批次)' }}</span>
              <span v-if="e.batchId" class="ml-2 font-mono text-[11px] text-muted-foreground" :title="`批次ID:${e.batchId}`">{{ shortBatchId(e.batchId) }}</span>
            </span>
            <span class="text-right text-xs text-muted-foreground">
              <template v-if="e.batchId">{{ e.count.toLocaleString() }} · {{ e.modeCount }} 种</template>
              <template v-else>—</template>
            </span>
            <span class="text-right text-xs text-muted-foreground">{{ e.batchId ? fmtDate(e.importedAt) : '—' }}</span>
            <!-- 待补救按量级分层:114 一眼比 1 重(不再是九行同色胶囊、视觉上完全等价) -->
            <span class="text-right tabular-nums" :class="remedyWeightClass(e.remedyCount)" :title="`待补救 ${e.remedyCount} 行`">{{ e.remedyCount }}</span>
            <div
              v-if="e.batchId && selectedBatchKey === (e.workspaceKey + '::' + e.batchId)"
              class="col-span-4 mt-1 flex w-full flex-wrap items-center gap-2 border-t border-primary/20 pt-2"
              @click.stop
            >
              <button
                type="button"
                class="rounded-md border border-primary bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary disabled:opacity-50"
                :disabled="rematchLoading === e.batchId"
                @click="triggerReplaceAndRematch(e)"
              >
                {{ rematchLoading === e.batchId ? '处理中…' : '换团号表并重新匹配' }}
              </button>
              <button
                type="button"
                class="rounded-md border border-input bg-background px-2.5 py-1 text-xs disabled:opacity-50"
                :disabled="rematchLoading === e.batchId"
                @click="rematchOnly(e)"
              >
                仅重新匹配未命中行
              </button>
              <span class="text-[11px] text-muted-foreground">按新团号表自动重跑;已匹配 / 已确认的不动</span>
            </div>
          </li>
        </ul>
      </template>
    </div>

    <input ref="groupCodeFileInput" type="file" accept=".xlsx,.xls" style="display: none" @change="onGroupCodeFile">

    <div v-if="errorMsg" class="rounded-lg border border-status-error/30 bg-status-error/10 px-4 py-2 text-sm text-status-error">{{ errorMsg }}</div>
    <div v-else-if="successMsg" class="rounded-lg border border-status-ok/30 bg-status-ok/10 px-4 py-2 text-sm text-status-ok">{{ successMsg }}</div>

    <div v-if="!loading && !rows.length" class="rounded-lg border border-status-ok/30 bg-status-ok/5 px-4 py-6 text-center text-sm text-status-ok">
      当前没有需要审核员处理的补救项
    </div>

    <!-- 按团号+代理分组视图(默认):同团号同代理的客户合成一组,选一次模式补救整组 -->
    <!-- 按团号分组(0728 image42 设计稿定稿):两行式无框行——
         行1「团号  代理 · N 客户」;行2 琥珀纯文字原因(去胶囊)+ 尾注 + 链接式定位审核台;
         右侧控件固定两列;组间细分隔线,不再一组一张圆角卡(image98:这老些框先给取消了)。 -->
    <div v-else-if="viewMode === 'group'" class="divide-y divide-border rounded-lg border border-border bg-card">
      <div v-for="g in groups" :key="g.key">
        <div
          class="flex items-start gap-2 px-3 py-2.5"
          :class="g.rowByRowOnly ? 'bg-muted/40' : ''"
        >
          <button type="button" class="mt-0.5 font-mono text-xs text-muted-foreground" @click="toggleExpand(g.key)">
            {{ expandedGroups[g.key] ? '▾' : '▸' }}
          </button>
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-baseline gap-x-2">
              <span class="font-mono text-sm font-medium text-foreground">{{ g.tourNo || '(无团号)' }}</span>
              <span class="text-xs text-muted-foreground">{{ g.agent || '—' }} · {{ g.count }} 客户</span>
              <span v-if="g.multiAgent" class="text-[11px] text-status-warn">⚠ 同团号有多个代理,已按代理分开</span>
            </div>
            <!-- 原因 + 尾注归为一组(2026-07-27 设计整改),0728 按 image42 去胶囊改纯文字 -->
            <div class="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs">
              <span class="text-status-warn">{{ [...g.reasons].map((s) => TOUR_STATUS_LABEL[s] || s).join(' / ') }}</span>
              <span v-if="g.dateRowCount" class="text-status-warn">· {{ g.dateRowCount }} 张不吃组级模式,展开逐行</span>
              <span class="text-muted-foreground">·</span>
              <button
                type="button"
                class="text-primary underline-offset-2 hover:underline disabled:cursor-default disabled:text-muted-foreground disabled:no-underline"
                :disabled="!groupReviewTarget(g)"
                :title="groupReviewTarget(g) ? '跳到审核台该批次队列' : '组内行跨批次或非审核台建档,展开后逐行定位'"
                @click="locateGroupInReview(g)"
              >
                定位审核台
              </button>
            </div>
          </div>

          <!-- 控件锁进固定宽度列(2026-07-27 设计整改):原来 ml-auto + 内容宽度浮动,
               导致每行下拉框起始 x 都不同(实测 860/865/1075/1085),每处理一行都要重新找按钮。
               现在下拉 200px + 按钮 120px 固定,所有行的控件严格垂直对齐。 -->
          <div v-if="!g.rowByRowOnly" class="ml-auto flex flex-none items-center gap-2 self-center">
            <div class="flex w-[200px] flex-col gap-1">
              <select
                class="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                :value="manualModeGroups[g.key] ? '__manual__' : (modeOptionsForWs(g.workspaceKey).includes(groupModeEdit[g.key]) ? groupModeEdit[g.key] : '')"
                @change="onGroupModeSelect(g, $event.target.value)"
              >
                <option value="">选择模式…</option>
                <option v-for="m in modeOptionsForWs(g.workspaceKey)" :key="m" :value="m">{{ m }}</option>
                <!-- 手填收进下拉最后一项(点了才展开输入框,不再每行常驻一个空洞) -->
                <option value="__manual__">手动输入…</option>
              </select>
              <input
                v-if="manualModeGroups[g.key]"
                v-model="groupModeEdit[g.key]"
                class="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                placeholder="手动输入模式名"
              >
            </div>
            <!-- 按钮状态一眼可辨:未选模式=描边灰字(明显不可用)/ 已选=实心蓝(明显可点) -->
            <Button
              size="sm"
              class="w-[120px] flex-none"
              :variant="groupModeEdit[g.key] ? 'default' : 'outline'"
              :disabled="!groupModeEdit[g.key] || groupSubmitting === g.key"
              @click="submitGroup(g)"
            >
              {{ groupSubmitting === g.key ? '补救中…' : `补救 ${g.count - g.dateRowCount}` }}
            </Button>
          </div>
          <span v-else class="ml-auto flex-none self-center text-xs text-status-warn">日期逐人不同 → 展开逐行确认</span>
        </div>

        <table v-if="expandedGroups[g.key]" class="w-full border-t border-border text-xs">
          <thead class="bg-muted/30 text-muted-foreground">
            <tr>
              <th class="px-3 py-1.5 text-left font-medium">姓名</th>
              <th class="px-2 py-1.5 text-left font-medium">护照</th>
              <th class="px-2 py-1.5 text-left font-medium">小票号</th>
              <th class="px-2 py-1.5 text-left font-medium">购买日期</th>
              <th v-if="g.rowByRowOnly" class="px-2 py-1.5 text-left font-medium">原因</th>
              <th class="px-3 py-1.5 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in g.rows" :key="row.id" class="border-t border-border/50">
              <td class="px-3 py-1.5">{{ row.name || '—' }}</td>
              <td class="px-2 py-1.5 font-mono">{{ row.passportNo || '—' }}</td>
              <td class="px-2 py-1.5 font-mono">{{ row.receiptNo || '—' }}</td>
              <td class="px-2 py-1.5">{{ fmtDate(row.purchaseDate) }}</td>
              <td v-if="g.rowByRowOnly" class="px-2 py-1.5">
                <StatusBadge variant="warn" size="sm">{{ TOUR_STATUS_LABEL[row.tourMatchStatus] || row.tourMatchStatus }}</StatusBadge>
              </td>
              <td class="px-3 py-1.5 text-right">
                <div class="flex items-center justify-end gap-1.5">
                  <Button size="sm" variant="outline" @click="openCustomerInfo(row)">客户信息</Button>
                  <Button size="sm" variant="outline" @click="openReview(row)">复查</Button>
                  <Button
                    size="sm"
                    variant="outline"
                    :disabled="!canLocateInReview(row)"
                    :title="canLocateInReview(row) ? '跳到审核台该客户组' : '该行不是审核台建档产生(批量导入/手工录入),无法直接定位;请去审核台搜索框用姓名/护照号/团号搜'"
                    @click="locateInReview(row)"
                  >
                    定位审核台
                  </Button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="!groups.length" class="rounded-lg border border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
        {{ selectedBatchKey ? '该批次当前没有待补救项' : '没有待补救项' }}
      </div>
    </div>

    <!-- 「按客户」视图(P2-4,2026-07-18 设计):同客户的票一卡收拢,卡内逐票补救 -->
    <div v-else class="space-y-2">
      <div v-for="c in customerCards" :key="c.key" class="overflow-hidden rounded-lg border border-border">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5 bg-card px-3 py-2.5">
          <span class="text-sm font-medium text-foreground">{{ c.name || '(无姓名)' }}</span>
          <span class="font-mono text-xs text-muted-foreground">{{ c.passportNo || '—' }}</span>
          <span class="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground">{{ c.rows.length }} 张票</span>
          <span class="font-mono text-[11px] text-muted-foreground">{{ c.rows[0]._workspaceKey }} · 批次 {{ c.rows[0].sourceBatchId || '—' }}</span>
          <StatusBadge variant="warn" size="sm">{{ [...c.reasons].map((s) => TOUR_STATUS_LABEL[s] || s).join(' / ') }}</StatusBadge>
          <div class="ml-auto flex items-center gap-1.5">
            <Button size="sm" variant="outline" @click="openCustomerInfo(c.rows[0])">客户信息</Button>
            <Button
              size="sm"
              variant="outline"
              :disabled="!canLocateInReview(c.rows[0])"
              :title="canLocateInReview(c.rows[0]) ? '跳到审核台该客户组' : '该客户不是审核台建档产生(批量导入/手工录入),无法直接定位'"
              @click="locateInReview(c.rows[0])"
            >
              定位审核台
            </Button>
          </div>
        </div>
        <table class="w-full border-t border-border text-xs">
          <thead class="bg-muted/30 text-muted-foreground">
            <tr>
              <th class="px-3 py-1.5 text-left font-medium">团号</th>
              <th class="px-2 py-1.5 text-left font-medium">购买日期</th>
              <th class="px-2 py-1.5 text-left font-medium">小票号</th>
              <th class="px-2 py-1.5 text-left font-medium">原因</th>
              <th class="px-2 py-1.5 text-left font-medium">选择模式</th>
              <th class="px-3 py-1.5 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in c.rows" :key="`${row._workspaceKey}:${row.id}`" class="border-t border-border/50">
              <td class="px-3 py-1.5 font-mono">{{ row.tourNo || '—' }}</td>
              <td class="px-2 py-1.5">{{ fmtDate(row.purchaseDate) }}</td>
              <td class="px-2 py-1.5 font-mono">{{ row.receiptNo || '—' }}</td>
              <td class="px-2 py-1.5">
                <StatusBadge variant="warn" size="sm">
                  {{ TOUR_STATUS_LABEL[row.tourMatchStatus] || row.tourMatchStatus || '—' }}
                </StatusBadge>
              </td>
              <td class="px-2 py-1.5">
                <!-- datalist 在 Chrome 中点▼经常不弹(输入值不前缀匹配时)→ 原生 select(可靠)+手动输入 -->
                <div class="flex flex-col gap-1">
                  <select
                    class="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                    :value="modeOptionsFor(row).includes(modeEdit[row.id]) ? modeEdit[row.id] : ''"
                    @change="modeEdit[row.id] = $event.target.value"
                  >
                    <option value="">选择模式…</option>
                    <option v-for="m in modeOptionsFor(row)" :key="m" :value="m">{{ m }}</option>
                  </select>
                  <input
                    v-model="modeEdit[row.id]"
                    class="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                    placeholder="或手动输入模式"
                  >
                </div>
              </td>
              <td class="px-3 py-1.5 text-right">
                <div class="flex items-center justify-end gap-1.5">
                  <Button size="sm" variant="outline" @click="openReview(row)">复查</Button>
                  <Button
                    size="sm"
                    variant="default"
                    :disabled="!modeEdit[row.id] || actionLoading === `submit:${row._workspaceKey}:${row.id}`"
                    @click="submitMode(row)"
                  >
                    确认模式
                  </Button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="!customerCards.length" class="rounded-lg border border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
        该批次当前没有待补救项
      </div>
    </div>

    <!-- 复查 Drawer(一期只读):为什么没匹配 + 团号表那几列 + 收票信息 -->
    <Drawer :open="!!reviewRow" @update:open="(v) => !v && closeReview()">
      <div v-if="reviewRow" class="flex h-full flex-col">
        <header class="border-b border-border pb-3">
          <div class="flex items-center gap-2">
            <StatusBadge variant="warn" size="sm">{{ TOUR_STATUS_LABEL[reviewRow.tourMatchStatus] || reviewRow.tourMatchStatus }}</StatusBadge>
            <h2 class="text-lg font-medium text-foreground">复查 · {{ reviewRow._workspaceKey }} #{{ reviewRow.id }}</h2>
          </div>
        </header>

        <div class="flex-1 space-y-4 overflow-y-auto py-4">
          <!-- ① 为什么没匹配 -->
          <section class="rounded-lg border border-status-warn/30 bg-status-warn/5 p-3">
            <h3 class="text-xs font-medium text-muted-foreground">① 为什么没匹配</h3>
            <p class="mt-1 text-sm font-medium text-foreground">{{ TOUR_STATUS_LABEL[reviewRow.tourMatchStatus] || reviewRow.tourMatchStatus }}</p>
            <p class="mt-1 text-xs text-muted-foreground">{{ REASON_HINT[reviewRow.tourMatchStatus] || '请人工核对后指定模式。' }}</p>
            <div v-if="reviewRow.tourMatchStatus === 'agent_mismatch'" class="mt-2 flex flex-wrap gap-3 text-sm">
              <div class="rounded border border-status-error/30 bg-status-error/10 px-2 py-1">
                收票写的代理:<span class="font-medium">{{ reviewRow.agent || '—' }}</span>
              </div>
              <div class="rounded border border-status-ok/30 bg-status-ok/10 px-2 py-1">
                团号表里这团号是:<span class="font-medium">{{ reviewGroupCodes.map((g) => g.agent).filter(Boolean).join(' / ') || '—' }}</span>
              </div>
            </div>
          </section>

          <!-- ② 团号表那几列 -->
          <section class="rounded-lg border border-border bg-card p-3">
            <h3 class="text-xs font-medium text-muted-foreground">② 团号表里这个团号(用来匹配的那几列)</h3>
            <p v-if="reviewLoading" class="mt-2 text-xs text-muted-foreground">加载中…</p>
            <p v-else-if="!reviewGroupCodes.length" class="mt-2 text-sm text-status-error">
              团号表里没有团号 <code class="font-mono">{{ reviewRow.tourNo || '—' }}</code> —— 这正是没匹配上的原因,需要核对团号或补录。
            </p>
            <div v-else class="mt-2 overflow-x-auto">
              <table class="w-full text-left text-xs">
                <thead class="text-muted-foreground">
                  <tr>
                    <th class="py-1 pr-3">团号</th><th class="py-1 pr-3">模式</th>
                    <th class="py-1 pr-3">代理</th><th class="py-1 pr-3">申请日期</th>
                    <th class="py-1 pr-3">出境日期</th><th class="py-1 pr-3">上家</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(g, i) in reviewGroupCodes" :key="i" class="border-t border-border/60">
                    <td class="py-1 pr-3 font-mono">{{ g.tourNo }}</td>
                    <td class="py-1 pr-3">{{ g.mode || '—' }}</td>
                    <td class="py-1 pr-3" :class="reviewRow.tourMatchStatus === 'agent_mismatch' ? 'font-medium text-status-warn' : ''">{{ g.agent || '—' }}</td>
                    <td class="py-1 pr-3" :class="reviewRow.tourMatchStatus === 'date_out_of_window' ? 'font-medium text-status-warn' : ''">{{ fmtDate(g.applyDate) }}</td>
                    <td class="py-1 pr-3" :class="reviewRow.tourMatchStatus === 'date_out_of_window' ? 'font-medium text-status-warn' : ''">{{ fmtDate(g.endDate) }}</td>
                    <td class="py-1 pr-3">{{ g.upstream || '—' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <!-- 二期:护照 / 小票原图 -->
          <section class="rounded-lg border border-border bg-card p-3">
            <div class="flex items-center justify-between">
              <h3 class="text-xs font-medium text-muted-foreground">护照 / 小票原图</h3>
              <Button size="sm" variant="outline" :disabled="imageLoading || !!imageTask" @click="loadImage">
                {{ imageLoading ? '加载中…' : (imageTask ? '已显示' : '查看护照/小票图片') }}
              </Button>
            </div>
            <p v-if="imageMsg" class="mt-2 text-xs text-muted-foreground">{{ imageMsg }}</p>
            <!-- 复用主审核台 ImageViewer:白嫖 缩放/拖拽/旋转(↺↻)(2026-07-13 用户要旋转) -->
            <div v-if="imageTask" class="mt-2" style="height: 480px">
              <ImageViewer :task="imageTask" />
            </div>
            <p v-if="reviewImageUrl" class="mt-1">
              <a :href="reviewImageUrl" target="_blank" rel="noopener" class="text-xs text-primary underline">在新标签打开大图</a>
            </p>
            <p class="mt-1 text-[11px] text-muted-foreground">对照图片复查:系统读的姓名/护照/团号是否和图上一致。不一致就在下面改正。</p>
          </section>

          <!-- 三期:改正客户信息 + 模式 -->
          <section class="rounded-lg border border-primary/30 bg-primary/5 p-3">
            <h3 class="text-xs font-medium text-muted-foreground">③ 复查并改正(可编辑)</h3>
            <div class="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <label class="flex flex-col gap-1">
                <span class="text-xs text-muted-foreground">姓名</span>
                <input v-model="editBuf.name" class="h-8 rounded-md border border-input bg-background px-2 text-sm">
              </label>
              <label class="flex flex-col gap-1">
                <span class="text-xs text-muted-foreground">护照号</span>
                <input v-model="editBuf.passportNo" class="h-8 rounded-md border border-input bg-background px-2 font-mono text-sm">
              </label>
              <label class="flex flex-col gap-1">
                <span class="text-xs text-muted-foreground">团号</span>
                <input v-model="editBuf.tourNo" class="h-8 rounded-md border border-input bg-background px-2 font-mono text-sm">
              </label>
              <label class="flex flex-col gap-1">
                <span class="text-xs text-muted-foreground">代理(导游)</span>
                <input v-model="editBuf.agent" class="h-8 rounded-md border border-input bg-background px-2 text-sm">
              </label>
              <label class="col-span-2 flex flex-col gap-1">
                <span class="text-xs text-muted-foreground">匹配模式(选了才会重新匹配为已匹配)</span>
                <select
                  class="h-8 rounded-md border border-input bg-background px-2 text-sm"
                  :value="modeOptionsFor(reviewRow).includes(editBuf.modeRaw) ? editBuf.modeRaw : ''"
                  @change="editBuf.modeRaw = $event.target.value"
                >
                  <option value="">选择模式…</option>
                  <option v-for="m in modeOptionsFor(reviewRow)" :key="m" :value="m">{{ m }}</option>
                </select>
                <input
                  v-model="editBuf.modeRaw"
                  class="h-8 rounded-md border border-input bg-background px-2 text-sm"
                  placeholder="或手动输入模式"
                >
              </label>
              <div class="text-xs text-muted-foreground">小票号(不可改)</div>
              <div class="font-mono text-sm">{{ reviewRow.receiptNo || '—' }}</div>
              <div class="text-xs text-muted-foreground">购买日期</div>
              <div class="text-sm">{{ fmtDate(reviewRow.purchaseDate) }}</div>
            </div>
            <p class="mt-2 text-[11px] text-muted-foreground">改动会留痕(谁改的、原值→新值)。改护照/姓名用于修正审核误读。</p>
          </section>
        </div>

        <footer class="flex justify-end gap-2 border-t border-border pt-3">
          <Button variant="ghost" size="sm" @click="closeReview">关闭</Button>
          <Button variant="default" size="sm" :disabled="reviewSaving" @click="saveReview">
            {{ reviewSaving ? '保存中…' : '保存改正' }}
          </Button>
        </footer>
      </div>
    </Drawer>

    <!-- P2 客户信息弹窗:该客户在审核批次里的护照+全部票+原图,补救时一眼看全人 -->
    <Drawer :open="!!customerInfo.row" @update:open="(v) => !v && closeCustomerInfo()">
      <div v-if="customerInfo.row" class="flex h-full flex-col">
        <header class="border-b border-border pb-3">
          <h2 class="text-lg font-medium text-foreground">
            客户信息 · {{ customerInfo.row.name || '(无姓名)' }}
          </h2>
          <p class="mt-1 font-mono text-xs text-muted-foreground">
            {{ customerInfo.row._workspaceKey }} · 批次 {{ customerInfo.row.sourceBatchId || '—' }} · 客户 {{ customerInfo.row.sourceCustomerId || '—' }}
          </p>
        </header>

        <div class="flex-1 space-y-4 overflow-y-auto py-4">
          <p v-if="customerInfo.loading" class="text-sm text-muted-foreground">加载客户档案中…</p>
          <p v-else-if="customerInfo.error" class="rounded-lg border border-status-warn/30 bg-status-warn/5 px-3 py-2 text-sm text-status-warn">
            {{ customerInfo.error }}
          </p>

          <section v-if="customerInfo.tasks.length" class="rounded-lg border border-border bg-card p-3">
            <h3 class="text-xs font-medium text-muted-foreground">该客户的全部扫描件({{ customerInfo.tasks.length }} 件,护照在前小票在后)</h3>
            <div class="mt-2 overflow-x-auto">
              <table class="w-full text-left text-xs">
                <thead class="text-muted-foreground">
                  <tr>
                    <th class="py-1 pr-3">类型</th><th class="py-1 pr-3">姓名</th>
                    <th class="py-1 pr-3">护照号</th><th class="py-1 pr-3">小票号</th>
                    <th class="py-1 pr-3">店</th><th class="py-1 pr-3">团号</th>
                    <th class="py-1 pr-3">状态</th><th class="py-1 pr-3" />
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="t in customerInfo.tasks"
                    :key="t.id"
                    class="border-t border-border/60"
                    :class="{ 'bg-primary/5': customerInfo.activeTask?.id === t.id }"
                  >
                    <td class="py-1 pr-3">{{ taskDocLabel(t) }}</td>
                    <td class="py-1 pr-3">{{ taskField(t, 'extractedNameFinal', 'extractedNameAuto') }}</td>
                    <td class="py-1 pr-3 font-mono">{{ taskField(t, 'passportNoFinal', 'passportNoAuto') }}</td>
                    <td class="py-1 pr-3 font-mono">{{ taskField(t, 'receiptNoFinal', 'receiptNoAuto') }}</td>
                    <td class="py-1 pr-3">{{ taskField(t, 'receiptStoreFinal', 'receiptStoreAuto') }}</td>
                    <td class="py-1 pr-3 font-mono">{{ taskField(t, 'groupNoFinal', 'groupNoAuto') }}</td>
                    <td class="py-1 pr-3">{{ t.processResult || '待处理' }}</td>
                    <td class="py-1 pr-3">
                      <button
                        v-if="t.imageUrl || t.sourceImageUrl"
                        type="button"
                        class="rounded border border-input px-1.5 py-0.5 text-[11px] hover:bg-muted"
                        @click="customerInfo.activeTask = t"
                      >
                        看图
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <!-- 复用主审核台 ImageViewer(缩放/拖拽/旋转),与复查 Drawer 同款手法 -->
          <section v-if="customerInfo.activeTask" class="rounded-lg border border-border bg-card p-3">
            <h3 class="text-xs font-medium text-muted-foreground">原图 · {{ taskDocLabel(customerInfo.activeTask) }}</h3>
            <div class="mt-2" style="height: 480px">
              <ImageViewer :task="customerInfo.activeTask" />
            </div>
          </section>
        </div>

        <footer class="flex justify-end gap-2 border-t border-border pt-3">
          <Button
            variant="outline"
            size="sm"
            :disabled="!canLocateInReview(customerInfo.row)"
            :title="canLocateInReview(customerInfo.row) ? '跳到审核台该客户组' : '该行不是审核台建档产生,无法直接定位'"
            @click="locateInReview(customerInfo.row)"
          >
            定位审核台
          </Button>
          <Button variant="ghost" size="sm" @click="closeCustomerInfo">关闭</Button>
        </footer>
      </div>
    </Drawer>
  </section>
</template>
