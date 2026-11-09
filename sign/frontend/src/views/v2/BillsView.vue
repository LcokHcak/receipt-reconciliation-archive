<script setup>
// v2 BillsView (Sprint F F5) — 账单明细分页查询。共用 DataTable。
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { Receipt } from 'lucide-vue-next'

import AppLayout from '@/layouts/AppLayout.vue'
import Button from '@/components/ui/button.vue'
import Label from '@/components/ui/label.vue'
import StatusBadge from '@/components/ui/status-badge.vue'
import TabularNumber from '@/components/ui/tabular-number.vue'
import DataTable from '@/components/v2/DataTable.vue'
import { fetchBills } from '@/api/v2/bills'

const route = useRoute()
const workspaceKey = computed(() => String(route.params.workspaceKey || ''))

const filter = reactive({ family: '', mode: '' })
const limit = ref(100)
const offset = ref(0)
const rows = ref([])
const total = ref(0)
const loading = ref(false)
const errorMsg = ref('')

const columns = [
  { key: 'storeFamily',     label: '店族',    width: '90px' },
  { key: 'storeBranch',     label: '分店',    width: '110px' },
  { key: 'modeNormalized',  label: '模式',    width: '70px', format: (r) => r.modeNormalized || r.mode || '—' },
  { key: 'tourNo',          label: '团号',    width: '110px' },
  { key: 'purchaseDate',    label: '购买日期', width: '100px' },
  { key: 'name',            label: '姓名' },
  { key: 'passportNo',      label: '护照',    width: '100px' },
  { key: 'receiptNo',       label: '小票号',  width: '120px' },
  { key: 'matchPriority',    label: '匹配优先级', width: '110px', align: 'center' },
  { key: 'brand',           label: '品牌' },
  { key: 'qty',             label: '数量',    align: 'right', width: '60px' },
  { key: 'netUsd',          label: '净卖出$', align: 'right' },
  { key: 'rebateAmount',    label: '返点 ₩',  align: 'right' },
  { key: 'sourceSheet',     label: 'Sheet',
    format: (r) => `${r.sourceSheet || ''}${r.isDetailSheet ? '' : ' (辅助)'}` },
]

function priorityOf(row) {
  const value = Number(row.matchPriority ?? row.match_priority ?? row.billMatchPriority ?? row.bill_match_priority ?? row.priority)
  if (!Number.isFinite(value) || value <= 0) return null
  if (value <= 2) return { value, variant: 'ok' }
  if (value <= 4) return { value, variant: 'info' }
  return { value, variant: 'warn' }
}

async function load() {
  if (!workspaceKey.value) return
  loading.value = true
  errorMsg.value = ''
  try {
    const payload = await fetchBills(workspaceKey.value, {
      family: filter.family || undefined,
      mode:   filter.mode   || undefined,
      limit:  limit.value,
      offset: offset.value,
    })
    rows.value = payload?.rows || []
    total.value = Number(payload?.total || 0)
  } catch (error) {
    const data = error?.response?.data || {}
    errorMsg.value =
      data.code === 'service_unavailable' ? `${data.service || '服务'} 不可用 (503)`
      : data.error || error?.message || '加载失败'
    rows.value = []
    total.value = 0
  } finally {
    loading.value = false
  }
}

function applyFilter() { offset.value = 0; load() }
function prev() { if (offset.value >= limit.value) { offset.value -= limit.value; load() } }
function next() { if (offset.value + limit.value < total.value) { offset.value += limit.value; load() } }

onMounted(load)
watch(workspaceKey, () => { offset.value = 0; load() })
</script>

<template>
  <AppLayout :workspace-key="workspaceKey">
    <div class="min-w-0 space-y-5 overflow-x-hidden">
      <header class="flex items-center gap-3 px-1">
        <Receipt class="h-6 w-6 text-primary" />
        <div class="flex-1">
          <h1 class="text-xl font-medium text-foreground">账单明细 v2</h1>
          <p class="text-sm text-muted-foreground">
            workspace · <span class="font-mono">{{ workspaceKey }}</span> ·
            共 <TabularNumber :value="total" /> 条
          </p>
        </div>
      </header>

      <div v-if="errorMsg" class="rounded-lg border border-status-error/30 bg-status-error/10 px-4 py-2 text-sm text-status-error">{{ errorMsg }}</div>

      <section class="rounded-lg border border-border bg-card p-4 shadow-sm">
        <div class="flex flex-wrap items-end gap-3">
          <div class="flex flex-col gap-1">
            <Label class="text-xs">店族</Label>
            <select v-model="filter.family" class="h-8 rounded-md border border-input bg-background px-2 text-sm">
              <option value="">全部店族</option>
              <option value="乐天">乐天</option>
              <option value="新罗">新罗</option>
              <option value="爱宝客">爱宝客</option>
            </select>
          </div>
          <div class="flex flex-col gap-1">
            <Label class="text-xs">模式</Label>
            <select v-model="filter.mode" class="h-8 rounded-md border border-input bg-background px-2 text-sm">
              <option value="">全部模式</option>
              <option v-for="m in ['PKG','SG','H','B','V','F','FIT','UNKNOWN']" :key="m" :value="m">{{ m }}</option>
            </select>
          </div>
          <div class="ml-auto flex gap-2">
            <Button variant="default" size="sm" @click="applyFilter">应用</Button>
            <Button variant="ghost" size="sm" @click="() => { filter.family = ''; filter.mode = ''; applyFilter() }">重置</Button>
          </div>
        </div>
      </section>

      <DataTable
        :columns="columns" :rows="rows" :loading="loading"
        :total="total" :limit="limit" :offset="offset"
        @prev="prev" @next="next"
      >
        <template #cell-matchPriority="{ row }">
          <StatusBadge v-if="priorityOf(row)" :variant="priorityOf(row).variant" size="sm">
            P<TabularNumber :value="priorityOf(row).value" />
          </StatusBadge>
          <span v-else class="text-xs text-muted-foreground">—</span>
        </template>
      </DataTable>
    </div>
  </AppLayout>
</template>
