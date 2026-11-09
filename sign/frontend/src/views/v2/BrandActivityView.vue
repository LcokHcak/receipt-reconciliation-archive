<script setup>
// 品牌活动(活动数据)第5个桶 — 跟 4 个账单桶一致的查看/管理页。
// 导入:把"X月品牌活动数据.xlsx"和其它账单一起拖进账单导入即可,后端自动分流到这里。
// 本页:看清单 + 汇总核对 + 清空(替换)。清空/替换后请重跑 merge。
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { Sparkles } from 'lucide-vue-next'

import AppLayout from '@/layouts/AppLayout.vue'
import Button from '@/components/ui/button.vue'
import StatusBadge from '@/components/ui/status-badge.vue'
import TabularNumber from '@/components/ui/tabular-number.vue'
import DataTable from '@/components/v2/DataTable.vue'
import FileDropzone from '@/components/v2/FileDropzone.vue'
import { fetchBrandActivity, clearBrandActivity } from '@/api/v2/brandActivity'
import { uploadImport } from '@/api/v2/imports'

const route = useRoute()
const workspaceKey = computed(() => String(route.params.workspaceKey || ''))

const rows = ref([])
const total = ref(0)
const summary = ref({ rows: 0, rebateTotal: 0, negativeRows: 0 })
const limit = ref(100)
const offset = ref(0)
const loading = ref(false)
const clearing = ref(false)
const uploading = ref(false)
const uploadProgress = ref(0)
const uploadFileName = ref('')
const uploadError = ref('')
const uploadSuccess = ref('')
const errorMsg = ref('')
const successMsg = ref('')

const columns = [
  { key: 'passportNo', label: '护照', width: '120px' },
  { key: 'name', label: '姓名' },
  { key: 'brand', label: '品牌' },
  { key: 'purchaseDate', label: '购买日期', width: '110px',
    format: (r) => (r.purchaseDate ? String(r.purchaseDate).slice(0, 10) : '—') },
  { key: 'storeBranch', label: '分店', width: '110px' },
  { key: 'netKrw', label: '纯卖出(₩)', align: 'right' },
  { key: 'rebateAmount', label: '客人返点(₩)', align: 'right' },
]

async function load() {
  if (!workspaceKey.value) return
  loading.value = true
  errorMsg.value = ''
  try {
    const payload = await fetchBrandActivity(workspaceKey.value, { limit: limit.value, offset: offset.value })
    rows.value = payload?.rows || []
    total.value = Number(payload?.total || 0)
    summary.value = payload?.summary || { rows: 0, rebateTotal: 0, negativeRows: 0 }
  } catch (error) {
    errorMsg.value = decodeError(error, '加载品牌活动失败')
  } finally {
    loading.value = false
  }
}

async function clearBucket() {
  if (!window.confirm(`确定清空品牌活动桶(${summary.value.rows} 行)?清空后需要重跑 merge 才能从交付里去掉。`)) return
  clearing.value = true
  errorMsg.value = ''
  try {
    const r = await clearBrandActivity(workspaceKey.value)
    flashSuccess(`已清空 ${r?.deleted ?? 0} 行。重新导入品牌活动文件后重跑 merge 即可替换。`)
    await load()
  } catch (error) {
    errorMsg.value = decodeError(error, '清空失败')
  } finally {
    clearing.value = false
  }
}

async function uploadBrandActivity(file) {
  if (!file || uploading.value) return
  uploading.value = true
  uploadProgress.value = 0
  uploadFileName.value = file.name || ''
  uploadError.value = ''
  uploadSuccess.value = ''
  errorMsg.value = ''
  try {
    const payload = await uploadImport(workspaceKey.value, 'store-bill', file, {
      onUploadProgress: (event) => {
        uploadProgress.value = event.total ? Math.round((event.loaded / event.total) * 100) : 20
      },
    })
    const job = payload?.job || payload || {}
    const inserted = Number(job.rowsInserted ?? job.rows_inserted ?? 0)
    const totalRows = Number(job.rowsTotal ?? job.rows_total ?? 0)
    const text = `品牌活动表已导入: ${inserted || totalRows} 行`
    uploadSuccess.value = text
    flashSuccess(`${text},已刷新品牌活动桶`)
    offset.value = 0
    await load()
  } catch (error) {
    uploadError.value = decodeError(error, '品牌活动导入失败')
  } finally {
    uploading.value = false
  }
}

function resetUpload() {
  uploadError.value = ''
  uploadSuccess.value = ''
  uploadFileName.value = ''
  uploadProgress.value = 0
}

function prev() { if (offset.value >= limit.value) { offset.value -= limit.value; load() } }
function next() { if (offset.value + limit.value < total.value) { offset.value += limit.value; load() } }

function decodeError(error, fallback) {
  const data = error?.response?.data || {}
  if (data.code === 'WORKSPACE_LOCKED') return '月份已锁,无法修改'
  if (data.code === 'service_unavailable') return `${data.service || '服务'} 不可用 (503)`
  return data.error || error?.message || fallback
}
function flashSuccess(text, ms = 4000) {
  successMsg.value = text
  setTimeout(() => { if (successMsg.value === text) successMsg.value = '' }, ms)
}
const fmtMoney = (v) => (v == null ? '—' : Number(v).toLocaleString('zh-CN'))

onMounted(load)
watch(workspaceKey, () => { offset.value = 0; load() })
</script>

<template>
  <AppLayout :workspace-key="workspaceKey">
    <div class="min-w-0 space-y-5 overflow-x-hidden">
      <header class="flex items-center gap-3 px-1">
        <Sparkles class="h-6 w-6 text-primary" />
        <div class="flex-1">
          <h1 class="text-xl font-medium text-foreground">品牌活动(活动数据)</h1>
          <p class="text-sm text-muted-foreground">
            workspace · <span class="font-mono">{{ workspaceKey }}</span> ·
            额外的品牌促销返点,折进乐天首尔交付 · 共 <TabularNumber :value="total" /> 条
          </p>
        </div>
        <Button variant="ghost" size="sm" :disabled="loading" @click="load">刷新</Button>
        <Button variant="outline" size="sm" :disabled="clearing || !total" @click="clearBucket">清空 / 替换</Button>
      </header>

      <div v-if="errorMsg" class="rounded-lg border border-status-error/30 bg-status-error/10 px-4 py-2 text-sm text-status-error">{{ errorMsg }}</div>
      <div v-else-if="successMsg" class="rounded-lg border border-status-ok/30 bg-status-ok/10 px-4 py-2 text-sm text-status-ok">{{ successMsg }}</div>

      <div class="rounded-lg border border-primary/20 bg-primary/5 px-4 py-3 text-sm text-foreground">
        导入:把「X月品牌活动数据.xlsx」拖到下方导入区即可;后端沿用账单导入并自动识别品牌活动行,放进这个桶(不走小票匹配)。
        在这里核对总额无误后,正常跑 merge,品牌活动会自动折进乐天首尔交付。
      </div>

      <section class="rounded-lg border border-border bg-card p-4 shadow-sm">
        <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 class="text-sm font-medium text-foreground">导入品牌活动表</h2>
            <p class="mt-1 text-xs text-muted-foreground">支持 xlsx/xls;导入后会自动刷新品牌活动清单。</p>
          </div>
          <StatusBadge variant="info" size="sm">store-bill 自动分流</StatusBadge>
        </div>
        <FileDropzone
          accept=".xlsx,.xls"
          hint="拖入品牌活动数据 xlsx"
          :uploading="uploading"
          :progress="uploadProgress"
          :file-name="uploadFileName"
          :error="uploadError"
          :success="uploadSuccess"
          @file="uploadBrandActivity"
          @reset="resetUpload"
        />
      </section>

      <!-- 汇总核对卡 -->
      <section class="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div class="rounded-lg border border-border bg-card p-3 shadow-sm">
          <h3 class="text-xs font-medium text-muted-foreground">行数</h3>
          <p class="mt-1 text-2xl font-medium text-foreground"><TabularNumber :value="summary.rows" /></p>
        </div>
        <div class="rounded-lg border border-border bg-card p-3 shadow-sm">
          <h3 class="text-xs font-medium text-muted-foreground">客人返点合计(₩)</h3>
          <p class="mt-1 text-2xl font-medium text-foreground">{{ fmtMoney(Math.round(summary.rebateTotal)) }}</p>
          <p class="mt-1 text-xs text-muted-foreground">对照源文件确认一致即导入成功</p>
        </div>
        <div class="rounded-lg border border-border bg-card p-3 shadow-sm">
          <h3 class="text-xs font-medium text-muted-foreground">负数(退货)行</h3>
          <p class="mt-1 text-2xl font-medium" :class="summary.negativeRows ? 'text-status-warn' : 'text-foreground'">
            <TabularNumber :value="summary.negativeRows" />
          </p>
          <p class="mt-1 text-xs text-muted-foreground">负返点会在交付里自动冲减</p>
        </div>
      </section>

      <DataTable
        :columns="columns"
        :rows="rows"
        :loading="loading"
        :total="total"
        :limit="limit"
        :offset="offset"
        empty-text="暂无品牌活动数据(把品牌活动文件拖进账单导入即可)"
        @prev="prev"
        @next="next"
      >
        <template #cell-passportNo="{ row }">
          <code class="font-mono text-xs">{{ row.passportNo || '—' }}</code>
        </template>
        <template #cell-netKrw="{ row }">
          <TabularNumber v-if="row.netKrw != null" :value="row.netKrw" />
          <span v-else>—</span>
        </template>
        <template #cell-rebateAmount="{ row }">
          <span :class="(row.rebateAmount ?? 0) < 0 ? 'font-medium text-status-error' : ''">
            <TabularNumber v-if="row.rebateAmount != null" :value="row.rebateAmount" />
            <span v-else>—</span>
          </span>
        </template>
      </DataTable>
    </div>
  </AppLayout>
</template>
