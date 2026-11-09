<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import {
  fetchLibraryOverview,
  fetchDeliveryPlans,
  fetchDeliveryReadiness,
  fetchLibraryPrecheck,
  downloadLibraryModeExport,
  downloadBatchCustomerFolders,
  downloadHyundaiDelivery,
  downloadLotteDeptDelivery,
  downloadModeDelivery,
} from '../api/libraryExport'
import { groupBatchesByDay, batchOptionLabel } from '../lib/batchGrouping'
import { buildReviewDeepLink } from '../lib/agentWorkspaceLinks'

// ── 资料库 · 交付工作台(2026-07-16 P0,设计=docs/资料库交付工作台设计_2026-07-16.md)──
// 每人 × 每批次 = 处理单元(用户拍板"不要混在一起"):左栏我的批次,右栏该批次交付面板,
// 所有数字/卡片/表格只算选中批次。计划卡与配置台注册表 1:1 同源(delivery-plans 端点)。
const router = useRouter()

// 内置计划白话标题(注册表 name 是配置键不能动,展示名在这层做)
const PLAN_TITLES = {
  '内置·多模式四规则': '一键交付包(全部模式自动分类)',
  '内置·乐天百货门店双图': '乐天百货交付包(门店双图)',
  '内置·现代三池交付包': '现代三池交付包',
  '内置·客户文件夹': '客户文件夹(原图打包)',
  '内置·客户数据Excel': '客户数据 Excel(sheet1汇总+每模式一sheet)',
}

const overview = ref({ workspaces: [], batches: [], modes: [], rephotoCount: 0, customers: [] })
const overviewLoading = ref(false)
const selectedBatchId = ref('')
const filterWorkspace = ref('')
const plans = ref([])
const plansLoading = ref(false)
const modesInBatch = ref([])
const exportError = ref('')

// 预检结果(最近一次):阻断/跳过明细进「阻断/需重拍」页签
const readiness = ref(null)
const readinessLoading = ref('')
const expandedRules = ref('') // 展开规则说明的计划名

const activeTab = ref('customers') // customers | blocked
const filterMode = ref('')

const selectedBatch = computed(() => overview.value.batches.find((b) => b.id === selectedBatchId.value) || null)
const groupedBatches = computed(() => {
  const list = filterWorkspace.value
    ? overview.value.batches.filter((b) => !b.workspaceKey || b.workspaceKey === filterWorkspace.value)
    : overview.value.batches
  return groupBatchesByDay(list)
})
const libCustomers = computed(() => overview.value.customers)
const totalReceipts = computed(() => overview.value.modes.reduce((n, m) => n + (m.receipts || 0), 0))
const reviewedCount = computed(() => libCustomers.value.filter((c) => c.status === 'reviewed').length)
const rephotoRows = computed(() => libCustomers.value.filter((c) => c.status === 'rephoto'))
const modeOptions = computed(() => [...new Set(libCustomers.value.map((c) => c.mode).filter(Boolean))])
const shownCustomers = computed(() => (
  filterMode.value ? libCustomers.value.filter((c) => c.mode === filterMode.value) : libCustomers.value
))
// 阻断计数(复核M2):现代缺票号在「多模式四规则」和「现代三池」两张卡各报一次(同一批任务),
// 直接相加会双计 → 漏斗只取 一键包+乐天百货 两个互不重叠的口径
const blockedTotal = computed(() => plans.value
  .filter((p) => p.builtin === 'mode_delivery' || p.builtin === 'lotte_dept')
  .reduce((n, p) => n + (p.blockedCount || 0), 0))

// 预检清单的**真总数**(2026-08-01):后端把四个清单都截到 listCap 条,同时给 totals。
// 一律读 totals,读不到才回落数组长度(老后端兼容)——直接读数组长度就是拿截断值当总数。
function readinessTotal(key) {
  const t = readiness.value?.totals?.[key]
  return Number.isFinite(t) ? t : (readiness.value?.[key]?.length || 0)
}
// 哪几类被截断了(用来出那句说明;没截断就不出声,不给人添噪音)
const READINESS_LIST_LABELS = { blocked: '阻断', skipped: '未审跳过', reviewedNotSettled: '已审核未结算', passportBlocked: '缺护照拦结算' }
const readinessTruncated = computed(() => Object.entries(READINESS_LIST_LABELS)
  .filter(([k]) => readinessTotal(k) > (readiness.value?.[k]?.length || 0))
  .map(([k, label]) => `${label}共 ${readinessTotal(k)} 条`))

function planTitle(plan) {
  return PLAN_TITLES[plan.name] || plan.label || plan.name
}
// image61 设计稿(0728 用户拍板:功能保留、UI 以文档设计为准):
// 客户数据 Excel 从计划卡堆里拎出来,置顶成「收票汇总.xlsx」卡;其余计划走紧凑行式列表。
const excelPlan = computed(() => plans.value.find((p) => p.builtin === 'library_excel') || null)
const packagePlans = computed(() => plans.value.filter((p) => p.builtin !== 'library_excel'))
// 「sheet2 起按模式分表(N 种)」的 N:本批次实际有的模式数(一键交付包渠道数同口径)
const modeKindCount = computed(() => {
  const md = plans.value.find((p) => p.builtin === 'mode_delivery')
  return md?.zones?.length || 0
})

// 竞态守卫(复核M1):快速切批次时旧响应可能后到,写回前校验批次没换——绝不跨批次串数据
async function loadOverview() {
  const requestedBatchId = selectedBatchId.value
  overviewLoading.value = true
  exportError.value = ''
  try {
    // 未选批次=首屏引导:lite 只拿批次列表+徽章,跳过重拍全扫(复核H2,admin 尤其重)
    const data = await fetchLibraryOverview({ batchId: requestedBatchId, lite: requestedBatchId ? '' : '1' })
    if (selectedBatchId.value !== requestedBatchId) return
    overview.value = {
      workspaces: data.workspaces || [],
      batches: data.batches || [],
      modes: data.modes || [],
      rephotoCount: data.rephotoCount || 0,
      customers: data.customers || [],
    }
    // 首次进页面:自动选中最新一个批次(操作员通常处理当天的)
    if (!selectedBatchId.value && overview.value.batches.length) {
      selectBatch(overview.value.batches[0].id)
    }
  } catch (error) {
    exportError.value = error?.response?.data?.error || error?.message || '加载日交付数据失败'
  } finally {
    overviewLoading.value = false
  }
}

async function loadPlans() {
  const requestedBatchId = selectedBatchId.value
  if (!requestedBatchId) { plans.value = []; return }
  plansLoading.value = true
  try {
    const data = await fetchDeliveryPlans(requestedBatchId)
    if (selectedBatchId.value !== requestedBatchId) return
    plans.value = data.plans || []
    modesInBatch.value = data.modesInBatch || []
  } catch (error) {
    if (selectedBatchId.value !== requestedBatchId) return
    plans.value = []
    exportError.value = error?.response?.data?.error || error?.message || '加载交付计划失败'
  } finally {
    if (selectedBatchId.value === requestedBatchId) plansLoading.value = false
  }
}

function selectBatch(batchId) {
  if (selectedBatchId.value === batchId) return
  selectedBatchId.value = batchId
  readiness.value = null
  filterMode.value = ''
  activeTab.value = 'customers'
}

// ── 批次多选跨批导出(2026-07-28,F4 参考图第二刀)────────────────────────────
// 勾选≠切换工作批次:点行还是单选进面板(口径不变),复选框只喂「跨批出 Excel」。
// 只做 Excel(SQL 层 IN 聚合天然安全);交付包 zip 跨批要并 staging,另拍板再做。
const pickedBatchIds = ref(new Set())
function toggleBatchPick(batchId) {
  const next = new Set(pickedBatchIds.value)
  if (next.has(batchId)) next.delete(batchId)
  else next.add(batchId)
  pickedBatchIds.value = next
}
const pickedBatchSummary = computed(() => {
  const picked = overview.value.batches.filter((b) => pickedBatchIds.value.has(b.id))
  return {
    count: picked.length,
    customers: picked.reduce((n, b) => n + (b.settledCustomers || 0), 0),
    receipts: picked.reduce((n, b) => n + (b.settledReceipts || 0), 0),
  }
})
async function exportPickedBatchesExcel() {
  const batchIds = [...pickedBatchIds.value]
  if (!batchIds.length) return
  exportingKey.value = '__multi_batch_excel__'
  exportError.value = ''
  try {
    const blob = await downloadLibraryModeExport({ batchIds })
    triggerBlobDownload(blob, `收票汇总_跨${batchIds.length}批次.xlsx`)
  } catch (error) {
    exportError.value = await readBlobError(error, '跨批导出失败')
  } finally {
    exportingKey.value = ''
  }
}

// ── 格式预检(0727反馈#15):台账行按交付合同核票号形态/购买日期,疑似审核失误前置 ──
// 只读不拦导出:预检是眼睛不是闸,拦不拦由人决定。每个问题行可跳回审核台改。
const precheck = ref({ checkedRows: 0, issues: [] })
const precheckLoading = ref(false)
const precheckExpanded = ref(false)
// 预检**自己崩了**要说出来(2026-08-01 补):原来 catch 里把结果清空,于是红面板不显示、
// 绿字也不显示——页面上什么都没有,和「这批还没结算」长得一模一样。
// 用户分不清"通过 / 没跑 / 崩了",而这三种的下一步动作完全不同。
const precheckError = ref('')
const PRECHECK_PREVIEW = 12 // 前置只露前 N 条,长名单点开看全
const shownIssues = computed(() => (
  precheckExpanded.value ? precheck.value.issues : precheck.value.issues.slice(0, PRECHECK_PREVIEW)
))
// 预检的筛选口径 = **你正要导出的那一批**(2026-08-01 补):
// 勾了跨批就检那几批,没勾就检当前批,连批次都没选就检整个月度工作区。
// 原来只认单批 batchId,于是跨批导出/整月导出都不触发预检——而月底交付最常走这两条。
const precheckScope = computed(() => {
  const picked = [...pickedBatchIds.value]
  if (picked.length) return { key: `ids:${picked.slice().sort().join(',')}`, params: { batchIds: picked } }
  if (selectedBatchId.value) return { key: `id:${selectedBatchId.value}`, params: { batchId: selectedBatchId.value } }
  // 整月导出走的就是 filterWorkspace(见 exportWholeWorkspace 的 downloadLibraryModeExport 入参),
  // 预检必须用同一个 ref,不能另起一个名字——写错名字的话这个分支永远是 undefined,静默失效。
  if (filterWorkspace.value) return { key: `ws:${filterWorkspace.value}`, params: { workspaceKey: filterWorkspace.value } }
  return { key: '', params: null }
})
// 「检的是哪一批」要写在绿字里:跨批/整月这两条路径以前压根不检,现在检了也得让人看见
// 检的范围,否则"通过"两个字在不同口径下含义不同。
const precheckScopeLabel = computed(() => {
  const picked = pickedBatchIds.value.size
  if (picked) return `勾选的 ${picked} 个批次`
  if (selectedBatchId.value) return '当前批次'
  return `整个 ${filterWorkspace.value} 工作区`
})
async function loadPrecheck() {
  const scope = precheckScope.value
  if (!scope.params) { precheck.value = { checkedRows: 0, issues: [] }; precheckError.value = ''; return }
  precheckLoading.value = true
  precheckError.value = ''
  try {
    const data = await fetchLibraryPrecheck(scope.params)
    if (precheckScope.value.key !== scope.key) return // 竞态守卫(复核M1同款):选择已经变了就丢弃
    precheck.value = { checkedRows: data.checkedRows || 0, issues: data.issues || [] }
    precheckExpanded.value = false
  } catch (error) {
    if (precheckScope.value.key !== scope.key) return
    // 不挡工作台(预检是眼睛不是闸),但必须让人看见它没跑成
    precheck.value = { checkedRows: 0, issues: [] }
    precheckError.value = error?.response?.data?.error || error?.message || '预检没跑成'
  } finally {
    if (precheckScope.value.key === scope.key) precheckLoading.value = false
  }
}
// 跳回审核台改(深链与代理视图同一构造器):group=客户号(任务 sourceGroupKey 即客户号),
// 找不到组时审核台自带「记录已变化」提示,不会静默跳错人。
function goFixIssue(issue) {
  const link = buildReviewDeepLink({
    batchId: issue.batchId || selectedBatchId.value,
    view: 'queue',
    group: issue.customerId,
    returnTo: router.currentRoute.value?.fullPath || '',
  })
  if (link) router.push(link)
}

watch(selectedBatchId, () => {
  if (!selectedBatchId.value) return
  loadOverview()
  loadPlans()
})
// 预检跟着**导出口径**走,不跟着"当前批次"走(2026-08-01):勾选跨批、切换月度工作区
// 都会换掉你即将导出的那一批,预检必须跟着换,否则它检的是另一批数据。
watch(() => precheckScope.value.key, () => { loadPrecheck() }, { immediate: true })

async function runReadiness(plan) {
  const requestedBatchId = selectedBatchId.value
  if (!requestedBatchId) return
  readinessLoading.value = plan.name
  exportError.value = ''
  try {
    const result = await fetchDeliveryReadiness({ batchId: requestedBatchId, planName: plan.name })
    if (selectedBatchId.value !== requestedBatchId) return // 竞态守卫(复核M1)
    readiness.value = result
    activeTab.value = 'blocked'
  } catch (error) {
    if (selectedBatchId.value !== requestedBatchId) return
    exportError.value = error?.response?.data?.error || error?.message || '预检失败'
  } finally {
    readinessLoading.value = ''
  }
}

// 阻断行 → 审核台定位(补救台同款深链;能定位的才亮按钮)
function locateInReview(item) {
  if (!item?.customerId) return
  const link = buildReviewDeepLink({
    batchId: selectedBatchId.value,
    group: item.customerId,
    task: item.taskId || '',
  })
  if (link) router.push(link)
}

// ── 导出(P0=老端点承载;内置计划各回各的端点,DSL/Excel 计划执行入口 P1 开放)──
const exportingKey = ref('') // '计划名' 或 '计划名::zone'
function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

async function readBlobError(error, fallback) {
  const data = error?.response?.data
  if (data instanceof Blob) {
    try { return JSON.parse(await data.text()).error || fallback } catch { return fallback }
  }
  return data?.error || error?.message || fallback
}

const BUILTIN_EXPORTERS = {
  mode_delivery: (batchId, zone) => downloadModeDelivery(batchId, { zone }),
  lotte_dept: (batchId) => downloadLotteDeptDelivery(batchId),
  hyundai_delivery: (batchId) => downloadHyundaiDelivery(batchId),
  customer_folders: (batchId) => downloadBatchCustomerFolders(batchId),
  library_excel: (batchId) => downloadLibraryModeExport({ batchId }),
}

async function exportPlan(plan, zone = '') {
  if (!selectedBatchId.value || !plan.builtin) return
  const exporter = BUILTIN_EXPORTERS[plan.builtin]
  if (!exporter) { exportError.value = `该计划的导出入口尚未开放:${plan.name}`; return }
  exportingKey.value = zone ? `${plan.name}::${zone}` : plan.name
  exportError.value = ''
  try {
    const blob = await exporter(selectedBatchId.value, zone)
    const batchName = selectedBatch.value?.name || selectedBatchId.value.slice(-8)
    const suffix = plan.builtin === 'library_excel' ? '.xlsx' : '.zip'
    const zonePart = zone ? `_${zone}` : ''
    const base = plan.builtin === 'library_excel' ? '收票汇总' : planTitle(plan) // image61:Excel 就叫收票汇总
    triggerBlobDownload(blob, `${batchName}_${base}${zonePart}${suffix}`)
  } catch (error) {
    exportError.value = await readBlobError(error, '导出失败(可先点「预检」看是否有阻断)')
  } finally {
    exportingKey.value = ''
  }
}

// 渠道多选导出(2026-07-28,F4 参考图落地):勾几家一次出一个 zip(zip 内各渠道仍各自顶层夹)。
// 选中集按批次隔离:切批次即清,防"上一批勾的渠道"带进新批次误导出。
const selectedZones = ref(new Set())
watch(selectedBatchId, () => { selectedZones.value = new Set() })
function toggleZone(zoneName) {
  const next = new Set(selectedZones.value)
  if (next.has(zoneName)) next.delete(zoneName)
  else next.add(zoneName)
  selectedZones.value = next
}
// 选中合计(image27 参考图:「已选 2 · 88 客户夹」)——三池渠道无客户夹概念,按张数并入
const selectedZoneDirs = computed(() => {
  const plan = plans.value.find((p) => p.builtin === 'mode_delivery')
  if (!plan?.zones) return 0
  return plan.zones
    .filter((z) => selectedZones.value.has(z.zone))
    .reduce((sum, z) => sum + (z.customerDirs ?? z.files ?? 0), 0)
})
async function exportSelectedZones(plan) {
  const zones = [...selectedZones.value]
  if (!zones.length || !selectedBatchId.value) return
  exportingKey.value = `${plan.name}::__multi__`
  exportError.value = ''
  try {
    const blob = await downloadModeDelivery(selectedBatchId.value, { zones })
    const batchName = selectedBatch.value?.name || selectedBatchId.value.slice(-8)
    // 只勾一家=单发,文件名直接带渠道名(与后端 stagingName 单区口径一致)
    const suffix = zones.length === 1 ? `_${zones[0]}` : `_选中${zones.length}渠道`
    triggerBlobDownload(blob, `${batchName}_${planTitle(plan)}${suffix}.zip`)
  } catch (error) {
    exportError.value = await readBlobError(error, '导出失败(可先点「预检」看是否有阻断)')
  } finally {
    exportingKey.value = ''
  }
}

// 整月 Excel(旧版工作区口径,月末回溯用;批次卡片默认只出本批次)
async function exportMonthlyExcel() {
  if (!filterWorkspace.value) return
  exportingKey.value = 'excel-month'
  exportError.value = ''
  try {
    const blob = await downloadLibraryModeExport({ workspaceKey: filterWorkspace.value })
    triggerBlobDownload(blob, `收票汇总_整月_${filterWorkspace.value}.xlsx`)
  } catch (error) {
    exportError.value = await readBlobError(error, '整月 Excel 导出失败')
  } finally {
    exportingKey.value = ''
  }
}

const isExporting = computed(() => Boolean(exportingKey.value))
const exportingLabel = computed(() => (exportingKey.value ? `正在打包「${exportingKey.value.replace('::', ' · ')}」` : '正在导出'))

// 分页(客户过多时选页)。筛选/数据变化时回第一页。
const page = ref(1)
const pageSize = ref(50)
const totalPages = computed(() => Math.max(1, Math.ceil(shownCustomers.value.length / pageSize.value)))
const pagedCustomers = computed(() => {
  const start = (page.value - 1) * pageSize.value
  return shownCustomers.value.slice(start, start + pageSize.value)
})
watch([filterMode, libCustomers, pageSize], () => { page.value = 1 })
function goPage(p) { page.value = Math.min(totalPages.value, Math.max(1, p)) }

onMounted(loadOverview)
</script>

<template>
  <section class="page-title">
    <div>
      <h1>日交付</h1>
      <p>按批次处理:选中你的批次,预检 → 修阻断 → 导出交付包。计划来自配置台,只显示你自己的批次。</p>
    </div>
    <div class="page-actions">
      <button class="ghost-button" type="button" :disabled="overviewLoading" @click="() => { loadOverview(); loadPlans() }">
        {{ overviewLoading ? '加载中' : '刷新' }}
      </button>
    </div>
  </section>

  <!-- 导出中提示条:大批次打包 1-2 分钟,别让操作员以为没反应/重复点 -->
  <div v-if="isExporting" class="export-progress-banner">
    <span class="spinner" aria-hidden="true" />
    <span>{{ exportingLabel }}中,大批次需 1-2 分钟,请稍候,不要关闭页面或重复点击…</span>
  </div>
  <div v-if="exportError" class="empty" style="color:#b42318; margin-bottom:8px;">{{ exportError }}</div>

  <div class="library-layout">
    <!-- 左栏:我的批次(owner 隔离由服务端做;admin 看全部) -->
    <aside class="batch-rail">
      <div class="rail-head">
        <strong>我的批次</strong>
        <select v-model="filterWorkspace" style="max-width:110px; font-size:12px;">
          <option value="">全部月份</option>
          <option v-for="w in overview.workspaces" :key="w.workspaceKey" :value="w.workspaceKey">{{ w.workspaceKey }}</option>
        </select>
      </div>
      <div v-if="!overview.batches.length && !overviewLoading" class="empty">还没有批次</div>
      <div v-for="g in groupedBatches" :key="g.key" class="rail-group">
        <div class="rail-group-label">{{ g.label }} <span class="rail-group-count">{{ g.items.length }} 个</span></div>
        <!-- 复选框=跨批多选(F4 参考图);点行仍是单选进面板,两套互不干扰 -->
        <div v-for="b in g.items" :key="b.id" class="batch-row" :class="{ picked: pickedBatchIds.has(b.id) }">
          <input
            type="checkbox"
            class="batch-pick"
            :checked="pickedBatchIds.has(b.id)"
            :title="`勾选加入跨批导出(已结算 ${b.settledCustomers || 0} 客户)`"
            @change="toggleBatchPick(b.id)"
          >
          <button
            type="button"
            class="batch-item"
            :class="{ active: b.id === selectedBatchId }"
            @click="selectBatch(b.id)"
          >
            <span class="batch-item-name">{{ batchOptionLabel(b) }}</span>
            <span class="batch-item-meta">
              {{ b.settledCustomers || 0 }} 客户 · {{ b.settledReceipts || 0 }} 票
            </span>
          </button>
        </div>
      </div>
      <!-- 跨批导出脚(参考图 image61 左栏底):勾了才出现,不占常驻空间 -->
      <div v-if="pickedBatchSummary.count" class="rail-foot">
        <div class="muted" style="font-size:12px;">
          已选 {{ pickedBatchSummary.count }} 个批次 · {{ pickedBatchSummary.customers }} 客户 · {{ pickedBatchSummary.receipts }} 票
        </div>
        <button
          class="primary-button small"
          type="button"
          :disabled="isExporting"
          title="把选中批次的已结算客户数据合并出一张 Excel(sheet1 汇总 + 每模式一 sheet)"
          @click="exportPickedBatchesExcel"
        >
          {{ exportingKey === '__multi_batch_excel__' ? '导出中…' : '跨批导出 Excel' }}
        </button>
      </div>
    </aside>

    <!-- 右栏:选中批次的交付面板(全部数字=该批次内口径,绝不跨批次混算) -->
    <section class="delivery-panel">
      <div v-if="!selectedBatchId" class="empty">先在左侧选一个批次</div>
      <template v-else>
        <!-- 汇总条(image61 设计稿:一行内联大数字,不再是四个白卡;需重拍琥珀/阻断红,>0 才着色) -->
        <div class="summary-strip">
          <span class="ss-item">已结算客户 <b>{{ reviewedCount }}</b></span>
          <span class="ss-item">票数 <b>{{ totalReceipts }}</b></span>
          <button class="ss-item ss-link" type="button" @click="activeTab = 'blocked'">
            需重拍 <b :class="{ amber: overview.rephotoCount > 0 }">{{ overview.rephotoCount }}</b>
          </button>
          <button class="ss-item ss-link" type="button" @click="activeTab = 'blocked'">
            阻断 <b :class="{ red: blockedTotal > 0 }">{{ blockedTotal }}</b>
          </button>
        </div>

        <!-- 格式预检(0727反馈#15):台账行按交付合同核票号/日期,疑似审核失误**前置**——
             导出前先看见,每行可跳回审核台改;通过时一行绿字不占地。
             三种状态必须长得不一样(2026-08-01):有问题 / 通过 / **没跑成**。
             原来第三种是空白,和「这批还没结算」一模一样,人分不清该不该放心导。 -->
        <p v-if="precheckError" class="precheck-failed">
          ⚠ 格式预检没跑成:{{ precheckError }}
          <button class="ghost-button small" type="button" @click="loadPrecheck()">重试</button>
          <span class="muted">这不代表数据有问题,也不代表没问题——这一次没检成,导出照常可用。</span>
        </p>
        <div v-else-if="precheck.issues.length" class="panel precheck-panel">
          <div class="panel-header">
            <strong style="color:#b42318;">格式预检:{{ precheck.issues.length }} 处疑似审核失误</strong>
            <span class="muted" style="font-size:12px;">共查 {{ precheck.checkedRows }} 行台账 · 不拦导出,建议先改再出</span>
          </div>
          <div class="panel-body">
            <ul class="precheck-list">
              <li v-for="issue in shownIssues" :key="issue.rowId">
                <span class="pc-cust" :title="`批次 ${issue.batchId}`">{{ issue.customerId }}</span>
                <span class="pc-mode muted">{{ issue.mode }}</span>
                <span class="pc-problems">{{ issue.problems.join(';') }}</span>
                <button class="ghost-button small" type="button" title="打开审核台并定位到这个客户组" @click="goFixIssue(issue)">去审核台改</button>
              </li>
            </ul>
            <button
              v-if="precheck.issues.length > PRECHECK_PREVIEW"
              class="ghost-button small"
              type="button"
              @click="precheckExpanded = !precheckExpanded"
            >
              {{ precheckExpanded ? '收起' : `展开全部 ${precheck.issues.length} 条` }}
            </button>
          </div>
        </div>
        <p v-else-if="!precheckLoading && precheck.checkedRows > 0" class="precheck-ok">
          ✓ 格式预检通过:{{ precheck.checkedRows }} 行台账未发现票号/日期形态问题
          <span class="muted">(检的是{{ precheckScopeLabel }})</span>
        </p>

        <!-- 收票汇总.xlsx(image61 设计稿置顶卡):客户数据 Excel 从计划堆里拎出来,
             文件名/说明/阻断一眼全;导出端点不变(downloadLibraryModeExport)。 -->
        <div v-if="excelPlan" class="ledger-export-card">
          <div class="lec-main">
            <div class="lec-title">收票汇总.xlsx</div>
            <div class="lec-sub muted">
              {{ reviewedCount }} 客户 · {{ excelPlan.stats?.rows ?? totalReceipts }} 台账行 · <span :style="blockedTotal ? 'color:#b42318;' : ''">{{ blockedTotal ? `阻断 ${blockedTotal}` : '无阻断' }}</span>
            </div>
            <div class="lec-sub muted">sheet1 汇总记录 · sheet2 起按模式分表{{ modeKindCount ? `(${modeKindCount} 种)` : '' }}</div>
          </div>
          <div class="lec-actions">
            <button
              v-if="filterWorkspace"
              class="ghost-button"
              type="button"
              :disabled="isExporting"
              :title="`不限批次,导出 ${filterWorkspace} 整月的已结算客户数据(旧版工作区口径)`"
              @click="exportMonthlyExcel"
            >
              {{ exportingKey === 'excel-month' ? '打包中…' : `整月(${filterWorkspace})` }}
            </button>
            <button
              class="primary-button"
              type="button"
              :disabled="isExporting"
              @click="exportPlan(excelPlan)"
            >
              {{ exportingKey === excelPlan.name ? '打包中…' : '⬇ 导出' }}
            </button>
          </div>
        </div>

        <!-- 计划行区(与配置台注册表 1:1;image61 风格=紧凑行式,不再大卡堆叠) -->
        <div class="panel" style="margin-top:12px;">
          <div class="panel-header">
            <strong>交付包</strong>
            <span class="count">{{ plansLoading ? '加载中…' : `${packagePlans.length} 个` }}</span>
            <span class="muted" style="font-size:12px;">计划由配置台统一管理,这里只管预检和导出</span>
          </div>
          <div class="panel-body">
            <div v-for="plan in packagePlans" :key="plan.name" class="plan-card" :class="{ inapplicable: plan.applicable === false }">
              <div class="plan-card-head">
                <div>
                  <strong>{{ planTitle(plan) }}</strong>
                  <!-- 「内置」胶囊删(文档I区点评:减少小标签堆积);配置台计划是要紧区分,保留 -->
                  <span v-if="plan.kindType !== 'builtin'" class="status" style="margin-left:6px; background:#eeedfe; color:#3c3489;">配置台计划</span>
                  <span v-if="plan.applicable === false" class="muted" style="margin-left:6px; font-size:12px;">(范围模式不在本批次)</span>
                </div>
                <div class="plan-card-actions">
                  <button
                    v-if="plan.rulesSpec"
                    class="ghost-button small"
                    type="button"
                    @click="expandedRules = expandedRules === plan.name ? '' : plan.name"
                  >
                    {{ expandedRules === plan.name ? '收起规则' : '查看规则' }}
                  </button>
                  <!-- 2026-07-27 需求F②:客户数据 Excel 卡不出「预检」——它的 readiness 里
                       blocked/skipped 是写死 0,只回客户数/台账行数,而这两个数上面那行统计
                       已经在显示了,点一下等于零信息。别的计划(交付包)的预检有真阻断明细,照常出。 -->
                  <button
                    v-if="plan.builtin !== 'library_excel'"
                    class="ghost-button small"
                    type="button"
                    :disabled="readinessLoading === plan.name"
                    @click="runReadiness(plan)"
                  >
                    {{ readinessLoading === plan.name ? '预检中…' : '预检' }}
                  </button>
                  <button
                    v-if="plan.builtin"
                    class="outline-primary small"
                    type="button"
                    :disabled="isExporting"
                    @click="exportPlan(plan)"
                  >
                    {{ exportingKey === plan.name ? '打包中…' : (plan.builtin === 'mode_delivery' ? '导出全部' : '导出') }}
                  </button>
                  <span v-if="!plan.builtin" class="muted" style="font-size:12px;">导出入口下期开放,先用预检</span>
                </div>
              </div>
              <div class="plan-card-stats muted">
                <template v-if="plan.stats">
                  <span v-if="plan.stats.customers !== undefined">客户 {{ plan.stats.customers }}</span>
                  <span v-if="plan.stats.files !== undefined">· 文件 {{ plan.stats.files }}</span>
                  <span v-if="plan.stats.rows !== undefined">· 台账行 {{ plan.stats.rows }}</span>
                  <span v-if="plan.blockedCount" style="color:#b42318;">· 阻断 {{ plan.blockedCount }}(点预检看明细)</span>
                  <span v-if="plan.stats.skipped">· 未审跳过 {{ plan.stats.skipped }}</span>
                </template>
              </div>

              <!-- 规则说明(builtin_export_plan_specs 人话规则,配置台同源) -->
              <div v-if="expandedRules === plan.name && plan.rulesSpec" class="plan-rules">
                <p class="muted" style="margin:0 0 6px;">{{ plan.rulesSpec.summary }}</p>
                <div v-for="rule in plan.rulesSpec.rules" :key="rule.title" class="plan-rule-row">
                  <strong>{{ rule.title }}</strong>
                  <div class="muted">条件:{{ rule.when }}</div>
                  <div class="muted">文件夹:{{ rule.folder }}</div>
                  <div class="muted">文件:{{ rule.files }}</div>
                  <div v-if="rule.note" class="muted">备注:{{ rule.note }}</div>
                </div>
                <p v-if="plan.rulesSpec.fallback" class="muted" style="margin:6px 0 0;">兜底:{{ plan.rulesSpec.fallback }}</p>
                <!-- 0724-F3 用户原话:「规则在配置台设置」。这块是**只读说明**,
                     看完想改以前是断的(页面上没有任何通往配置台的路)。
                     深链直接落到「交付导出」板块,不把人扔到配置台首页自己找。 -->
                <p class="muted plan-rules-source">
                  这些规则在配置台设置,这里只能看 ——
                  <RouterLink to="/admin/config?nav=exports">去配置台改</RouterLink>
                </p>
              </div>

              <!-- 按客户导出清单(0728 image27 参考图定稿:「多选,不是11个独立命令」)——
                   两列勾选清单:勾选框+模式名+灰括号整理方式+右对齐计数;唯一动作=右上「导出选中」。
                   单发一家=只勾一家(旧逐卡导出按钮删除,11个命令收成1个)。 -->
              <div v-if="plan.builtin === 'mode_delivery' && plan.zones && plan.zones.length" class="zone-block">
                <div class="zone-list-head">
                  <span class="zone-list-title">按客户导出 <em class="muted-inline">文件夹结构与「导出全部」一致</em></span>
                  <span class="zone-list-actions">
                    <span v-if="selectedZones.size" class="muted-inline">已选 {{ selectedZones.size }} · {{ selectedZoneDirs }} 客户夹</span>
                    <button
                      v-if="selectedZones.size"
                      class="primary-button small"
                      type="button"
                      :disabled="isExporting"
                      @click="exportSelectedZones(plan)"
                    >
                      {{ exportingKey === `${plan.name}::__multi__` ? '打包中…' : '导出选中' }}
                    </button>
                  </span>
                </div>
                <div class="zone-list">
                  <!-- 需求F①:模式名不加粗(这里没有哪个模式该被强调),
                       整理方式用灰色括号跟在名字后面(用户原话「乐天SG-本司(普通)」) -->
                  <label
                    v-for="z in plan.zones"
                    :key="z.zone"
                    class="zone-row"
                    :class="{ picked: selectedZones.has(z.zone), unpickable: z.zone === '未归类' }"
                  >
                    <input
                      v-if="z.zone !== '未归类'"
                      type="checkbox"
                      :checked="selectedZones.has(z.zone)"
                      @change="toggleZone(z.zone)"
                    >
                    <span class="zone-name">{{ z.zone }}<em v-if="z.layout" class="zone-layout">（{{ z.layout }}）</em></span>
                    <span v-if="z.zone === '未归类'" class="zone-hint muted">还没匹配上模式,去审核台/账单管理补</span>
                    <span class="zone-count">{{ z.customerDirs !== null ? z.customerDirs : z.files }}</span>
                  </label>
                </div>
              </div>
            </div>
            <div v-if="!plans.length && !plansLoading" class="empty">没有可用的交付计划</div>
          </div>
        </div>

        <!-- 页签:待交付客户 | 阻断/需重拍 -->
        <div class="panel" style="margin-top:12px;">
          <div class="panel-header" style="gap:2px;">
            <button class="tab-button" :class="{ active: activeTab === 'customers' }" type="button" @click="activeTab = 'customers'">
              已结算客户 {{ reviewedCount }}
            </button>
            <button class="tab-button" :class="{ active: activeTab === 'blocked' }" type="button" @click="activeTab = 'blocked'">
              阻断/需重拍 {{ readinessTotal('blocked') + readinessTotal('reviewedNotSettled') + readinessTotal('passportBlocked') + rephotoRows.length }}
            </button>
          </div>
          <div class="panel-body">
            <template v-if="activeTab === 'customers'">
              <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:8px;">
                <label class="muted" style="font-size:13px;">归类(团号模式)</label>
                <select v-model="filterMode">
                  <option value="">全部模式</option>
                  <option v-for="m in modeOptions" :key="m" :value="m">{{ m }}</option>
                </select>
                <span class="muted" style="font-size:12px;">这里只显示已结算客户;审核通过还没结算的,在审核台点「确认」后进来</span>
              </div>
              <table v-if="shownCustomers.length" class="table">
                <thead>
                  <tr>
                    <th>姓名</th>
                    <th>护照号</th>
                    <th>团号</th>
                    <th>团号模式</th>
                    <th>代理</th>
                    <th>购买日期</th>
                    <th>小票数</th>
                    <th>状态</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(c, i) in pagedCustomers" :key="(c.customerId || '') + '_' + i">
                    <td><strong>{{ c.name || c.customerId || '—' }}</strong></td>
                    <td>{{ c.passportNo || '—' }}</td>
                    <td>{{ c.tourNo || '—' }}</td>
                    <td>{{ c.mode }}</td>
                    <td>{{ c.agent || '—' }}</td>
                    <td>{{ c.purchaseDate || '—' }}</td>
                    <td>{{ c.receipts }}</td>
                    <td>
                      <span
                        class="status"
                        :style="c.status === 'rephoto' ? 'background:#fef3c7;color:#b45309;' : 'background:#f1f5f9;color:#475569;'"
                      >{{ c.statusLabel }}</span>
                    </td>
                  </tr>
                </tbody>
              </table>
              <div v-if="shownCustomers.length > pageSize || totalPages > 1" style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:10px; font-size:13px;">
                <span class="muted">共 {{ shownCustomers.length }} 客户,第 {{ page }}/{{ totalPages }} 页</span>
                <button class="ghost-button" type="button" :disabled="page <= 1" @click="goPage(page - 1)">‹ 上一页</button>
                <button class="ghost-button" type="button" :disabled="page >= totalPages" @click="goPage(page + 1)">下一页 ›</button>
                <label class="muted">每页
                  <select v-model.number="pageSize" style="min-width:64px;">
                    <option :value="25">25</option>
                    <option :value="50">50</option>
                    <option :value="100">100</option>
                    <option :value="200">200</option>
                  </select>
                </label>
              </div>
              <div v-if="!shownCustomers.length" class="empty">{{ overviewLoading ? '加载中…' : '该批次还没有已结算客户' }}</div>
            </template>

            <template v-else>
              <p class="muted" style="margin:0 0 8px; font-size:13px;">
                阻断=导出前预检发现的问题(缺字段/未审完),修完再导,绝不出残包。点「预检」刷新明细。
              </p>
              <div v-if="readiness" class="muted" style="font-size:12px; margin-bottom:8px;">
                最近预检:{{ planTitle({ name: readiness.planName, label: readiness.planName }) }}
                · 阻断 {{ readinessTotal('blocked') }} · 未审跳过 {{ readinessTotal('skipped') }}
                <span v-if="readinessTotal('reviewedNotSettled')"> · 已审核未结算 {{ readinessTotal('reviewedNotSettled') }}</span>
                <span v-if="readinessTotal('passportBlocked')"> · 缺护照拦结算 {{ readinessTotal('passportBlocked') }}</span>
                <span v-if="readiness.note"> · {{ readiness.note }}</span>
              </div>
              <!-- 明细清单截断了就说出来(2026-08-01):以前这一段显示的是**截断后**的数组长度,
                   于是计划卡写"阻断 350"、点开预检却说"阻断 200",而且下面只列 200 条,
                   谁也不知道剩下的去哪了 -->
              <p v-if="readinessTruncated.length" class="readiness-truncated">
                下面的明细只列出前 {{ readiness.listCap || 200 }} 条:{{ readinessTruncated.join('、') }}。
                计数是全量的,清单不是——要看全的请分批预检或按客户号在审核台查。
              </p>
              <div v-for="(item, i) in (readiness?.blocked || [])" :key="'b' + i" class="blocked-row">
                <div>
                  <strong style="color:#b42318;">{{ item.reason }}</strong>
                  <span class="muted" style="margin-left:8px;">{{ item.customerId || item.label }}</span>
                  <span v-if="item.zone" class="status" style="margin-left:6px;">{{ item.zone }}</span>
                </div>
                <button
                  class="ghost-button"
                  type="button"
                  :disabled="!item.customerId"
                  @click="locateInReview(item)"
                >
                  定位审核台
                </button>
              </div>
              <div v-for="(item, i) in (readiness?.skipped || [])" :key="'s' + i" class="blocked-row soft">
                <div>
                  <strong style="color:#b45309;">{{ item.reason }}</strong>
                  <span class="muted" style="margin-left:8px;">{{ item.customerId }}</span>
                </div>
                <button
                  class="ghost-button"
                  type="button"
                  :disabled="!item.customerId"
                  @click="locateInReview(item)"
                >
                  定位审核台
                </button>
              </div>
              <!-- 五问题#3/#4「有夹无行」:交付包会有客户夹,但客户数据表(台账)没有这组的行 -->
              <div v-for="(item, i) in (readiness?.reviewedNotSettled || [])" :key="'ns' + i" class="blocked-row">
                <div>
                  <strong style="color:#b42318;">已审核未结算(台账0行,包里有夹无行)</strong>
                  <span class="muted" style="margin-left:8px;">{{ item.customerId || item.label }}(小票{{ item.receipts }}张)· 去审核台点「确认」结算</span>
                </div>
                <button
                  class="ghost-button"
                  type="button"
                  :disabled="!item.customerId"
                  @click="locateInReview(item)"
                >
                  定位审核台
                </button>
              </div>
              <div v-for="(item, i) in (readiness?.passportBlocked || [])" :key="'pb' + i" class="blocked-row">
                <div>
                  <strong style="color:#b42318;">缺护照(结算闸拦死,不会有台账行)</strong>
                  <span class="muted" style="margin-left:8px;">{{ item.customerId || item.label }}· 补护照图后再结算</span>
                </div>
                <button
                  class="ghost-button"
                  type="button"
                  :disabled="!item.customerId"
                  @click="locateInReview(item)"
                >
                  定位审核台
                </button>
              </div>
              <div v-for="(c, i) in rephotoRows" :key="'r' + i" class="blocked-row soft">
                <div>
                  <strong style="color:#b45309;">需重拍·去回收</strong>
                  <span class="muted" style="margin-left:8px;">{{ c.name }}<template v-if="c.agent">(代理:{{ c.agent }})</template></span>
                </div>
                <span class="muted" style="font-size:12px;">{{ c.batchName || '' }}</span>
              </div>
              <div v-if="!readiness && !rephotoRows.length" class="empty">先在上方计划卡点「预检」</div>
            </template>
          </div>
        </div>
      </template>
    </section>
  </div>
</template>

<style scoped>
.library-layout {
  display: grid;
  grid-template-columns: 230px minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}
.batch-rail {
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 10px;
  position: sticky;
  top: 12px;
  max-height: calc(100vh - 90px);
  overflow-y: auto;
}
.rail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  margin-bottom: 8px;
}
.rail-group-label {
  font-size: 12px;
  color: #64748b;
  margin: 8px 2px 4px;
}
.rail-group-count { color: #98a2b3; }
.batch-row { display: flex; align-items: center; gap: 6px; }
.batch-row .batch-pick { flex: none; }
.batch-row.picked .batch-item { border-color: #2563eb; }
.batch-row .batch-item { flex: 1; min-width: 0; }
.rail-foot { position: sticky; bottom: 0; background: #fff; border-top: 1px solid var(--line); padding: 8px 6px; display: grid; gap: 6px; }
/* 批次行(image61 左栏):平列表+细分隔线,选中=浅蓝底+左侧蓝条;去盒卡去粗体 */
.batch-item {
  display: block;
  width: 100%;
  text-align: left;
  background: transparent;
  border: none;
  border-left: 3px solid transparent;
  border-radius: 0;
  padding: 7px 8px 7px 6px;
  cursor: pointer;
}
.batch-row { border-bottom: 1px solid #eef2f6; }
.batch-item:hover { background: #f8fafc; }
.batch-item.active { border-left-color: #2563eb; background: #eff6ff; }
.batch-item-name {
  display: block;
  font-weight: 500;
  font-size: 13px;
  color: #0f172a;
  word-break: break-all;
}
.batch-item-meta {
  display: block;
  font-size: 12px;
  color: #64748b;
  margin-top: 2px;
}
/* 汇总条(image61):一行内联大数字;需重拍>0 琥珀、阻断>0 红 */
.summary-strip {
  display: flex;
  align-items: baseline;
  gap: 22px;
  flex-wrap: wrap;
  padding: 2px 2px 6px;
}
.ss-item { font-size: 13px; color: #475569; }
.ss-item b { font-size: 20px; font-weight: 500; color: #0f172a; margin-left: 4px; font-variant-numeric: tabular-nums; }
.ss-item b.amber { color: #b45309; }
.ss-item b.red { color: #b42318; }
.ss-link { background: none; border: none; padding: 0; cursor: pointer; }
.ss-link:hover { text-decoration: underline; }
/* 收票汇总.xlsx 置顶卡(image61) */
.ledger-export-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 12px 14px;
  margin-top: 8px;
}
.lec-title { font-size: 14px; font-weight: 500; color: #0f172a; }
.lec-sub { font-size: 12px; margin-top: 2px; }
.lec-actions { display: flex; align-items: center; gap: 8px; flex: none; }
/* 计划行(image61:紧凑行式,细分隔线,不再大卡堆叠) */
.plan-card {
  border: none;
  border-bottom: 1px solid #eef2f6;
  border-radius: 0;
  padding: 9px 2px;
  margin-bottom: 0;
}
.plan-card:last-child { border-bottom: none; }
.plan-card.inapplicable { opacity: 0.55; }
.plan-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.plan-card-head strong { font-weight: 500; font-size: 13px; }
.plan-card-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.plan-card-stats { font-size: 12px; margin-top: 2px; display: flex; gap: 6px; flex-wrap: wrap; }
.plan-rules {
  margin-top: 8px;
  padding: 8px 10px;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  font-size: 12px;
}
.plan-rule-row { margin-bottom: 6px; }
/* 按客户导出清单(image27 参考图):行式两列,细分隔线,计数右对齐;唯一按钮在表头右侧 */
.zone-block { margin-top: 10px; }
.zone-list-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.zone-list-title { font-size: 13px; }
.zone-list-actions { display: flex; align-items: center; gap: 10px; }
.muted-inline { font-style: normal; color: #98a2b3; font-size: 12px; }
.zone-list {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  column-gap: 28px;
  margin-top: 4px;
}
.zone-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 2px;
  border-bottom: 1px solid #eef2f6;
  cursor: pointer;
}
.zone-row.unpickable { cursor: default; }
.zone-row.picked { background: #f6f9ff; }
/* 需求F①:不加粗——一列模式里没有哪个该被突出,加粗只是让整列都在喊 */
.zone-name { font-size: 13px; font-weight: 400; word-break: break-all; }
.zone-layout { font-style: normal; color: #98a2b3; font-size: 12px; }
.zone-count { margin-left: auto; font-size: 13px; color: #475569; font-variant-numeric: tabular-nums; }
.zone-hint { font-size: 12px; }
.tab-button {
  border: none;
  background: transparent;
  padding: 6px 12px;
  font-size: 13px;
  color: #64748b;
  cursor: pointer;
  border-bottom: 2px solid transparent;
}
.tab-button.active { color: #0f172a; font-weight: 500; border-bottom-color: #334155; }
.blocked-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid #fecaca;
  border-radius: 8px;
  margin-bottom: 6px;
  background: #fff;
}
.blocked-row.soft { border-color: #fde68a; }
.export-progress-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 8px;
  padding: 10px 14px;
  background: #eff6ff;
  border: 1px solid #93c5fd;
  border-radius: 8px;
  color: #1e40af;
  font-weight: 500;
  font-size: 14px;
}
.export-progress-banner .spinner {
  width: 16px;
  height: 16px;
  border: 2px solid #bfdbfe;
  border-top-color: #2563eb;
  border-radius: 50%;
  animation: lib-export-spin 0.7s linear infinite;
  flex-shrink: 0;
}
/* 格式预检(0727#15):疑似审核失误前置面板;通过态一行绿字不占地 */
.precheck-panel { margin-top: 12px; border-color: #fca5a5; background: #fff7f6; }
.precheck-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.precheck-list li { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 13px; padding: 4px 0; border-bottom: 1px dashed #fecaca; }
.precheck-list li:last-child { border-bottom: none; }
.pc-cust { font-weight: 500; white-space: nowrap; }
.pc-mode { font-size: 12px; white-space: nowrap; }
.pc-problems { flex: 1; min-width: 200px; color: #b42318; }
.precheck-list .ghost-button { flex: none; }
.precheck-ok { margin: 10px 0 0; font-size: 13px; color: #475569; }
/* 「没跑成」既不是绿字也不是红面板:琥珀=待人处理,与全站状态色一致(问题存在≠数据有错) */
.readiness-truncated { margin: 0 0 8px; font-size: 12px; color: #92400e; }
.precheck-failed {
  margin: 10px 0 0; padding: 8px 12px; font-size: 13px; color: #92400e;
  background: #fffbeb; border: 1px solid #fde68a; border-radius: 6px;
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
}
.precheck-failed .muted { color: #a16207; }

@keyframes lib-export-spin {
  to { transform: rotate(360deg); }
}
@media (max-width: 900px) {
  .library-layout { grid-template-columns: 1fr; }
  .zone-list { grid-template-columns: 1fr; }
  .batch-rail { position: static; max-height: none; }
}
</style>
