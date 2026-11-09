<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import AppLayout from '@/layouts/AppLayout.vue'
import Button from '@/components/ui/button.vue'
import StatusBadge from '@/components/ui/status-badge.vue'
import TabularNumber from '@/components/ui/tabular-number.vue'
import { backfillUnreceived, fetchUnreceivedList, resolveUnreceived } from '@/api/v2/billReview'
import { getUnreceived } from '@/mocks/v2'
import ResolutionDialog from '@/components/v2/ResolutionDialog.vue'
import RowHistoryDrawer from '@/components/v2/RowHistoryDrawer.vue'
import UnreceivedFilters from '@/components/v2/UnreceivedFilters.vue'
import UnreceivedTable from '@/components/v2/UnreceivedTable.vue'
import { allowV2MockFallback, v2MockFallbackLabel, v2MockFallbackVariant } from '@/lib/v2/mock_fallback'

const route = useRoute()
const workspaceKey = computed(() => String(route.params.workspaceKey || 'demo-2026-05'))
const isDemo = computed(() => workspaceKey.value.startsWith('demo-'))
const PAGE_SIZE = 50
const BUCKETS = ['乐天首尔', '乐天釜山', '爱宝客', '济州新罗V团']

// 单一口径 (2026-06-03 统一) = 账单有、台账无 (以账单为基准,客户该补交的票;
// 与导出文件 / merge 未收小票账单同源)。台账有账单无归「小票无账单」,不在此页。
const unreceivedRows = ref([])
const totalRows = ref(0)
const pageOffset = ref(0)
const availableModes = ref([])
const availableFolders = ref(BUCKETS.map((folder) => ({ folder, count: 0 })))
const selectedIds = ref(new Set())
const expandedIds = ref(new Set())
const loading = ref(false)
const apiFailed = ref(false)
const apiError = ref('')
// SMG总账替换窗口:后端 buildView 返回 importing=true 时数据可能不全(清旧→流式插新的分钟级窗口)
const importing = ref(false)
const resolving = ref(false)
const resolveError = ref('')
const successMessage = ref('')
const dialog = reactive({ open: false, action: '', ids: [] })
const filters = reactive({
  folder: initialFolderFilter(),
  mode: 'all',
  priority: 'all',
  dateFrom: '',
  dateTo: '',
  // 从账单核对「去未收清单」跳来时,?q=护照号 预填搜索,直接定位该客户
  search: String(route.query.q || '').trim(),
})
let filterTimer = null

const modes = computed(() => availableModes.value)
const folders = computed(() => {
  const countByFolder = new Map((availableFolders.value || []).map((item) => [item.folder, item.count || 0]))
  return BUCKETS.map((folder) => ({ folder, count: countByFolder.get(folder) || 0 }))
})
const filteredRows = computed(() => unreceivedRows.value)
const pageLabel = computed(() => {
  if (!totalRows.value) return '0 / 0'
  const start = pageOffset.value + 1
  const end = Math.min(pageOffset.value + filteredRows.value.length, totalRows.value)
  return `${start}-${end} / ${totalRows.value}`
})
const pageCountLabel = computed(() => `${Math.floor(pageOffset.value / PAGE_SIZE) + 1} / ${Math.max(1, Math.ceil(totalRows.value / PAGE_SIZE))}`)

// 行级未收 (账单有台账无) — 兼容后端 snake_case 与 mock camelCase。无候选/优先级。
function normalizeUnreceived(item, index) {
  const receiptNo = item.receiptNo || item.receipt_no || item.billNo || item.bill_no || `U-${index}`
  const passportNo = item.passportNo || item.passport_no || ''
  return {
    id: `${passportNo}-${receiptNo}-${index}`,
    billNo: receiptNo,
    mode: item.modeRaw || item.mode_raw || item.modeFolder || item.mode_folder || item.mode || '',
    amount: item.netUsd ?? item.net_usd ?? 0,
    currency: 'USD',
    folder: item.modeFolder || item.mode_folder || item.folder || '',
    priority: null,
    date: item.purchaseDate || item.purchase_date || item.date || '',
    passportNo,
    customerName: item.name || item.customerName || item.customer_name || item.fullName || item.full_name || '',
    tourNo: item.tourNo || item.tour_no || '',
    agent: item.agent || '',
    candidates: [],
  }
}

async function loadUnreceived() {
  loading.value = true
  apiFailed.value = false
  apiError.value = ''
  resolveError.value = ''  // 重新加载时清掉上一次核销操作的错误条,避免误导
  try {
    const params = {
      limit: PAGE_SIZE,
      offset: pageOffset.value,
    }
    if (filters.folder !== 'all') params.folder = filters.folder
    if (filters.mode !== 'all') params.mode = filters.mode
    if (filters.dateFrom) params.dateFrom = filters.dateFrom
    if (filters.dateTo) params.dateTo = filters.dateTo
    if (filters.search.trim()) params.search = filters.search.trim()
    const payload = await fetchUnreceivedList(workspaceKey.value, params)
    unreceivedRows.value = (payload.rows || payload.items || []).map(normalizeUnreceived)
    totalRows.value = Number(payload.total || unreceivedRows.value.length || 0)
    availableModes.value = Array.isArray(payload.modes) ? payload.modes : []
    availableFolders.value = Array.isArray(payload.folders) ? payload.folders : availableFolders.value
    importing.value = Boolean(payload.importing)
  } catch (error) {
    console.warn('unreceived api failed', error)
    importing.value = false
    apiError.value = error?.response?.data?.message || error?.response?.data?.error || error?.message || '未收清单接口加载失败'
    if (allowV2MockFallback) {
      const fallback = getUnreceived(workspaceKey.value)
      unreceivedRows.value = (fallback.knownMissing || fallback.missingReceipts || []).map(normalizeUnreceived)
      totalRows.value = unreceivedRows.value.length
      availableModes.value = [...new Set(unreceivedRows.value.map((row) => row.mode).filter(Boolean))]
      availableFolders.value = BUCKETS.map((folder) => ({
        folder,
        count: unreceivedRows.value.filter((row) => row.folder === folder).length,
      }))
    } else {
      unreceivedRows.value = []
      totalRows.value = 0
      availableModes.value = []
      availableFolders.value = BUCKETS.map((folder) => ({ folder, count: 0 }))
    }
    apiFailed.value = true
  } finally {
    loading.value = false
    selectedIds.value = new Set()
    expandedIds.value = new Set()
  }
}

function updateFilter({ key, value }) {
  filters[key] = value
  pageOffset.value = 0
  if (filterTimer) clearTimeout(filterTimer)
  filterTimer = setTimeout(() => {
    filterTimer = null
    loadUnreceived()
  }, key === 'search' ? 250 : 0)
}

async function goPage(direction) {
  const nextOffset = Math.max(0, pageOffset.value + direction * PAGE_SIZE)
  if (nextOffset === pageOffset.value || nextOffset >= Math.max(totalRows.value, 1)) return
  pageOffset.value = nextOffset
  await loadUnreceived()
}

function replaceSet(source, updater) {
  const next = new Set(source.value)
  updater(next)
  source.value = next
}

function toggleRow(id) {
  replaceSet(expandedIds, (set) => set.has(id) ? set.delete(id) : set.add(id))
}

function selectRow(id, checked) {
  replaceSet(selectedIds, (set) => checked ? set.add(id) : set.delete(id))
}

function selectAll(checked) {
  selectedIds.value = checked ? new Set(filteredRows.value.map((row) => row.id)) : new Set()
}

function removeResolvedRows(ids) {
  const idSet = new Set(ids)
  unreceivedRows.value = unreceivedRows.value.filter((row) => !idSet.has(row.id))
  totalRows.value = Math.max(0, totalRows.value - idSet.size)
  selectedIds.value = new Set([...selectedIds.value].filter((id) => !idSet.has(id)))
}

// 行 → 后端稳定标识字段(护照/姓名/小票号),与 listUnreceived 同口径
function rowToItem(row) {
  return { passportNo: row.passportNo || '', name: row.customerName || '', receiptNo: row.billNo || '' }
}

// 调真实接口落库;成功后移除,失败保留并提示(不静默消项)
async function applyResolution({ action, ids, reason = null, linkedRef = null }) {
  if (resolving.value || !ids.length) return false
  resolving.value = true
  resolveError.value = ''
  const rows = unreceivedRows.value.filter((row) => ids.includes(row.id))
  try {
    await resolveUnreceived(workspaceKey.value, {
      items: rows.map(rowToItem),
      action,
      reason,
      linkedRef,
    })
    removeResolvedRows(ids)
    return true
  } catch (error) {
    resolveError.value =
      error?.response?.data?.error || error?.message || '处理失败,请重试'
    return false
  } finally {
    resolving.value = false
  }
}

function linkRow(row, candidate) {
  applyResolution({ action: 'link', ids: [row.id], linkedRef: candidate?.id || candidate || null })
}

function openDialog(action, rows) {
  dialog.open = true
  dialog.action = action
  dialog.ids = rows.map((row) => row.id)
}

async function confirmDialog(reason) {
  const ok = await applyResolution({ action: dialog.action, ids: dialog.ids, reason })
  if (ok) dialog.open = false
}

function batchAction(action) {
  const rows = filteredRows.value.filter((row) => selectedIds.value.has(row.id))
  if (rows.length) openDialog(action, rows)
}

// 未收补录(B2):确认收不到小票的行,从账单复制真实数据反向建台账行,
// 自动重跑账单匹配后该小票从未收清单自然消失。无图,不出客户 PDF/文件夹。
async function batchBackfill() {
  const rows = filteredRows.value.filter((row) => selectedIds.value.has(row.id))
  if (!rows.length || resolving.value) return
  if (!window.confirm(
    `补录 ${rows.length} 条入台账？\n\n字段从账单复制(真实数据,审计可溯源),无照片小票,`
    + '这些客户只进四桶最终数据,不生成客户 PDF/客户文件夹。\n补录后自动重跑账单匹配。'
  )) return
  resolving.value = true
  resolveError.value = ''
  try {
    const result = await backfillUnreceived(workspaceKey.value, { items: rows.map(rowToItem) })
    // L635:不再无条件 removeResolvedRows + 假「已补录N条」。后端如实返回 {backfilled, skipped, notFound}
    // ——notFound(在账单明细里查无对应行,SMG-only 未收票的常态)必须如实告知「未变更」,不能弹成功、
    // 也不能把没补上的行从界面乐观抹掉造成"看着成功了"的错觉。列表一律以 loadUnreceived 服务端真实态为准。
    const bf = Number(result?.backfilled || 0)
    const skipped = Number(result?.skipped || 0)
    const nf = Array.isArray(result?.notFound) ? result.notFound.length : 0
    if (bf > 0 || skipped > 0) {
      const skippedNote = skipped ? `,跳过重复 ${skipped} 条` : ''
      successMessage.value = `已补录 ${bf} 条入台账并重跑账单匹配${skippedNote}`
      setTimeout(() => { successMessage.value = '' }, 6000)
    }
    if (nf > 0) {
      resolveError.value = `${nf} 条在账单明细中未找到对应行,未能补录(未变更)`
    } else if (bf === 0 && skipped === 0) {
      resolveError.value = '未补录任何行'
    }
    await loadUnreceived()
  } catch (error) {
    resolveError.value = error?.response?.data?.error || error?.message || '补录失败,请重试'
  } finally {
    resolving.value = false
  }
}

function exportXlsx() {
  // GET 带 cookie 鉴权,直接走浏览器下载(同源)
  const params = new URLSearchParams()
  if (filters.folder !== 'all') params.set('folder', filters.folder)
  if (filters.mode !== 'all') params.set('mode', filters.mode)
  if (filters.dateFrom) params.set('dateFrom', filters.dateFrom)
  if (filters.dateTo) params.set('dateTo', filters.dateTo)
  if (filters.search.trim()) params.set('search', filters.search.trim())
  const qs = params.toString()
  const url = `/api/monthly/workspaces/${encodeURIComponent(workspaceKey.value)}/bill-match/unreceived/export.xlsx${qs ? `?${qs}` : ''}`
  window.open(url, '_blank')
}

function initialFolderFilter() {
  const value = String(route.query.folder || '').trim()
  return BUCKETS.includes(value) ? value : 'all'
}

onMounted(loadUnreceived)
watch(workspaceKey, () => {
  pageOffset.value = 0
  loadUnreceived()
})
watch(() => route.query.folder, () => {
  filters.folder = initialFolderFilter()
  pageOffset.value = 0
  loadUnreceived()
})
</script>

<template>
  <AppLayout :workspace-key="workspaceKey">
    <div class="space-y-4">
      <div v-if="isDemo" class="rounded-lg border border-status-test/30 bg-status-test/10 px-4 py-2 text-sm text-status-test">
        <StatusBadge variant="test" size="sm">测试模式</StatusBadge>
        <span class="ml-2">当前在 {{ workspaceKey }} · 数据不进正式统计</span>
      </div>

      <section class="rounded-lg border border-border bg-card p-4 shadow-sm">
        <div class="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 class="text-2xl font-medium text-foreground">未收清单({{ workspaceKey }})</h1>
            <p class="mt-1 text-sm text-muted-foreground">账单有、台账无:账单里有这张票、但客户还没把小票交上来，要去追的。台账有账单无归「小票无账单」，不在此页。</p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <StatusBadge v-if="apiFailed" :variant="v2MockFallbackVariant" size="sm">{{ v2MockFallbackLabel }}</StatusBadge>
            <StatusBadge data-testid="unreceived-known-tab" variant="warn">
              账单有台账无 <TabularNumber :value="totalRows" />
            </StatusBadge>
            <Button size="sm" variant="outline" :disabled="!totalRows || importing" @click="exportXlsx">
              导出未收清单
            </Button>
          </div>
        </div>
      </section>
      <div v-if="importing" data-testid="unreceived-importing-banner" class="rounded-lg border border-status-warn/30 bg-status-warn/10 px-4 py-3 text-sm text-status-warn">
        总账正在导入中(替换窗口),本页数据可能不全、暂不可导出;请等导入完成后刷新。
      </div>
      <div v-if="apiFailed && !allowV2MockFallback" class="rounded-lg border border-status-error/30 bg-status-error/10 px-4 py-3 text-sm text-status-error">
        {{ apiError }}。生产环境不会使用 mock 数据,请刷新或检查后端接口。
      </div>
      <div v-if="resolveError" class="rounded-lg border border-status-error/30 bg-status-error/10 px-4 py-3 text-sm text-status-error">
        {{ resolveError }}
      </div>
      <div v-if="successMessage" class="rounded-lg border border-status-ok/30 bg-status-ok/10 px-4 py-3 text-sm text-status-ok">
        {{ successMessage }}
      </div>

      <UnreceivedFilters :filters="filters" :modes="modes" :folders="folders" @update="updateFilter" />

      <div class="flex flex-wrap items-center justify-between gap-2">
        <StatusBadge variant="info">
          <span v-if="loading">加载中</span>
          <span v-else>当前页 {{ pageLabel }} · 页码 {{ pageCountLabel }} · 已选 <TabularNumber :value="selectedIds.size" /> 条</span>
        </StatusBadge>
        <div class="flex gap-2">
          <Button variant="outline" :disabled="loading || pageOffset === 0" @click="goPage(-1)">上一页</Button>
          <Button variant="outline" :disabled="loading || pageOffset + PAGE_SIZE >= totalRows" @click="goPage(1)">下一页</Button>
          <Button variant="outline" :disabled="!selectedIds.size" @click="batchAction('delay')">批量延期</Button>
          <Button variant="outline" :disabled="!selectedIds.size" @click="batchAction('void')">批量作废</Button>
          <Button variant="default" :disabled="!selectedIds.size || resolving" data-testid="backfill-unreceived" @click="batchBackfill">
            补录入台账
          </Button>
        </div>
      </div>

      <UnreceivedTable
        :rows="filteredRows"
        :selected-ids="selectedIds"
        :expanded-ids="expandedIds"
        :type="'known'"
        @toggle="toggleRow"
        @select="selectRow"
        @select-all="selectAll"
        @link="linkRow"
        @delay="(row) => openDialog('delay', [row])"
        @void="(row) => openDialog('void', [row])"
      />

      <div class="flex items-center justify-between text-sm text-muted-foreground">
        <span>当前页 {{ pageLabel }} · 页码 {{ pageCountLabel }}</span>
        <div class="flex gap-2">
          <Button variant="outline" size="sm" :disabled="loading || pageOffset === 0" @click="goPage(-1)">上一页</Button>
          <Button variant="outline" size="sm" :disabled="loading || pageOffset + PAGE_SIZE >= totalRows" @click="goPage(1)">下一页</Button>
        </div>
      </div>

      <ResolutionDialog
        :open="dialog.open"
        :action="dialog.action"
        :count="dialog.ids.length"
        @close="dialog.open = false"
        @confirm="confirmDialog"
      />
      <RowHistoryDrawer :workspace-key="workspaceKey" />
    </div>
  </AppLayout>
</template>
