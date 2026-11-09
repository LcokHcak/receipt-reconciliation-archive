<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { X } from 'lucide-vue-next'
import Button from '@/components/ui/button.vue'
import Drawer from '@/components/ui/drawer.vue'
import StatusBadge from '@/components/ui/status-badge.vue'
import TabularNumber from '@/components/ui/tabular-number.vue'
import { getRowHistory } from '@/mocks/v2'
import { useRowHistory } from '@/composables/useRowHistory'
import { allowV2MockFallback, v2MockFallbackLabel, v2MockFallbackVariant } from '@/lib/v2/mock_fallback'
import HistoryFilters from './HistoryFilters.vue'
import HistoryTimeline from './HistoryTimeline.vue'

const props = defineProps({
  workspaceKey: { type: String, default: 'demo-2026-05' },
})

const { rowHistoryState, closeRowHistory } = useRowHistory()
const loading = ref(false)
const apiFailed = ref(false)
const apiError = ref('')
const data = ref(null)
const limit = ref(50)
const filters = reactive({ source: 'all', field: 'all', actor: 'all', range: '30' })

function normalizeApiHistory(rowId, rows) {
  return {
    rowId,
    passportNo: `daily_row #${rowId}`,
    customerName: '历史记录',
    mode: '',
    events: rows.map((row) => ({
      ts: row.ts || row.changed_at,
      actor: row.actor || 'system',
      actorType: row.actor === 'system' ? 'system' : 'user',
      changeSource: row.change_source || row.changeSource,
      field: row.field,
      label: row.field,
      before: row.before_value ?? row.before,
      after: row.after_value ?? row.after,
      conflictId: row.conflict_id || row.conflictId || null,
      locked: Boolean(row.locked),
    })),
  }
}

async function loadHistory(rowId) {
  if (!rowId) return
  loading.value = true
  apiFailed.value = false
  apiError.value = ''
  limit.value = 50
  try {
    const res = await fetch(`/api/monthly/v2/${encodeURIComponent(props.workspaceKey)}/daily/${encodeURIComponent(rowId)}/history?limit=50`, { credentials: 'include' })
    if (!res.ok) throw new Error(`history api ${res.status}`)
    const payload = await res.json()
    data.value = normalizeApiHistory(rowId, payload.items || payload.rows || payload.history || [])
  } catch (error) {
    apiFailed.value = true
    apiError.value = error?.response?.data?.message || error?.response?.data?.error || error?.message || '行历史接口加载失败'
    data.value = allowV2MockFallback ? getRowHistory(rowId) : normalizeApiHistory(rowId, [])
  } finally {
    loading.value = false
  }
}

watch(() => rowHistoryState.rowId, (rowId) => {
  if (rowHistoryState.open && rowId) loadHistory(rowId)
})

watch(() => rowHistoryState.open, (open) => {
  if (open && rowHistoryState.rowId) loadHistory(rowHistoryState.rowId)
})

const allEvents = computed(() => data.value?.events || [])
const fields = computed(() => [...new Set(allEvents.value.map((event) => event.label || event.field))])
const actors = computed(() => [...new Set(allEvents.value.map((event) => event.actor))])
const cutoff = computed(() => {
  if (filters.range === 'all') return null
  const date = new Date()
  date.setDate(date.getDate() - Number(filters.range))
  return date
})

const filteredEvents = computed(() => allEvents.value.filter((event) => {
  if (filters.source !== 'all' && event.changeSource !== filters.source) return false
  if (filters.field !== 'all' && (event.label || event.field) !== filters.field) return false
  if (filters.actor !== 'all' && event.actor !== filters.actor) return false
  if (cutoff.value) {
    const ts = new Date(event.ts)
    if (!Number.isNaN(ts.getTime()) && ts < cutoff.value) return false
  }
  return true
}))

const visibleEvents = computed(() => filteredEvents.value.slice(0, limit.value))
const hasMore = computed(() => visibleEvents.value.length < filteredEvents.value.length)

function updateFilters(next) {
  Object.assign(filters, next)
  limit.value = 50
}

function openConflict(_conflictId) {
  // 占位:历史抽屉「查看冲突」尚未接冲突详情跳转,后续接入路由。先不输出日志。
}
</script>

<template>
  <Drawer v-model:open="rowHistoryState.open">
    <div class="flex h-full flex-col">
      <header data-testid="row-history-drawer" class="flex items-start justify-between gap-3 border-b border-border p-4">
        <div>
          <div class="flex flex-wrap items-center gap-2">
            <h2 class="text-lg font-medium text-foreground">行历史 · {{ data?.passportNo || rowHistoryState.rowId }}</h2>
            <StatusBadge v-if="apiFailed" :variant="v2MockFallbackVariant" size="sm">{{ v2MockFallbackLabel }}</StatusBadge>
          </div>
          <p class="mt-1 text-sm text-muted-foreground">
            {{ data?.customerName || '加载中' }} · daily_row #{{ rowHistoryState.rowId }}
            <span v-if="data?.mode"> · {{ data.mode }}</span>
          </p>
          <p v-if="apiFailed && !allowV2MockFallback" class="mt-2 text-xs text-status-error">
            {{ apiError }}。生产环境不会使用 mock 历史记录。
          </p>
        </div>
        <Button variant="ghost" size="icon" @click="closeRowHistory">
          <X class="h-4 w-4" />
        </Button>
      </header>

      <HistoryFilters :model="filters" :fields="fields" :actors="actors" @update="updateFilters" />

      <div class="flex-1 overflow-y-auto">
        <div v-if="loading" class="p-8 text-center text-sm text-muted-foreground">
          加载历史中...
        </div>
        <HistoryTimeline
          v-else
          :events="visibleEvents"
          :has-more="hasMore"
          @load-more="limit += 50"
          @open-conflict="openConflict"
        />
      </div>

      <footer class="border-t border-border px-4 py-3 text-xs text-muted-foreground">
        当前显示 <TabularNumber :value="visibleEvents.length" /> / <TabularNumber :value="filteredEvents.length" /> 条
      </footer>
    </div>
  </Drawer>
</template>
