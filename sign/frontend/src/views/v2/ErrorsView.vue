<script setup>
// v2 ErrorsView (Sprint F F7): 7 类 cross-check 错误的查看 / 解决 / 联动 departure-sync 审计。
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ShieldAlert } from 'lucide-vue-next'

import AppLayout from '@/layouts/AppLayout.vue'
import Button from '@/components/ui/button.vue'
import Drawer from '@/components/ui/drawer.vue'
import Label from '@/components/ui/label.vue'
import StatusBadge from '@/components/ui/status-badge.vue'
import TabularNumber from '@/components/ui/tabular-number.vue'
import DataTable from '@/components/v2/DataTable.vue'
import {
  fetchDepartureSyncAudit,
  fetchErrors,
  resolveError,
  runCrossCheck,
  runDepartureSync,
} from '@/api/v2/errors'

const route = useRoute()
const workspaceKey = computed(() => String(route.params.workspaceKey || ''))

// 7 条 cross-check 规则
const RULE_TYPES = Object.freeze([
  { id: 'GC_DATE_WINDOW',     label: '日期窗',   severity: 'high' },
  { id: 'GC_RECEIPT_LEN',     label: '小票位数', severity: 'high' },
  { id: 'GC_TOUR_LEN',        label: '团号位数', severity: 'high' },
  { id: 'BILL_MODE_ENUM',     label: '模式枚举', severity: 'medium' },
  { id: 'BILL_SHOP_ENUM',     label: '店族枚举', severity: 'high' },
  { id: 'CC_DEPARTURE_SYNC',  label: '离境日期', severity: 'high' },
  { id: 'CC_NAME_PASSPORT',   label: '小票/护照', severity: 'high' },
])

const errorType = ref('')
const status = ref('open')
const rows = ref([])
const summary = ref([])     // [{ error_type, status, count }]
const audit = reactive({ rows: [], total: 0 })
const showAudit = ref(false)
const loading = ref(false)
const auditLoading = ref(false)
const actionLoading = ref('')   // 'cross-check' | 'cross-check-sync' | 'departure-sync' | `resolve:${id}`
const errorMsg = ref('')
const successMsg = ref('')

// 解决 Drawer
const resolveTarget = ref(null)
const resolveNote = ref('')

const summaryMap = computed(() => {
  const out = {}
  for (const row of summary.value || []) out[`${row.error_type}-${row.status}`] = Number(row.count || 0)
  return out
})
function openCount(id)     { return summaryMap.value[`${id}-open`] || 0 }
function resolvedCount(id) { return summaryMap.value[`${id}-resolved`] || 0 }
const totalOpen = computed(() => RULE_TYPES.reduce((s, r) => s + openCount(r.id), 0))

const tableColumns = [
  { key: 'errorType',    label: '类型',     width: '160px',
    format: (r) => r.errorType || r.error_type || '—' },
  { key: 'severity',     label: '严重度',   width: '70px' },
  { key: 'storeFamily',  label: '店族',     width: '90px' },
  { key: 'tourNo',       label: '团号',     width: '110px' },
  { key: 'receiptNo',    label: '小票号',   width: '120px' },
  { key: 'passportNo',   label: '护照',     width: '100px' },
  { key: 'name',         label: '姓名' },
  { key: 'expectedValue', label: '期望' },
  { key: 'actualValue',   label: '实际' },
  { key: 'status',        label: '状态',    width: '80px' },
  { key: 'actions',       label: '操作',    align: 'right', width: '90px' },
]

const auditColumns = [
  { key: 'triggeredAt', label: '时间',   width: '160px' },
  { key: 'passportNo',  label: '护照',   width: '100px' },
  { key: 'name',        label: '姓名' },
  { key: 'receiptNo',   label: '小票号', width: '120px' },
  { key: 'beforeValue', label: '原值' },
  { key: 'afterValue',  label: '同步到' },
  { key: 'triggeredBy', label: '触发人', width: '90px' },
]

async function load() {
  if (!workspaceKey.value) return
  loading.value = true
  errorMsg.value = ''
  try {
    const payload = await fetchErrors(workspaceKey.value, {
      errorType: errorType.value || undefined,
      status:    status.value     || undefined,
    })
    rows.value = payload?.rows || []
    summary.value = payload?.summary || []
  } catch (error) {
    errorMsg.value = decodeError(error, '加载错误记录失败')
  } finally {
    loading.value = false
  }
}

async function loadAudit() {
  if (!workspaceKey.value) return
  auditLoading.value = true
  try {
    const payload = await fetchDepartureSyncAudit(workspaceKey.value, { limit: 200 })
    audit.rows = payload?.rows || []
    audit.total = Number(payload?.total || audit.rows.length)
  } catch (error) {
    errorMsg.value = decodeError(error, '加载审计日志失败')
  } finally {
    auditLoading.value = false
  }
}

async function handleCrossCheck({ withDepartureSync = false } = {}) {
  if (!workspaceKey.value || actionLoading.value) return
  actionLoading.value = withDepartureSync ? 'cross-check-sync' : 'cross-check'
  errorMsg.value = ''
  try {
    const r = await runCrossCheck(workspaceKey.value, { withDepartureSync })
    const parts = [`共 ${r?.totalErrors ?? 0} 条错误`]
    if (r?.departureSync?.rewritten) parts.push(`已同步 ${r.departureSync.rewritten} 行出境日期`)
    flashSuccess(parts.join(' · '))
    await load()
    if (showAudit.value) await loadAudit()
  } catch (error) {
    errorMsg.value = decodeError(error, 'cross-check 失败')
  } finally {
    actionLoading.value = ''
  }
}

async function handleDepartureSync() {
  if (!workspaceKey.value || actionLoading.value) return
  if (!window.confirm('把出境日期不一致的账单同步到最晚一次?会写 departure_sync_audit。')) return
  actionLoading.value = 'departure-sync'
  errorMsg.value = ''
  try {
    const r = await runDepartureSync(workspaceKey.value)
    flashSuccess(`已同步 ${r?.rewritten ?? 0} 行`)
    await load()
    if (showAudit.value) await loadAudit()
  } catch (error) {
    errorMsg.value = decodeError(error, 'departure-sync 失败')
  } finally {
    actionLoading.value = ''
  }
}

async function toggleAudit() {
  showAudit.value = !showAudit.value
  if (showAudit.value && !audit.rows.length) await loadAudit()
}

function openResolve(row) { resolveTarget.value = row; resolveNote.value = '' }
function closeResolve() { resolveTarget.value = null; resolveNote.value = '' }
async function confirmResolve() {
  if (!resolveTarget.value) return
  const id = resolveTarget.value.id
  actionLoading.value = `resolve:${id}`
  errorMsg.value = ''
  try {
    await resolveError(workspaceKey.value, id, resolveNote.value || '')
    flashSuccess(`已标记 #${id} 为已解决`)
    closeResolve()
    await load()
  } catch (error) {
    errorMsg.value = decodeError(error, '标记失败')
  } finally {
    actionLoading.value = ''
  }
}

function filterByType(id) { errorType.value = errorType.value === id ? '' : id; load() }

function decodeError(error, fallback) {
  const data = error?.response?.data || {}
  if (data.code === 'WORKSPACE_LOCKED') return '月份已锁,无法修改'
  if (data.code === 'PIPELINE_LOCKED') return `流水线被 ${data.runningStage || '其他任务'} 占用`
  if (data.code === 'service_unavailable') return `${data.service || '服务'} 不可用 (503)`
  return data.error || error?.message || fallback
}
function flashSuccess(text, ms = 4500) {
  successMsg.value = text
  setTimeout(() => { if (successMsg.value === text) successMsg.value = '' }, ms)
}

onMounted(load)
watch(workspaceKey, () => { audit.rows = []; load() })
</script>

<template>
  <AppLayout :workspace-key="workspaceKey">
    <div class="min-w-0 space-y-5 overflow-x-hidden">
      <header class="flex flex-wrap items-center gap-3 px-1">
        <ShieldAlert class="h-6 w-6 text-primary" />
        <div class="flex-1">
          <h1 class="text-xl font-medium text-foreground">错表 v2</h1>
          <p class="text-sm text-muted-foreground">
            workspace · <span class="font-mono">{{ workspaceKey }}</span> ·
            open <TabularNumber :value="totalOpen" /> 条 / 共 7 条规则。点卡片可筛选。
          </p>
        </div>
        <Button
          variant="outline" size="sm" :disabled="!!actionLoading"
          @click="handleCrossCheck({ withDepartureSync: false })"
        >
          {{ actionLoading === 'cross-check' ? '检查中…' : '只检测' }}
        </Button>
        <Button
          variant="default" size="sm" :disabled="!!actionLoading"
          @click="handleCrossCheck({ withDepartureSync: true })"
        >
          {{ actionLoading === 'cross-check-sync' ? '检查+同步中…' : '检测 + 同步离境' }}
        </Button>
        <Button
          variant="outline" size="sm" :disabled="!!actionLoading"
          @click="handleDepartureSync"
        >
          {{ actionLoading === 'departure-sync' ? '同步中…' : '只同步离境' }}
        </Button>
        <Button variant="ghost" size="sm" @click="toggleAudit">
          {{ showAudit ? '隐藏审计' : '查看审计' }}
        </Button>
      </header>

      <div v-if="errorMsg" class="rounded-lg border border-status-error/30 bg-status-error/10 px-4 py-2 text-sm text-status-error">{{ errorMsg }}</div>
      <div v-else-if="successMsg" class="rounded-lg border border-status-ok/30 bg-status-ok/10 px-4 py-2 text-sm text-status-ok">{{ successMsg }}</div>

      <!-- 7 类规则汇总卡 (可点筛选) -->
      <section class="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        <button
          v-for="rule in RULE_TYPES" :key="rule.id"
          type="button"
          class="rounded-lg border bg-card p-3 text-left shadow-sm transition hover:border-primary"
          :class="[
            errorType === rule.id ? 'border-primary ring-2 ring-primary/30' : 'border-border',
            openCount(rule.id) === 0 ? 'opacity-60' : '',
          ]"
          @click="filterByType(rule.id)"
        >
          <div class="flex items-center gap-1">
            <span :class="rule.severity === 'high' ? 'text-status-error' : 'text-status-warn'">●</span>
            <span class="text-xs font-medium text-foreground">{{ rule.label }}</span>
          </div>
          <p class="mt-1 font-mono text-[10px] text-muted-foreground">{{ rule.id }}</p>
          <div class="mt-2 flex items-baseline gap-2">
            <TabularNumber :value="openCount(rule.id)" class="text-xl font-medium" />
            <span v-if="resolvedCount(rule.id)" class="text-xs text-muted-foreground">/ {{ resolvedCount(rule.id) }} 已解</span>
          </div>
        </button>
      </section>

      <!-- 筛选 -->
      <section class="rounded-lg border border-border bg-card p-3 shadow-sm">
        <div class="flex flex-wrap items-end gap-3">
          <div class="flex flex-col gap-1">
            <Label class="text-xs">类型</Label>
            <select v-model="errorType" class="h-8 rounded-md border border-input bg-background px-2 text-sm" @change="load">
              <option value="">全部类型</option>
              <option v-for="t in RULE_TYPES" :key="t.id" :value="t.id">{{ t.label }} · {{ t.id }}</option>
            </select>
          </div>
          <div class="flex flex-col gap-1">
            <Label class="text-xs">状态</Label>
            <select v-model="status" class="h-8 rounded-md border border-input bg-background px-2 text-sm" @change="load">
              <option value="open">open</option>
              <option value="resolved">resolved</option>
              <option value="">全部</option>
            </select>
          </div>
          <Button variant="ghost" size="sm" class="ml-auto" :disabled="loading" @click="load">刷新</Button>
        </div>
      </section>

      <DataTable
        :columns="tableColumns" :rows="rows" :loading="loading"
        :total="rows.length" :limit="rows.length || 1" :offset="0"
        empty-text="没有匹配的错误记录"
      >
        <template #cell-severity="{ row }">
          <StatusBadge :variant="row.severity === 'high' ? 'error' : row.severity === 'medium' ? 'warn' : 'info'" size="sm">
            {{ row.severity || '—' }}
          </StatusBadge>
        </template>
        <template #cell-status="{ row }">
          <StatusBadge :variant="row.status === 'resolved' ? 'ok' : 'warn'" size="sm">{{ row.status }}</StatusBadge>
        </template>
        <template #cell-actions="{ row }">
          <Button
            v-if="row.status === 'open'" size="sm" variant="outline"
            :disabled="actionLoading === `resolve:${row.id}`"
            @click="openResolve(row)"
          >
            标记解决
          </Button>
        </template>
      </DataTable>

      <!-- 审计面板 -->
      <section v-if="showAudit" class="space-y-2">
        <div class="flex items-center justify-between px-1">
          <h2 class="text-sm font-medium text-foreground">出境日期同步审计 · {{ audit.total }} 条</h2>
          <Button variant="ghost" size="sm" :disabled="auditLoading" @click="loadAudit">刷新</Button>
        </div>
        <DataTable
          :columns="auditColumns" :rows="audit.rows" :loading="auditLoading"
          :total="audit.rows.length" :limit="audit.rows.length || 1" :offset="0"
          empty-text="尚无同步记录"
        >
          <template #cell-beforeValue="{ row }">
            <span class="text-status-error line-through">{{ row.beforeValue || '—' }}</span>
          </template>
          <template #cell-afterValue="{ row }">
            <span class="font-medium text-status-ok">{{ row.afterValue || '—' }}</span>
          </template>
        </DataTable>
      </section>

      <!-- 标记解决 Drawer -->
      <Drawer :open="!!resolveTarget" @update:open="(v) => !v && closeResolve()">
        <div v-if="resolveTarget" class="flex h-full flex-col">
          <header class="border-b border-border pb-3">
            <h2 class="text-lg font-medium text-foreground">标记错误 #{{ resolveTarget.id }} 为已解决</h2>
            <p class="mt-1 text-xs font-mono text-muted-foreground">
              {{ resolveTarget.errorType }} · 期望 {{ resolveTarget.expectedValue || '—' }} · 实际 {{ resolveTarget.actualValue || '—' }}
            </p>
          </header>
          <div class="flex-1 space-y-3 overflow-y-auto py-4">
            <div>
              <Label class="text-xs">备注 (可留空)</Label>
              <textarea
                v-model="resolveNote" rows="4"
                class="mt-1 w-full rounded-md border border-input bg-background p-2 text-sm"
                placeholder="例如:店家口头确认正确日期,由 XX 改"
              />
            </div>
            <p class="text-xs text-muted-foreground">标记后该条会从 open 移到 resolved;若 cross-check 再次发现仍异常,会重新出现。</p>
          </div>
          <footer class="flex justify-end gap-2 border-t border-border pt-3">
            <Button variant="ghost" size="sm" @click="closeResolve">取消</Button>
            <Button variant="default" size="sm" :disabled="actionLoading.startsWith('resolve:')" @click="confirmResolve">确认解决</Button>
          </footer>
        </div>
      </Drawer>
    </div>
  </AppLayout>
</template>
