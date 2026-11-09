<script setup>
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import AppLayout from '@/layouts/AppLayout.vue'
import Button from '@/components/ui/button.vue'
import StatusBadge from '@/components/ui/status-badge.vue'
import TabularNumber from '@/components/ui/tabular-number.vue'
import { getConflicts } from '@/mocks/v2'
import { fetchPendingReviews, resolveConflict } from '@/api/v2/conflicts'
import ConflictDetail from '@/components/v2/ConflictDetail.vue'
import ConflictList from '@/components/v2/ConflictList.vue'
import RowHistoryDrawer from '@/components/v2/RowHistoryDrawer.vue'
import { allowV2MockFallback, v2MockFallbackLabel, v2MockFallbackVariant } from '@/lib/v2/mock_fallback'

const route = useRoute()
const workspaceKey = computed(() => String(route.params.workspaceKey || 'demo-2026-05'))
const isDemo = computed(() => workspaceKey.value.startsWith('demo-'))

const fallback = computed(() => getConflicts(workspaceKey.value))
const pendingItems = ref([])
const resolvedItems = ref([])
const activeTab = ref('pending')
const activeId = ref('')
const fieldFilter = ref('all')
const modeFilter = ref('all')
const onlyUnlocked = ref(true)
const apiFailed = ref(false)
const apiError = ref('')
const resolutionError = ref('')
const isLoading = ref(false)

const modes = computed(() => [...new Set([...pendingItems.value, ...resolvedItems.value].map((item) => item.mode))])

const currentSource = computed(() => activeTab.value === 'pending' ? pendingItems.value : resolvedItems.value)

function fieldType(field) {
  if (['birth', 'passportNo', 'customerName'].includes(field.field)) return 'identity'
  if (field.field.toLowerCase().includes('date')) return 'date'
  if (field.field.toLowerCase().includes('amount')) return 'amount'
  return 'customer'
}

const filteredItems = computed(() => currentSource.value.filter((item) => {
  if (modeFilter.value !== 'all' && item.mode !== modeFilter.value) return false
  if (onlyUnlocked.value && !item.fields.some((field) => !field.isLocked)) return false
  if (fieldFilter.value !== 'all' && !item.fields.some((field) => fieldType(field) === fieldFilter.value)) return false
  return true
}))

const activeItem = computed(() => filteredItems.value.find((item) => item.id === activeId.value) || filteredItems.value[0] || null)

watch(filteredItems, (items) => {
  if (!items.some((item) => item.id === activeId.value)) {
    activeId.value = items[0]?.id || ''
  }
})

function selectItem(id) {
  activeId.value = id
}

function skipCurrent() {
  const index = filteredItems.value.findIndex((item) => item.id === activeItem.value?.id)
  activeId.value = filteredItems.value[index + 1]?.id || filteredItems.value[index - 1]?.id || ''
}

function decisionFromPayload(payload) {
  const fieldOverrides = {}
  for (const field of payload.fields || []) {
    if (!field.resolution) continue
    if (field.resolution.action === 'keep') fieldOverrides[field.field] = 'use_daily'
    if (field.resolution.action === 'accept') fieldOverrides[field.field] = 'use_bill'
    if (field.resolution.action === 'manual') fieldOverrides[field.field] = { custom: field.resolution.value }
  }
  return { fieldOverrides }
}

async function applyResolution(payload) {
  const decision = decisionFromPayload(payload)
  resolutionError.value = ''
  let result
  try {
    result = await resolveConflict({
      workspaceKey: workspaceKey.value,
      id: payload.conflictId,
      decision,
      resolution: 'field_conflict_resolved',
    })
  } catch (error) {
    console.warn('resolve conflict failed', error)
    resolutionError.value = describeError(error, '冲突解决失败,这条记录仍保留在待处理')
    return
  }
  // 复核HIGH-2(2026-07-16):后端 200 但 ok:false = 没真正落库(行被删/reset 等,item 仍 open)。
  // 此前不检查就把条目挪进"已处理"→ DB 对了 UI 却撒谎(幽灵成功换到 UI 层复发)。留在待处理并给原因。
  if (result && result.ok === false) {
    const why = Array.isArray(result.warnings) && result.warnings.length ? result.warnings.join('、') : '未知原因'
    resolutionError.value = `这条没有真正处理成功(${why}),仍保留在待处理——通常是底层数据已变化,刷新后重试`
    return
  }
  const index = pendingItems.value.findIndex((item) => item.id === payload.conflictId)
  if (index >= 0) {
    const [item] = pendingItems.value.splice(index, 1)
    resolvedItems.value.unshift({ ...item, resolved: true, resolutionPayload: payload })
  }
  skipCurrent()
}

function describeError(error, fallbackMessage) {
  const data = error?.response?.data || {}
  return data.message || data.error || error?.message || fallbackMessage
}

function normalizeConflict(row, index) {
  const detail = row.detail || {}
  const conflicts = Array.isArray(detail.conflicts) ? detail.conflicts : []
  return {
    id: String(row.id),
    rowId: String(detail.dailyReceiptId || row.sourceId || `d${index + 1}`),
    passportId: detail.passportId || '',
    passportNo: detail.passportNo || detail.passport_no || row.passportNo || '—',
    customerName: detail.customerName || detail.name || row.customerName || '—',
    mode: detail.modeFolder || detail.mode || row.mode || '未分配',
    purchaseDate: detail.purchaseDate || '',
    age: row.createdAt || row.created_at || '',
    reasonType: row.reasonType || row.reason_type,
    fields: conflicts.map((conflict) => ({
      field: conflict.field,
      label: fieldLabel(conflict.field),
      current: conflict.dailyValue ?? conflict.ledgerValue ?? conflict.current ?? '',
      incoming: conflict.billValue ?? conflict.incoming ?? '',
      severity: conflict.severity || (String(conflict.field).toLowerCase().includes('amount') ? 'error' : 'warn'),
      currentSource: '台账',
      incomingSource: '账单',
      isLocked: Boolean(conflict.isLocked),
    })),
  }
}

function fieldLabel(field) {
  const labels = {
    birth: '出生日期',
    passportNo: '护照号',
    customerName: '客户姓名',
    name: '姓名',
    receiptNo: '小票号',
    purchaseDate: '购买日期',
    tourNo: '团号',
    amount: '金额',
  }
  return labels[field] || field
}

async function loadConflicts() {
  isLoading.value = true
  try {
    const [openPayload, resolvedPayload] = await Promise.all([
      fetchPendingReviews(workspaceKey.value, { status: 'open', limit: 200 }),
      fetchPendingReviews(workspaceKey.value, { status: 'resolved', limit: 200 }),
    ])
    pendingItems.value = (openPayload.rows || [])
      .filter((row) => (row.reasonType || row.reason_type) === 'field_conflict')
      .map(normalizeConflict)
      .filter((item) => item.fields.length)
    resolvedItems.value = (resolvedPayload.rows || [])
      .filter((row) => (row.reasonType || row.reason_type) === 'field_conflict')
      .map(normalizeConflict)
    apiFailed.value = false
    apiError.value = ''
  } catch (error) {
    console.warn('conflicts load failed', error)
    apiError.value = describeError(error, '字段冲突接口加载失败')
    if (allowV2MockFallback) {
      pendingItems.value = [...fallback.value.pending]
      resolvedItems.value = [...fallback.value.resolved]
    } else {
      pendingItems.value = []
      resolvedItems.value = []
    }
    apiFailed.value = true
  } finally {
    isLoading.value = false
  }
}

watch(workspaceKey, loadConflicts, { immediate: true })
</script>

<template>
  <AppLayout :workspace-key="workspaceKey">
    <div class="space-y-4">
      <div v-if="isDemo" class="rounded-lg border border-status-test/30 bg-status-test/10 px-4 py-2 text-sm text-status-test">
        <StatusBadge variant="test" size="sm">测试模式</StatusBadge>
        <span class="ml-2">当前在 {{ workspaceKey }} · 数据不进正式统计</span>
      </div>
      <StatusBadge v-if="apiFailed" :variant="v2MockFallbackVariant" size="sm">{{ v2MockFallbackLabel }}</StatusBadge>
      <div v-if="apiFailed && !allowV2MockFallback" class="rounded-lg border border-status-error/30 bg-status-error/10 px-4 py-3 text-sm text-status-error">
        {{ apiError }}。生产环境不会使用 mock 数据,请刷新或检查后端接口。
      </div>
      <div v-if="resolutionError" class="rounded-lg border border-status-error/30 bg-status-error/10 px-4 py-3 text-sm text-status-error">
        {{ resolutionError }}
      </div>

      <section class="rounded-lg border border-border bg-card p-4 shadow-sm">
        <div class="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 class="text-2xl font-medium text-foreground">字段冲突({{ workspaceKey }})</h1>
            <p class="mt-1 text-sm text-muted-foreground">复跑 OCR 后的新旧字段差异在这里逐条确认,处理后可锁定字段。</p>
            <p v-if="isLoading" class="mt-1 text-xs text-muted-foreground">加载中...</p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <Button
              :variant="activeTab === 'pending' ? 'default' : 'outline'"
              @click="activeTab = 'pending'"
            >
              待处理 <TabularNumber :value="pendingItems.length" />
            </Button>
            <Button
              :variant="activeTab === 'resolved' ? 'default' : 'outline'"
              @click="activeTab = 'resolved'"
            >
              已处理 <TabularNumber :value="resolvedItems.length" />
            </Button>
          </div>
        </div>

        <div class="mt-4 grid gap-3 md:grid-cols-4">
          <label class="space-y-1 text-xs text-muted-foreground">
            字段类型
            <select v-model="fieldFilter" class="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground">
              <option value="all">全部</option>
              <option value="identity">身份信息</option>
              <option value="date">日期</option>
              <option value="amount">金额</option>
              <option value="customer">客户匹配</option>
            </select>
          </label>
          <label class="space-y-1 text-xs text-muted-foreground">
            模式
            <select v-model="modeFilter" class="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground">
              <option value="all">全模式</option>
              <option v-for="mode in modes" :key="mode" :value="mode">{{ mode }}</option>
            </select>
          </label>
          <label class="flex items-end gap-2 text-sm text-foreground">
            <input v-model="onlyUnlocked" type="checkbox" class="mb-3 h-4 w-4 rounded border-input text-primary">
            <span class="mb-2">仅未锁</span>
          </label>
          <div class="flex items-end justify-end">
            <StatusBadge variant="warn">
              当前筛选 <TabularNumber :value="filteredItems.length" /> 条
            </StatusBadge>
          </div>
        </div>
      </section>

      <div class="grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
        <ConflictList :items="filteredItems" :active-id="activeItem?.id || ''" @select="selectItem" />
        <ConflictDetail :item="activeItem" @skip="skipCurrent" @apply="applyResolution" />
      </div>
      <RowHistoryDrawer :workspace-key="workspaceKey" />
    </div>
  </AppLayout>
</template>
