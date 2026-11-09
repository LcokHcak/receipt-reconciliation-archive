<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { RefreshCw, SearchCheck } from 'lucide-vue-next'

import AppLayout from '@/layouts/AppLayout.vue'
import Button from '@/components/ui/button.vue'
import StatusBadge from '@/components/ui/status-badge.vue'
import TabularNumber from '@/components/ui/tabular-number.vue'
import DataTable from '@/components/v2/DataTable.vue'
import BillConflictRow from '@/components/v2/BillConflictRow.vue'
import CountMismatchRow from '@/components/v2/CountMismatchRow.vue'
import { batchRejectPendingReviews, fetchPendingReviews, resolvePendingReview } from '@/api/v2/pendingReviews'
import { resolveConflict as resolvePendingReviewDecision } from '@/api/v2/conflicts'
import {
  fetchBillReviewConflicts,
  fetchCountMismatch,
  rerunBillMatchRow,
  resolveBillReviewConflict,
} from '@/api/v2/billReview'

const route = useRoute()
const router = useRouter()
const workspaceKey = computed(() => String(route.params.workspaceKey || ''))
const isDemo = computed(() => workspaceKey.value.startsWith('demo-'))

const PAGE_SIZE = 50
const activeTab = ref('field_conflict')
const loading = ref(false)
const actionLoading = ref('')
const errorMsg = ref('')
const successMsg = ref('')
// 本次浏览里隐去了几行。摆在明面上,否则列表数字凭空变小、下次进来又变回去 ——
// 「数字自己会动」最让人不信任这一页,而这里恰恰是交付前对账的地方。
const hiddenThisSession = ref(0)
const conflictValueMap = ref({})
const selectedCandidateByReviewId = reactive({})

// 2026-06-12:原「数量不一致」按差异方向拆成两个客户级 tab——
// 未收小票(unreceived_customers=账单多)/小票无账单(daily_without_bill=台账多),
// 数据同源 count-mismatch+direction 参数,行级 daily-without-bill 列表退役。
const pageState = reactive({
  field_conflict: { rows: [], total: 0, offset: 0 },
  // total=客户数(分页用);receiptTotal=未收小票总张数(徽标按张展示,与未收清单页 13594 对齐)
  unreceived_customers: { rows: [], total: 0, offset: 0, receiptTotal: 0 },
  daily_without_bill: { rows: [], total: 0, offset: 0 },
  ambiguous_match: { rows: [], total: 0, offset: 0 },
  fuzzy_match: { rows: [], total: 0, offset: 0 },
})

const TAB_HELP = {
  field_conflict: {
    title: '字段冲突',
    body: '系统已经找到同一张小票/同一位客人的匹配关系，但台账字段和账单字段不一致。',
    action: '审核员需要逐字段选择：保留台账、采用账单，或手动填正确值。',
  },
  ambiguous_match: {
    title: '多个候选',
    body: '系统找到多个可能的台账候选，无法自动判断该账单应该挂到哪一条。',
    action: '需要人工比对姓名、护照、小票号、购买日后接受或拒绝。',
  },
  fuzzy_match: {
    title: '模糊匹配',
    body: '不是精确小票号命中，而是通过小票前缀、姓名、日期等相近信号找到疑似候选。',
    action: '不要直接当作已匹配；请打开候选信息核对，确定是同一张/同一人再接受。',
  },
  unreceived_customers: {
    title: '未收小票(按客户)',
    body: '账单里有这张小票、客户还没把实物小票交上来(账单有、台账无)。按客户聚合展示,红条里是该客户所有未收小票号。',
    action: '去「未收清单」页处理:继续追小票,或确认收不到时「补录入台账」(从账单复制真实数据)。',
  },
  daily_without_bill: {
    title: '小票无账单(按客户)',
    body: '你们收到并审核过这张小票,但当前账单桶里没有对应账单行(台账有、账单无)。方向与「未收」正好相反。',
    action: '通常需要检查是否漏导账单、选错桶、账单文件缺行。确认账单确实没有时,这张小票不参与本月返点。',
  },
}

const tabs = computed(() => [
  { key: 'field_conflict', label: '字段冲突', count: pageState.field_conflict.total },
  { key: 'unreceived_customers', label: '未收小票', count: pageState.unreceived_customers.receiptTotal },
  { key: 'daily_without_bill', label: '小票无账单', count: pageState.daily_without_bill.total },
  { key: 'ambiguous_match', label: '多候选', count: pageState.ambiguous_match.total },
  { key: 'fuzzy_match', label: '模糊匹配', count: pageState.fuzzy_match.total },
])

// 客户级差异 tab(原数量不一致拆分) ↔ 后端 direction 参数 ↔ 卡片显示方向
const CUSTOMER_DIFF_TABS = Object.freeze({
  unreceived_customers: 'unreceived',
  daily_without_bill: 'daily_without_bill',
})

const activeHelp = computed(() => TAB_HELP[activeTab.value] || TAB_HELP.field_conflict)
const currentPage = computed(() => pageState[activeTab.value] || pageState.field_conflict)
const fieldRows = computed(() => pageState.field_conflict.rows)
const customerDiffRows = computed(() => (pageState[activeTab.value] || {}).rows || [])
const reviewRows = computed(() => {
  if (activeTab.value === 'ambiguous_match') return pageState.ambiguous_match.rows
  if (activeTab.value === 'fuzzy_match') return pageState.fuzzy_match.rows
  return []
})
const pageLabel = computed(() => {
  const page = currentPage.value
  if (!page.total) return '0 / 0'
  const start = page.offset + 1
  const end = Math.min(page.offset + page.rows.length, page.total)
  return `${start}-${end} / ${page.total}`
})
const pageCountLabel = computed(() => {
  const page = currentPage.value
  return `${Math.floor(page.offset / PAGE_SIZE) + 1} / ${Math.max(1, Math.ceil(page.total / PAGE_SIZE))}`
})

// 可回溯列:运营要能从行直接看出是哪个客户哪张票(姓名/护照/小票/购买日),
// 不能只给内部 #id(无法对回自己录入的信息)。
const reviewColumns = [
  { key: 'reasonType', label: '类型', width: '110px', format: reasonLabel },
  { key: 'name', label: '姓名', width: '120px', format: (row) => row.name || '—' },
  { key: 'passportNo', label: '护照号', width: '120px', format: (row) => row.passportNo || '—' },
  { key: 'receiptNo', label: '小票号', width: '150px', format: (row) => row.receiptNo || '—' },
  { key: 'purchaseDate', label: '购买日', width: '100px', format: (row) => row.purchaseDate || '—' },
  { key: 'candidates', label: '候选/说明' },
  { key: 'actions', label: '操作', align: 'right', width: '220px' },
]

function reasonLabel(row) {
  const type = typeof row === 'string' ? row : row.reasonType
  return {
    ambiguous_match: '多个候选',
    fuzzy_match: '模糊匹配',
    daily_without_bill: '小票无账单',
  }[type] || type || '-'
}

function normalizePending(row) {
  const detail = row.detail || {}
  const candidateIds = Array.isArray(detail.candidateIds) ? detail.candidateIds : []
  const candidateText = candidateIds.length
    ? `候选台账 ${candidateIds.map((id) => `#${id}`).join(', ')}`
    : detail.receiptNo || detail.receipt_no || detail.hint || '-'
  return {
    ...row,
    reasonType: row.reasonType || row.reason_type,
    sourceId: row.sourceId ?? row.source_id,
    // 可回溯字段:pending_review 顶层列与 detail 快照里都有可能携带
    name: row.name || detail.name || detail.customerName || '',
    passportNo: row.passportNo || row.passport_no || detail.passportNo || detail.passport_no || '',
    receiptNo: row.receiptNo || row.receipt_no || detail.receiptNo || detail.receipt_no || '',
    purchaseDate: row.purchaseDate || row.purchase_date || detail.purchaseDate || detail.purchase_date || '',
    candidateIds,
    candidates: candidateText,
  }
}

function conflictsFor(row) {
  return conflictValueMap.value[Number(row.id)] || []
}

function clearMessages() {
  errorMsg.value = ''
  successMsg.value = ''
}

function resetPages() {
  for (const page of Object.values(pageState)) {
    page.rows = []
    page.total = 0
    page.offset = 0
  }
  conflictValueMap.value = {}
}

function applyPendingReasonCounts(payload) {
  const byReason = Array.isArray(payload?.byReason) ? payload.byReason : []
  const counts = new Map(byReason.map((row) => [row.reason || row.reasonType, Number(row.n || row.count || 0)]))
  pageState.ambiguous_match.total = counts.get('ambiguous_match') || 0
  pageState.fuzzy_match.total = counts.get('fuzzy_match') || 0
}

async function loadSummaries() {
  const [conflicts, pending, unreceivedCustomers, dailyWithoutBill] = await Promise.all([
    fetchBillReviewConflicts(workspaceKey.value, { limit: 1, offset: 0 }),
    fetchPendingReviews(workspaceKey.value, { status: 'open', limit: 1, offset: 0 }),
    fetchCountMismatch(workspaceKey.value, { limit: 1, offset: 0, direction: 'unreceived' }),
    fetchCountMismatch(workspaceKey.value, { limit: 1, offset: 0, direction: 'daily_without_bill' }),
  ])
  pageState.field_conflict.total = Number(conflicts?.total || 0)
  applyPendingReasonCounts(pending)
  pageState.unreceived_customers.total = Number(unreceivedCustomers?.total || 0)
  pageState.unreceived_customers.receiptTotal = Number(unreceivedCustomers?.receiptTotal || 0)
  pageState.daily_without_bill.total = Number(dailyWithoutBill?.total || 0)
}

async function loadTab(tab = activeTab.value, { useGlobalLoading = true } = {}) {
  if (!workspaceKey.value) return
  if (useGlobalLoading) loading.value = true
  errorMsg.value = ''
  try {
    const page = pageState[tab] || pageState.field_conflict
    if (tab === 'field_conflict') {
      const [conflicts, pending] = await Promise.all([
        fetchBillReviewConflicts(workspaceKey.value, { limit: PAGE_SIZE, offset: page.offset }),
        fetchPendingReviews(workspaceKey.value, {
          status: 'open',
          reasonType: 'field_conflict',
          limit: PAGE_SIZE,
          offset: page.offset,
        }),
      ])
      page.rows = conflicts?.rows || []
      page.total = Number(conflicts?.total || 0)
      applyPendingReasonCounts(pending)
      const map = {}
      for (const row of pending?.rows || []) {
        const detail = row.detail || {}
        const dailyId = Number(detail.dailyReceiptId)
        if (dailyId) map[dailyId] = detail.conflicts || []
      }
      conflictValueMap.value = map
    } else if (CUSTOMER_DIFF_TABS[tab]) {
      const payload = await fetchCountMismatch(workspaceKey.value, {
        limit: PAGE_SIZE,
        offset: page.offset,
        direction: CUSTOMER_DIFF_TABS[tab],
      })
      page.rows = payload?.rows || []
      page.total = Number(payload?.total || 0)
      if (payload?.receiptTotal != null) page.receiptTotal = Number(payload.receiptTotal)
    } else if (tab === 'ambiguous_match' || tab === 'fuzzy_match') {
      const payload = await fetchPendingReviews(workspaceKey.value, {
        status: 'open',
        reasonType: tab,
        limit: PAGE_SIZE,
        offset: page.offset,
      })
      page.rows = (payload?.rows || []).map(normalizePending)
      page.total = Number(payload?.total || 0)
      for (const row of page.rows) {
        if (row.candidateIds?.length && !selectedCandidateByReviewId[row.id]) {
          selectedCandidateByReviewId[row.id] = String(row.candidateIds[0])
        }
      }
      applyPendingReasonCounts(payload)
    }
  } catch (error) {
    errorMsg.value = error?.response?.data?.error || error?.message || '账单核对加载失败'
    const page = pageState[tab] || pageState.field_conflict
    page.rows = []
  } finally {
    if (useGlobalLoading) loading.value = false
  }
}

async function load({ reset = false } = {}) {
  if (!workspaceKey.value) return
  if (reset) resetPages()
  loading.value = true
  clearMessages()
  try {
    await loadSummaries()
    await loadTab(activeTab.value, { useGlobalLoading: false })
  } catch (error) {
    errorMsg.value = error?.response?.data?.error || error?.message || '账单核对加载失败'
  } finally {
    loading.value = false
  }
}

async function setActiveTab(tab) {
  if (activeTab.value === tab) {
    await loadTab(tab)
    return
  }
  activeTab.value = tab
}

async function goPage(direction) {
  const page = currentPage.value
  const nextOffset = Math.max(0, page.offset + direction * PAGE_SIZE)
  if (nextOffset === page.offset || nextOffset >= Math.max(page.total, 1)) return
  page.offset = nextOffset
  await loadTab(activeTab.value)
}

function keyFieldChanged(updates) {
  return ['receiptNo', 'passportNo', 'tourNo'].some((field) => Object.prototype.hasOwnProperty.call(updates, field))
}

async function resolveConflict({ dailyId, updates }, { rerun = false } = {}) {
  actionLoading.value = `field:${dailyId}`
  errorMsg.value = ''
  try {
    await resolveBillReviewConflict(workspaceKey.value, { dailyId, updates })
    if ((rerun || keyFieldChanged(updates)) && window.confirm('关键字段已修改，是否立刻重跑这一行账单匹配？')) {
      await rerunBillMatchRow(workspaceKey.value, dailyId)
    }
    successMsg.value = `已处理 daily #${dailyId}`
    await load()
  } catch (error) {
    errorMsg.value = error?.response?.data?.error || error?.message || '字段冲突处理失败'
  } finally {
    actionLoading.value = ''
  }
}

async function rerunRow(dailyId) {
  actionLoading.value = `field:${dailyId}`
  errorMsg.value = ''
  try {
    await rerunBillMatchRow(workspaceKey.value, Number(dailyId))
    successMsg.value = `已重跑 daily #${dailyId}`
    await load()
  } catch (error) {
    errorMsg.value = error?.response?.data?.error || error?.message || '重新匹配失败'
  } finally {
    actionLoading.value = ''
  }
}

function trackFolder(row) {
  const folder = row.modeFolder || row.mode_folder || null
  router.push({
    path: `/monthly/v2/${encodeURIComponent(workspaceKey.value)}/ledger`,
    query: {
      ...(folder ? { folder } : {}),
      ...(row.passportNo ? { passport: row.passportNo } : {}),
    },
  })
}

// 未收方向跳「未收清单」页处理该客户(带护照号预填搜索)
function gotoUnreceived(row) {
  router.push({
    name: 'v2-monthly-unreceived',
    params: { workspaceKey: workspaceKey.value },
    query: row.passportNo ? { q: row.passportNo } : {},
  })
}

// ⚠️ 这个动作**只在本次浏览里生效**,没有任何落库。
//
// 2026-08-01 修的是文案,不是行为:原来它从本地数组 filter 掉一行、total 减 1,
// 然后提示「已标记客户 X 的差异为已核对」—— 审核员逐个点到 0,以为这批核完了;
// 实际数据库零变化,刷新或切一次页签就全部原样回来,他做过的判断一点痕迹都没留下。
//
// 为什么不顺手把它做成真落库:「数量不一致」是从台账 ⟂ 账单**实时算出来的派生结果**,
// 端点只有 GET。要让"已核对"留下来,得新加一层人工标记 —— 而未收侧已经有
// unreceived_resolution(link/delay/void)+ unreceived_state 两张表,
// 0026 迁移的抬头明确写着:「『无需补』人工豁免不在此表 —— P3 决策它与
// unreceived_resolution 怎么合流,**避免两套人工标记裂脑**」。
// 也就是说"再加一套标记"这件事,代码里已经挂着一个待拍板的决策。
// 在那之前擅自发明第二套,正是它警告的那个坑。
//
// 所以现在:动作保留(长列表里逐条处理时,隐去已看过的行确实有用),
// 但把它说成它本来的样子。
function confirmCountMismatch(row) {
  const page = pageState[activeTab.value]
  if (page) {
    page.rows = page.rows.filter((r) => r !== row)
    page.total = Math.max(0, page.total - 1)
    hiddenThisSession.value += 1
  }
  successMsg.value = `已从本次列表隐去客户 ${row.name || row.passportNo}`
    + '（仅本次浏览;刷新或切页签会回来。系统目前不保存「已核对」状态)'
}

function addBillFromMismatch(row) {
  successMsg.value = `账单多出 ${row.missingInDaily.length} 张小票，已转到未收清单继续处理`
  router.push({
    path: `/monthly/v2/${encodeURIComponent(workspaceKey.value)}/unreceived`,
    query: row.passportNo ? { passport: row.passportNo } : {},
  })
}

async function rerunCountMismatch() {
  await loadTab(activeTab.value)
  successMsg.value = '已重新核对'
}

async function resolveReview(row, resolution) {
  actionLoading.value = `review:${row.id}`
  errorMsg.value = ''
  try {
    const reasonType = row.reasonType || row.reason_type
    const shouldApplyCandidate = resolution === 'accepted'
      && ['ambiguous_match', 'fuzzy_match'].includes(reasonType)
    let result
    if (shouldApplyCandidate) {
      const chosenDailyId = Number(selectedCandidateByReviewId[row.id] || row.candidateIds?.[0])
      if (!Number.isFinite(chosenDailyId) || chosenDailyId <= 0) {
        errorMsg.value = '请先选择一个候选台账，再接受匹配'
        return
      }
      result = await resolvePendingReviewDecision({
        workspaceKey: workspaceKey.value,
        id: row.id,
        status: 'resolved',
        resolution,
        decision: { chosenDailyId },
      })
    } else {
      result = await resolvePendingReview(workspaceKey.value, row.id, { status: 'resolved', resolution })
    }
    // 复核HIGH-2(2026-07-16):200 但 ok:false=没真正落库(item 仍 open),别报"已处理"误导
    if (result && result.ok === false) {
      const why = Array.isArray(result.warnings) && result.warnings.length ? result.warnings.join('、') : '数据已变化'
      errorMsg.value = `#${row.id} 没有真正处理成功(${why}),仍在待处理里,刷新后重试`
    } else {
      successMsg.value = `已处理 #${row.id}`
    }
    await load()
  } catch (error) {
    errorMsg.value = error?.response?.data?.error || error?.message || '待核对处理失败'
  } finally {
    actionLoading.value = ''
  }
}

// 批量否决本页(fuzzy/ambiguous 历史噪声):rejected 只翻状态不动业务数据,
// 整页清比逐条点快;误否决可重跑账单匹配再生成。
async function batchRejectPage() {
  const rows = reviewRows.value
  if (!rows.length || actionLoading.value) return
  if (!window.confirm(`否决本页全部 ${rows.length} 条「${reasonLabel(activeTab.value)}」待审？\n只翻状态不动台账/账单;之后重跑账单匹配可重新生成。`)) return
  actionLoading.value = 'batch-reject'
  errorMsg.value = ''
  try {
    const result = await batchRejectPendingReviews(workspaceKey.value, {
      ids: rows.map((row) => Number(row.id)),
      resolution: `batch_rejected:${activeTab.value}`,
    })
    successMsg.value = `已批量否决 ${result?.rejected ?? 0} 条${result?.skipped?.length ? `,跳过 ${result.skipped.length} 条(已处理)` : ''}`
    await load()
  } catch (error) {
    errorMsg.value = error?.response?.data?.error || error?.message || '批量否决失败'
  } finally {
    actionLoading.value = ''
  }
}

onMounted(() => load({ reset: true }))
watch(workspaceKey, () => load({ reset: true }))
watch(activeTab, () => loadTab(activeTab.value))
</script>

<template>
  <AppLayout :workspace-key="workspaceKey">
    <div class="min-w-0 space-y-5 overflow-x-hidden">
      <header class="flex flex-wrap items-start gap-3 px-1">
        <SearchCheck class="mt-1 h-6 w-6 text-primary" />
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <h1 class="text-xl font-medium text-foreground">账单核对</h1>
            <StatusBadge v-if="isDemo" variant="test" size="sm">测试模式</StatusBadge>
          </div>
          <p class="text-sm text-muted-foreground">字段冲突、未收小票、小票无账单、多候选、模糊匹配统一在这里处理；当前页按服务器分页加载。</p>
        </div>
        <Button variant="ghost" size="sm" :disabled="loading" @click="load">
          <RefreshCw class="h-4 w-4" /> 刷新
        </Button>
      </header>

      <div v-if="errorMsg" class="rounded-lg border border-status-error/30 bg-status-error/10 px-4 py-2 text-sm text-status-error">{{ errorMsg }}</div>
      <div v-else-if="successMsg" class="rounded-lg border border-status-ok/30 bg-status-ok/10 px-4 py-2 text-sm text-status-ok">{{ successMsg }}</div>

      <!-- 「本次隐去」是纯前端过滤,不落库。列表数字因此会变小,而刷新又变回去 ——
           不说明的话,这一页(交付前对账)的数字看起来就是会自己动的。 -->
      <div
        v-if="hiddenThisSession > 0"
        class="rounded-lg border border-status-warn/30 bg-status-warn/10 px-4 py-2 text-sm text-status-warn"
      >
        本次已隐去 {{ hiddenThisSession }} 行 —— 这只是当前浏览的过滤,<strong>没有保存</strong>。
        刷新或切换页签后它们会回来;系统目前不记录「已核对」状态。
      </div>

      <section class="rounded-lg border border-border bg-card p-3 shadow-sm">
        <div class="flex flex-wrap gap-2">
          <button
            v-for="tab in tabs"
            :key="tab.key"
            type="button"
            :class="[
              'rounded-md border px-3 py-2 text-sm transition',
              activeTab === tab.key ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-muted/50',
            ]"
            @click="setActiveTab(tab.key)"
          >
            {{ tab.label }} <TabularNumber :value="tab.count" class="ml-1" />
          </button>
        </div>
        <div class="mt-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground">
          <span class="font-medium text-foreground">{{ activeHelp.title }}</span>
          <span class="ml-2">{{ activeHelp.body }}</span>
          <span class="ml-2 text-foreground">{{ activeHelp.action }}</span>
        </div>
      </section>

      <div class="flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-muted-foreground">
        <span>当前页 {{ pageLabel }} · 页码 {{ pageCountLabel }}</span>
        <div class="flex gap-2">
          <Button
            v-if="['ambiguous_match', 'fuzzy_match'].includes(activeTab)"
            variant="outline"
            size="sm"
            :disabled="loading || !!actionLoading || !reviewRows.length"
            data-testid="batch-reject-page"
            @click="batchRejectPage"
          >
            {{ actionLoading === 'batch-reject' ? '否决中…' : '否决本页全部' }}
          </Button>
          <Button variant="outline" size="sm" :disabled="loading || currentPage.offset === 0" @click="goPage(-1)">上一页</Button>
          <Button variant="outline" size="sm" :disabled="loading || currentPage.offset + PAGE_SIZE >= currentPage.total" @click="goPage(1)">下一页</Button>
        </div>
      </div>

      <div v-if="activeTab === 'field_conflict'" class="space-y-3">
        <div v-if="loading" class="rounded-lg border border-border bg-card p-10 text-center text-sm text-muted-foreground">加载中...</div>
        <div v-else-if="!fieldRows.length" class="rounded-lg border border-border bg-card p-10 text-center text-sm text-muted-foreground">暂无字段冲突</div>
        <BillConflictRow
          v-for="row in fieldRows"
          :key="row.id"
          :row="row"
          :conflicts="conflictsFor(row)"
          :busy="actionLoading === `field:${row.id}`"
          @confirm="resolveConflict($event)"
          @use-daily="resolveConflict($event)"
          @use-bill="resolveConflict($event)"
          @rerun="rerunRow"
          @track-folder="trackFolder"
        />
      </div>

      <div v-else-if="CUSTOMER_DIFF_TABS[activeTab]" class="space-y-3">
        <div v-if="loading" class="rounded-lg border border-border bg-card p-10 text-center text-sm text-muted-foreground">加载中...</div>
        <div v-else-if="!customerDiffRows.length" class="rounded-lg border border-border bg-card p-10 text-center text-sm text-muted-foreground">
          {{ activeTab === 'unreceived_customers' ? '暂无未收小票' : '暂无小票无账单' }}
        </div>
        <CountMismatchRow
          v-for="(row, idx) in customerDiffRows"
          :key="`${row.passportNo}-${row.name}-${currentPage.offset + idx}`"
          :row="row"
          :direction="CUSTOMER_DIFF_TABS[activeTab]"
          :busy="loading"
          @confirm="confirmCountMismatch"
          @add-bill="addBillFromMismatch"
          @rerun="rerunCountMismatch"
          @track-folder="trackFolder"
          @goto-unreceived="gotoUnreceived"
        />
      </div>

      <DataTable
        v-else
        :columns="reviewColumns"
        :rows="reviewRows"
        :loading="loading"
        :total="currentPage.total"
        :limit="PAGE_SIZE"
        :offset="currentPage.offset"
        empty-text="当前分类暂无待核对项"
        @prev="goPage(-1)"
        @next="goPage(1)"
      >
        <template #cell-actions="{ row }">
          <div class="flex justify-end gap-2">
            <select
              v-if="row.candidateIds?.length"
              v-model="selectedCandidateByReviewId[row.id]"
              class="h-8 max-w-[120px] rounded-md border border-input bg-background px-2 text-xs"
              :disabled="actionLoading === `review:${row.id}`"
              title="选择确认匹配到哪一条台账"
            >
              <option v-for="id in row.candidateIds" :key="id" :value="String(id)">台账 #{{ id }}</option>
            </select>
            <Button size="sm" variant="outline" :disabled="actionLoading === `review:${row.id}`" @click="resolveReview(row, 'accepted')">接受</Button>
            <Button size="sm" variant="ghost" :disabled="actionLoading === `review:${row.id}`" @click="resolveReview(row, 'rejected')">拒绝</Button>
          </div>
        </template>
      </DataTable>
    </div>
  </AppLayout>
</template>
