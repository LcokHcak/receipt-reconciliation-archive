<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { Shield } from 'lucide-vue-next'
import AppLayout from '@/layouts/AppLayout.vue'
import TabularNumber from '@/components/ui/tabular-number.vue'
import AuditLogFilters from '@/components/v2/AuditLogFilters.vue'
import AuditLogTable from '@/components/v2/AuditLogTable.vue'
import AuditLogDetail from '@/components/v2/AuditLogDetail.vue'
import {
  fetchAuditLogs,
  fetchDistinctActions,
  fetchDistinctResourceTypes,
  fetchDistinctUsers,
  fetchDistinctWorkspaces,
} from '@/api/v2/auditLogs'

const filters = reactive({ action: 'all', userId: 'all', workspaceKey: 'all', resourceType: 'all', range: '30' })
const limit = ref(50)
const rows = ref([])
const loading = ref(false)

const actions = ref([])
const users = ref([])
const workspaces = ref([])
const resourceTypes = ref([])

const selectedEntry = ref(null)
const drawerOpen = ref(false)

// Computed cutoff date from range filter
const cutoff = computed(() => {
  if (filters.range === 'all') return null
  const d = new Date()
  d.setDate(d.getDate() - Number(filters.range))
  return d.toISOString()
})

// G0: silent mock fallback 已撤,需要显式 error state 让用户看到 503
const errorMsg = ref('')

function decodeError(error, fallback) {
  const data = error?.response?.data || {}
  if (data.code === 'service_unavailable') return `${data.service || '审计服务'} 不可用 (503)`
  return data.error || error?.message || fallback
}

async function load() {
  loading.value = true
  errorMsg.value = ''
  try {
    rows.value = await fetchAuditLogs({
      action: filters.action === 'all' ? null : filters.action,
      userId: filters.userId === 'all' ? null : filters.userId,
      workspaceKey: filters.workspaceKey === 'all' ? null : filters.workspaceKey,
      resourceType: filters.resourceType === 'all' ? null : filters.resourceType,
      startDate: cutoff.value,
      limit: limit.value,
      offset: 0,
    })
  } catch (error) {
    errorMsg.value = decodeError(error, '加载审计日志失败')
    rows.value = []
  } finally {
    loading.value = false
  }
}

async function loadDistincts() {
  try {
    const [a, u, w, r] = await Promise.all([
      fetchDistinctActions(),
      fetchDistinctUsers(),
      fetchDistinctWorkspaces(),
      fetchDistinctResourceTypes(),
    ])
    actions.value = a
    users.value = u
    workspaces.value = w
    resourceTypes.value = r
  } catch (error) {
    errorMsg.value = decodeError(error, '加载 distinct 选项失败')
  }
}

function onFiltersUpdate(next) {
  Object.assign(filters, next)
  limit.value = 50
  load()
}

function onSelect(entry) {
  selectedEntry.value = entry
  drawerOpen.value = true
}

function onLoadMore() {
  limit.value += 50
  load()
}

const hasMore = computed(() => rows.value.length >= limit.value)

onMounted(async () => {
  await loadDistincts()
  await load()
})
</script>

<template>
  <AppLayout>
    <div class="min-w-0 space-y-5 overflow-x-hidden">
      <!-- page header -->
      <header class="flex items-center gap-3 px-1">
        <Shield class="h-6 w-6 text-primary" />
        <div>
          <h1 class="text-xl font-medium text-foreground">审计日志</h1>
          <p class="text-sm text-muted-foreground">
            全系统操作审计 · 共 <TabularNumber :value="rows.length" /> 条记录（当前视图）
          </p>
        </div>
      </header>

      <div v-if="errorMsg" class="rounded-lg border border-status-error/30 bg-status-error/10 px-4 py-2 text-sm text-status-error">{{ errorMsg }}</div>

      <!-- filter bar -->
      <div class="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
        <AuditLogFilters
          :model="filters"
          :actions="actions"
          :users="users"
          :workspaces="workspaces"
          :resource-types="resourceTypes"
          @update="onFiltersUpdate"
        />

        <!-- loading state -->
        <div v-if="loading" class="px-4 py-12 text-center text-sm text-muted-foreground">
          加载中…
        </div>

        <!-- table -->
        <AuditLogTable
          v-else
          :rows="rows"
          :selected-id="selectedEntry?.id ?? null"
          :has-more="hasMore"
          @select="onSelect"
          @load-more="onLoadMore"
        />
      </div>
    </div>

    <!-- detail drawer -->
    <AuditLogDetail
      :entry="selectedEntry"
      :open="drawerOpen"
      @close="drawerOpen = false"
    />
  </AppLayout>
</template>
