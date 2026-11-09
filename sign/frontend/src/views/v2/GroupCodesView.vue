<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { GitBranch } from 'lucide-vue-next'

import AppLayout from '@/layouts/AppLayout.vue'
import Button from '@/components/ui/button.vue'
import Label from '@/components/ui/label.vue'
import StatusBadge from '@/components/ui/status-badge.vue'
import TabularNumber from '@/components/ui/tabular-number.vue'
import DataTable from '@/components/v2/DataTable.vue'
import { fetchUsedGroupCodes } from '@/api/v2/bills'
import { fetchBatchGroupCodes } from '@/api/v2/batchGroupCodes'

const route = useRoute()
const workspaceKey = computed(() => String(route.params.workspaceKey || ''))

const activeTab = ref('used')
const limit = ref(100)
const offset = ref(0)
const usedRows = ref([])
const sourceRows = ref([])
const total = ref(0)
const batchIds = ref([])
const selectedBatchId = ref('')
const loading = ref(false)
const errorMsg = ref('')

const usedColumns = [
  { key: 'tourNo', label: '团号', width: '120px' },
  { key: 'modeRaw', label: '匹配模式' },
  { key: 'modeFolder', label: '归类大模式' },
  { key: 'sourceBatchId', label: '来源批次', width: '120px' },
  { key: 'rowsCount', label: '客户行数', width: '90px' },
  { key: 'latestImportedAt', label: '最近入月时间', width: '150px' },
]

const sourceColumns = [
  { key: 'tourNo', label: '团号', width: '120px' },
  { key: 'mode', label: '来源模式' },
  { key: 'agent', label: '代理' },
  { key: 'upstream', label: '上家' },
  { key: 'passportNo', label: '护照', width: '110px' },
  { key: 'name', label: '姓名' },
  { key: 'applyDate', label: '申请日', width: '100px' },
  { key: 'endDate', label: '截止日', width: '100px' },
  { key: 'sourceFile', label: '来源文件' },
]

const rows = computed(() => activeTab.value === 'used' ? usedRows.value : sourceRows.value)
const columns = computed(() => activeTab.value === 'used' ? usedColumns : sourceColumns)

async function load() {
  if (!workspaceKey.value) return
  loading.value = true
  errorMsg.value = ''
  try {
    if (activeTab.value === 'used') {
      const payload = await fetchUsedGroupCodes(workspaceKey.value, {
        limit: limit.value,
        offset: offset.value,
      })
      usedRows.value = payload?.rows || []
      total.value = Number(payload?.total || 0)
      batchIds.value = Array.from(new Set(usedRows.value.map((r) => r.sourceBatchId).filter(Boolean)))
      if (!selectedBatchId.value && batchIds.value.length) selectedBatchId.value = batchIds.value[0]
    } else {
      if (!selectedBatchId.value) {
        sourceRows.value = []
        total.value = 0
      } else {
        const payload = await fetchBatchGroupCodes(workspaceKey.value, {
          batchId: selectedBatchId.value,
          limit: limit.value,
          offset: offset.value,
        })
        sourceRows.value = payload?.rows || []
        total.value = Number(payload?.total || 0)
      }
    }
  } catch (error) {
    const data = error?.response?.data || {}
    errorMsg.value = data.code === 'service_unavailable'
      ? `${data.service || 'service'} unavailable (503)`
      : data.error || error?.message || '加载失败'
    if (activeTab.value === 'used') usedRows.value = []
    else sourceRows.value = []
    total.value = 0
  } finally {
    loading.value = false
  }
}

function setTab(tab) {
  activeTab.value = tab
  offset.value = 0
  load()
}

function prev() {
  if (offset.value >= limit.value) {
    offset.value -= limit.value
    load()
  }
}

function next() {
  if (offset.value + limit.value < total.value) {
    offset.value += limit.value
    load()
  }
}

onMounted(load)
watch(workspaceKey, () => { offset.value = 0; load() })
watch(selectedBatchId, () => {
  if (activeTab.value === 'source') {
    offset.value = 0
    load()
  }
})
</script>

<template>
  <AppLayout :workspace-key="workspaceKey">
    <div class="min-w-0 space-y-5 overflow-x-hidden">
      <header class="flex items-center gap-3 px-1">
        <GitBranch class="h-6 w-6 text-primary" />
        <div class="flex-1">
          <h1 class="text-xl font-medium text-foreground">团号管理 v2</h1>
          <p class="text-sm text-muted-foreground">
            workspace · <span class="font-mono">{{ workspaceKey }}</span> ·
            <span v-if="activeTab === 'used'">本月实际使用的客户匹配模式</span>
            <span v-else>审核批次上传的来源团号表全量</span>
          </p>
        </div>
        <StatusBadge variant="info" size="sm">
          <TabularNumber :value="total" /> rows
        </StatusBadge>
      </header>

      <div v-if="errorMsg" class="rounded-lg border border-status-error/30 bg-status-error/10 px-4 py-2 text-sm text-status-error">
        {{ errorMsg }}
      </div>

      <section class="rounded-lg border border-border bg-card p-4 shadow-sm">
        <div class="flex flex-wrap items-center gap-3">
          <div class="inline-flex rounded-md border border-border bg-muted/40 p-1">
            <Button :variant="activeTab === 'used' ? 'default' : 'ghost'" size="sm" @click="setTab('used')">
              本月实际使用
            </Button>
            <Button :variant="activeTab === 'source' ? 'default' : 'ghost'" size="sm" @click="setTab('source')">
              来源团号表全量
            </Button>
          </div>
          <div v-if="activeTab === 'source'" class="flex min-w-[260px] flex-col gap-1">
            <Label class="text-xs">来源批次</Label>
            <select v-model="selectedBatchId" class="h-8 rounded-md border border-input bg-background px-2 text-xs">
              <option v-if="!batchIds.length" value="">当前月暂无来源批次</option>
              <option v-for="id in batchIds" :key="id" :value="id">{{ id }}</option>
            </select>
          </div>
          <Button variant="ghost" size="sm" :disabled="loading" @click="load">刷新</Button>
        </div>
      </section>

      <DataTable
        :columns="columns"
        :rows="rows"
        :loading="loading"
        :total="total"
        :limit="limit"
        :offset="offset"
        empty-text="暂无团号数据"
        @prev="prev"
        @next="next"
      >
        <template #cell-tourNo="{ row }">
          <span class="font-mono">{{ row.tourNo }}</span>
          <StatusBadge v-if="row.isPlaceholder" variant="warn" size="sm" class="ml-2">占位</StatusBadge>
        </template>
        <template #cell-sourceBatchId="{ row }">
          <span class="font-mono text-xs">{{ row.sourceBatchId || 'manual' }}</span>
        </template>
        <template #cell-rowsCount="{ row }">
          <TabularNumber :value="row.rowsCount || 0" />
        </template>
      </DataTable>
    </div>
  </AppLayout>
</template>
