<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { FileSpreadsheet } from 'lucide-vue-next'

import AppLayout from '@/layouts/AppLayout.vue'
import Button from '@/components/ui/button.vue'
import Drawer from '@/components/ui/drawer.vue'
import Input from '@/components/ui/input.vue'
import Label from '@/components/ui/label.vue'
import TabularNumber from '@/components/ui/tabular-number.vue'
import LedgerTable from '@/components/v2/LedgerTable.vue'
import { deleteLedgerRow, fetchLedger, updateLedgerFields } from '@/api/v2/ledger'
import { fetchBatchGroupCodeModes } from '@/api/v2/batchGroupCodes'
import { TOUR_MATCH_STATUS, BILL_MATCH_STATUS, SOURCE_TYPE, MODE_FOLDERS, toOptions } from '@/lib/statusLabels'

const route = useRoute()
const workspaceKey = computed(() => String(route.params.workspaceKey || ''))

const rows = ref([])
const total = ref(0)
const loading = ref(false)
const actionLoading = ref('')
const errorMsg = ref('')
const successMsg = ref('')
const modeSuggestions = ref([])
const tableOpen = ref(true) // 台账明细一键收起

const filter = reactive({
  from: '',
  to: '',
  modeFolder: '',
  sourceType: '',
  tourMatchStatus: '',
  billMatchStatus: '',
})
const limit = ref(50)
const offset = ref(0)

const sourceOptions = toOptions(SOURCE_TYPE)
const tourMatchStatusOptions = toOptions(TOUR_MATCH_STATUS)
const billMatchStatusOptions = toOptions(BILL_MATCH_STATUS)
const FOLDERS = MODE_FOLDERS

const editOpen = ref(false)
const editing = ref(null)
const editForm = reactive({ purchaseDate: '', tourNo: '', agent: '', modeRaw: '' })

const tourUnmatchedCount = computed(() =>
  rows.value.filter((row) => row.tourMatchStatus && row.tourMatchStatus !== 'matched').length,
)
const billUnmatchedCount = computed(() =>
  rows.value.filter((row) => row.billMatchStatus === 'unmatched').length,
)
const kpis = computed(() => [
  { key: 'total', label: '总行数', value: total.value, hint: `本页 ${rows.value.length} 行` },
  { key: 'tour', label: '团号未匹配', value: tourUnmatchedCount.value, hint: '需要审核员补模式/团号后重跑' },
  { key: 'bill', label: '账单未匹配', value: billUnmatchedCount.value, hint: '进入未到货工作台处理' },
])

async function openEdit(row) {
  editing.value = row
  editForm.purchaseDate = row.purchaseDate || ''
  editForm.tourNo = row.tourNo || ''
  editForm.agent = row.agent || ''
  editForm.modeRaw = row.modeRaw || ''
  modeSuggestions.value = []
  editOpen.value = true

  if (row.sourceBatchId) {
    try {
      const payload = await fetchBatchGroupCodeModes(workspaceKey.value, row.sourceBatchId)
      modeSuggestions.value = Array.isArray(payload?.modes) ? payload.modes : []
    } catch {
      modeSuggestions.value = []
    }
  }
}

function closeEdit() {
  editOpen.value = false
  editing.value = null
  modeSuggestions.value = []
}

async function submitEdit() {
  if (!editing.value || !workspaceKey.value) return
  actionLoading.value = `edit:${editing.value.id}`
  errorMsg.value = ''
  try {
    const payload = {}
    if (editForm.purchaseDate !== (editing.value.purchaseDate || '')) payload.purchaseDate = editForm.purchaseDate
    if (editForm.tourNo !== (editing.value.tourNo || '')) payload.tourNo = editForm.tourNo
    if (editForm.agent !== (editing.value.agent || '')) payload.agent = editForm.agent
    if (editForm.modeRaw !== (editing.value.modeRaw || '')) payload.modeRaw = editForm.modeRaw
    if (!Object.keys(payload).length) {
      closeEdit()
      return
    }
    await updateLedgerFields(workspaceKey.value, editing.value.id, payload)
    flashSuccess(`已更新行 #${editing.value.id}`)
    closeEdit()
    await load()
  } catch (error) {
    errorMsg.value = decodeError(error, '编辑失败')
  } finally {
    actionLoading.value = ''
  }
}

function buildParams() {
  const p = { limit: limit.value, offset: offset.value }
  if (filter.from) p.from = filter.from
  if (filter.to) p.to = filter.to
  if (filter.modeFolder) p.modeFolder = filter.modeFolder
  if (filter.sourceType) p.sourceType = filter.sourceType
  if (filter.tourMatchStatus) p.tourMatchStatus = filter.tourMatchStatus
  if (filter.billMatchStatus) p.billMatchStatus = filter.billMatchStatus
  return p
}

function queryValue(name) {
  const value = route.query[name]
  if (Array.isArray(value)) return String(value[0] || '')
  return String(value || '')
}

function applyQueryFilters() {
  Object.assign(filter, {
    from: queryValue('from'),
    to: queryValue('to'),
    modeFolder: queryValue('modeFolder'),
    sourceType: queryValue('sourceType'),
    tourMatchStatus: queryValue('tourMatchStatus'),
    billMatchStatus: queryValue('billMatchStatus'),
  })
}

async function load() {
  if (!workspaceKey.value) return
  loading.value = true
  errorMsg.value = ''
  try {
    const ledger = await fetchLedger(workspaceKey.value, buildParams())
    rows.value = ledger?.rows || []
    total.value = Number(ledger?.total || 0)
  } catch (error) {
    errorMsg.value = decodeError(error, '加载失败')
    rows.value = []
    total.value = 0
  } finally {
    loading.value = false
  }
}

function applyFilter() {
  offset.value = 0
  load()
}

function resetFilter() {
  Object.assign(filter, { from: '', to: '', modeFolder: '', sourceType: '', tourMatchStatus: '', billMatchStatus: '' })
  offset.value = 0
  load()
}

function today() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function setQuick(kind) {
  if (kind === 'today') {
    filter.from = today()
    filter.to = today()
  } else if (kind === 'thisMonth') {
    const d = new Date()
    filter.from = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
    filter.to = today()
  } else if (kind === 'all') {
    filter.from = ''
    filter.to = ''
  }
  applyFilter()
}

async function removeRow(row) {
  if (!workspaceKey.value || !row?.id) return
  if (!window.confirm(`删除 #${row.id} (${row.name || '—'})?`)) return
  actionLoading.value = `delete:${row.id}`
  errorMsg.value = ''
  try {
    await deleteLedgerRow(workspaceKey.value, row.id)
    flashSuccess(`已删除 #${row.id}`)
    await load()
  } catch (error) {
    errorMsg.value = decodeError(error, '删除失败')
  } finally {
    actionLoading.value = ''
  }
}

function decodeError(error, fallback) {
  const data = error?.response?.data || {}
  if (data.code === 'endpoint_removed') return data.error || '该操作已废弃'
  if (data.code === 'service_unavailable') return `${data.service || '服务'} 不可用 (503)`
  return data.error || error?.message || fallback
}

function flashSuccess(text, ms = 3500) {
  successMsg.value = text
  setTimeout(() => {
    if (successMsg.value === text) successMsg.value = ''
  }, ms)
}

function prevPage() {
  if (offset.value >= limit.value) {
    offset.value -= limit.value
    load()
  }
}

function nextPage() {
  if (offset.value + limit.value < total.value) {
    offset.value += limit.value
    load()
  }
}

onMounted(() => {
  applyQueryFilters()
  load()
})
watch(() => [workspaceKey.value, route.fullPath], () => {
  offset.value = 0
  applyQueryFilters()
  load()
})
</script>

<template>
  <AppLayout :workspace-key="workspaceKey">
    <div class="min-w-0 space-y-5 overflow-x-hidden">
      <header class="flex items-center gap-3 px-1">
        <FileSpreadsheet class="h-6 w-6 text-primary" />
        <div class="flex-1">
          <h1 class="text-xl font-medium text-foreground">收票台账 v2</h1>
          <p class="text-sm text-muted-foreground">
            workspace <span class="font-mono">{{ workspaceKey }}</span> · 共 <TabularNumber :value="total" /> 行
          </p>
        </div>
      </header>

      <div v-if="errorMsg" class="rounded-lg border border-status-error/30 bg-status-error/10 px-4 py-2 text-sm text-status-error">{{ errorMsg }}</div>
      <div v-else-if="successMsg" class="rounded-lg border border-status-ok/30 bg-status-ok/10 px-4 py-2 text-sm text-status-ok">{{ successMsg }}</div>

      <section class="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div v-for="item in kpis" :key="item.key" class="rounded-lg border border-border bg-card p-3 shadow-sm">
          <p class="text-xs text-muted-foreground">{{ item.label }}</p>
          <TabularNumber :value="item.value || 0" class="mt-1 text-2xl font-medium" />
          <p class="mt-1 text-xs text-muted-foreground">{{ item.hint }}</p>
        </div>
      </section>

      <section class="space-y-3 rounded-lg border border-border bg-card p-4 shadow-sm">
        <div class="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
          <div class="flex flex-col gap-1">
            <Label class="text-xs">购买起</Label>
            <Input v-model="filter.from" type="date" class="h-8" />
          </div>
          <div class="flex flex-col gap-1">
            <Label class="text-xs">购买止</Label>
            <Input v-model="filter.to" type="date" class="h-8" />
          </div>
          <div class="flex flex-col gap-1">
            <Label class="text-xs">来源</Label>
            <select v-model="filter.sourceType" class="h-8 rounded-md border border-input bg-background px-2 text-sm">
              <option value="">全部</option>
              <option v-for="item in sourceOptions" :key="item.value" :value="item.value">{{ item.label }}</option>
            </select>
          </div>
          <div class="flex flex-col gap-1">
            <Label class="text-xs">归类</Label>
            <select v-model="filter.modeFolder" class="h-8 rounded-md border border-input bg-background px-2 text-sm">
              <option value="">全部</option>
              <option v-for="folder in FOLDERS" :key="folder" :value="folder">{{ folder }}</option>
            </select>
          </div>
          <div class="flex flex-col gap-1">
            <Label class="text-xs">团号匹配</Label>
            <select v-model="filter.tourMatchStatus" class="h-8 rounded-md border border-input bg-background px-2 text-sm">
              <option value="">全部</option>
              <option v-for="item in tourMatchStatusOptions" :key="item.value" :value="item.value">{{ item.label }}</option>
            </select>
          </div>
          <div class="flex flex-col gap-1">
            <Label class="text-xs">账单匹配</Label>
            <select v-model="filter.billMatchStatus" class="h-8 rounded-md border border-input bg-background px-2 text-sm">
              <option value="">全部</option>
              <option v-for="item in billMatchStatusOptions" :key="item.value" :value="item.value">{{ item.label }}</option>
            </select>
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-2 border-t border-border/40 pt-3">
          <span class="text-xs text-muted-foreground">快捷:</span>
          <Button variant="outline" size="sm" @click="setQuick('today')">今天</Button>
          <Button variant="outline" size="sm" @click="setQuick('thisMonth')">本月</Button>
          <Button variant="outline" size="sm" @click="setQuick('all')">全部</Button>
          <div class="ml-auto flex gap-2">
            <Button variant="ghost" size="sm" @click="resetFilter">重置</Button>
            <Button variant="default" size="sm" @click="applyFilter">应用筛选</Button>
          </div>
        </div>
      </section>

      <div
        class="flex cursor-pointer select-none items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-1.5 text-sm hover:bg-muted/50"
        @click="tableOpen = !tableOpen"
      >
        <span class="inline-block text-xs text-muted-foreground transition-transform" :class="{ 'rotate-90': tableOpen }">▸</span>
        <span class="font-medium">台账明细</span>
        <span class="text-xs text-muted-foreground">本页 {{ rows.length }} 行 / 共 {{ total }}</span>
      </div>
      <section v-show="tableOpen" class="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
        <LedgerTable :rows="rows" :loading="loading" @edit="openEdit" @delete="removeRow" />
      </section>

      <div v-show="tableOpen" class="flex items-center justify-between text-sm text-muted-foreground">
        <span>第 <TabularNumber :value="Math.floor(offset / limit) + 1" /> 页 · 共 <TabularNumber :value="Math.max(1, Math.ceil(total / limit))" /> 页</span>
        <div class="flex gap-2">
          <Button variant="outline" size="sm" :disabled="offset === 0" @click="prevPage">上一页</Button>
          <Button variant="outline" size="sm" :disabled="offset + limit >= total" @click="nextPage">下一页</Button>
        </div>
      </div>

      <Drawer :open="editOpen" @update:open="(v) => !v && closeEdit()">
        <div v-if="editing" class="flex h-full flex-col">
          <header class="border-b border-border pb-3">
            <h2 class="text-lg font-medium text-foreground">编辑 #{{ editing.id }}</h2>
            <p class="mt-1 text-xs text-muted-foreground font-mono">{{ editing.name || '—' }} · {{ editing.passportNo || '—' }} · {{ editing.sourceType || '—' }}</p>
          </header>
          <div class="flex-1 space-y-4 overflow-y-auto py-4">
            <div><Label class="text-xs">购买日期</Label><Input v-model="editForm.purchaseDate" type="date" /></div>
            <div><Label class="text-xs">团号</Label><Input v-model="editForm.tourNo" placeholder="T01234" /></div>
            <div><Label class="text-xs">代理</Label><Input v-model="editForm.agent" /></div>
            <div>
              <Label class="text-xs">匹配模式</Label>
              <Input v-model="editForm.modeRaw" list="ledger-mode-raw-options" placeholder="从本批团号表模式中选择或手填" />
              <datalist id="ledger-mode-raw-options">
                <option v-for="mode in modeSuggestions" :key="mode" :value="mode" />
              </datalist>
              <p class="mt-1 text-xs text-muted-foreground">候选来自当前审核批次上传的团号表；没有候选时可手动输入。</p>
            </div>
            <p class="text-xs text-muted-foreground">可编辑字段: purchaseDate / tourNo / agent / modeRaw。保存后系统按字段保护规则记录手动修改。</p>
          </div>
          <footer class="flex justify-end gap-2 border-t border-border pt-3">
            <Button variant="ghost" size="sm" @click="closeEdit">取消</Button>
            <Button variant="default" size="sm" :disabled="actionLoading.startsWith('edit:')" @click="submitEdit">保存</Button>
          </footer>
        </div>
      </Drawer>
    </div>
  </AppLayout>
</template>
