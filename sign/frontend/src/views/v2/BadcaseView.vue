<script setup>
// v2 BadcaseView (Sprint F F9b): 匹配阶段"非完美"决定的快照池。
// 审核员标 verdict + 备注,开发回头按 verdict=wrong_match 调规则。
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { Bug } from 'lucide-vue-next'

import AppLayout from '@/layouts/AppLayout.vue'
import Button from '@/components/ui/button.vue'
import Drawer from '@/components/ui/drawer.vue'
import Input from '@/components/ui/input.vue'
import Label from '@/components/ui/label.vue'
import StatusBadge from '@/components/ui/status-badge.vue'
import TabularNumber from '@/components/ui/tabular-number.vue'
import DataTable from '@/components/v2/DataTable.vue'
import {
  fetchBadcaseDetail,
  fetchBadcaseSummary,
  fetchBadcases,
  submitBadcaseVerdict,
} from '@/api/v2/badcases'
import { REMEDY_KIND, STAGE, BADCASE_VERDICT } from '@/lib/statusLabels'

const route = useRoute()
const workspaceKey = computed(() => String(route.params.workspaceKey || ''))

const ALL_VERDICTS = ['pending', 'wrong_match', 'should_match', 'acceptable']
const VERDICT_LABEL = BADCASE_VERDICT // 统一字典
const VERDICT_VARIANT = { pending: 'warn', wrong_match: 'error', should_match: 'info', acceptable: 'ok' }

const filter = reactive({ stage: '', kind: '', verdict: '', ruleVersion: '' })
const limit = ref(100)
const offset = ref(0)
const rows = ref([])
const total = ref(0)
const summary = ref({ byStageKind: [], byVerdict: [] })
const loading = ref(false)
const errorMsg = ref('')
const successMsg = ref('')

// 详情 Drawer
const selected = ref(null)
const detailLoading = ref(false)
const actionLoading = ref('')
const noteDraft = ref('')
const verdictDraft = ref('pending')

const columns = [
  { key: 'id',          label: '#',      width: '60px',  format: (r) => `#${r.id}` },
  { key: 'stage',       label: '阶段',   width: '100px' },
  { key: 'kind',        label: '类型',   width: '140px' },
  { key: 'keys',        label: '关键字段' },
  { key: 'userVerdict', label: 'verdict', width: '110px' },
  { key: 'ruleVersion', label: '规则版本' },
  { key: 'createdAt',   label: '创建',   width: '160px',
    format: (r) => r.createdAt ? new Date(r.createdAt).toLocaleString('zh-CN') : '—' },
  { key: 'actions',     label: '操作',   align: 'right', width: '110px' },
]

async function load() {
  if (!workspaceKey.value) return
  loading.value = true
  errorMsg.value = ''
  try {
    const [list, s] = await Promise.all([
      fetchBadcases(workspaceKey.value, {
        stage:       filter.stage       || undefined,
        kind:        filter.kind        || undefined,
        verdict:     filter.verdict     || undefined,
        ruleVersion: filter.ruleVersion || undefined,
        limit: limit.value, offset: offset.value,
      }),
      fetchBadcaseSummary(workspaceKey.value).catch(() => ({ byStageKind: [], byVerdict: [] })),
    ])
    rows.value = list?.rows || []
    total.value = Number(list?.total || 0)
    summary.value = s || { byStageKind: [], byVerdict: [] }
  } catch (error) {
    errorMsg.value = decodeError(error, '加载 badcase 失败')
  } finally {
    loading.value = false
  }
}

async function openDetail(row) {
  selected.value = row
  noteDraft.value = row.userNote || ''
  verdictDraft.value = row.userVerdict || 'pending'
  detailLoading.value = true
  try {
    selected.value = await fetchBadcaseDetail(workspaceKey.value, row.id)
  } catch (error) {
    errorMsg.value = decodeError(error, '加载详情失败')
  } finally {
    detailLoading.value = false
  }
}
function closeDetail() {
  selected.value = null
  noteDraft.value = ''
  verdictDraft.value = 'pending'
}

async function submitVerdict() {
  if (!selected.value) return
  const id = selected.value.id
  actionLoading.value = `verdict:${id}`
  errorMsg.value = ''
  try {
    await submitBadcaseVerdict(workspaceKey.value, id, {
      userNote: noteDraft.value || null,
      userVerdict: verdictDraft.value,
    })
    flashSuccess(`#${id} → ${VERDICT_LABEL[verdictDraft.value]}`)
    closeDetail()
    await load()
  } catch (error) {
    errorMsg.value = decodeError(error, '提交失败')
  } finally {
    actionLoading.value = ''
  }
}

function applyFilter() { offset.value = 0; load() }
function prev() { if (offset.value >= limit.value) { offset.value -= limit.value; load() } }
function next() { if (offset.value + limit.value < total.value) { offset.value += limit.value; load() } }

function decodeError(error, fallback) {
  const data = error?.response?.data || {}
  if (data.code === 'WORKSPACE_LOCKED') return '月份已锁,无法修改'
  if (data.code === 'service_unavailable') return `${data.service || '服务'} 不可用 (503)`
  return data.error || error?.message || fallback
}
function flashSuccess(text, ms = 3500) {
  successMsg.value = text
  setTimeout(() => { if (successMsg.value === text) successMsg.value = '' }, ms)
}

// G8b(I4): 客户端 csv 导出当前 rows (受当前 filter 影响)
// 字段固定为 id/stage/kind/receiptNo/tourNo/passportNo/userVerdict/ruleVersion/createdAt/userNote
function escapeCsv(v) {
  if (v == null) return ''
  const s = String(v).replace(/"/g, '""')
  return /[,"\n\r]/.test(s) ? `"${s}"` : s
}
function exportCsv() {
  const cols = ['id', 'stage', 'kind', 'receiptNo', 'tourNo', 'passportNo',
                'userVerdict', 'ruleVersion', 'createdAt', 'userNote']
  const head = cols.join(',')
  const body = rows.value.map((r) => cols.map((c) => escapeCsv(r[c])).join(',')).join('\n')
  const tag = [filter.verdict, filter.kind, filter.stage].filter(Boolean).join('_') || 'all'
  const blob = new Blob(['\uFEFF' + head + '\n' + body], { type: 'text/csv;charset=utf-8' })  // BOM for Excel
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `badcases_${workspaceKey.value}_${tag}_${rows.value.length}行.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  flashSuccess(`已导出 ${rows.value.length} 行`)
}

onMounted(load)
watch(workspaceKey, () => { offset.value = 0; load() })
</script>

<template>
  <AppLayout :workspace-key="workspaceKey">
    <div class="min-w-0 space-y-5 overflow-x-hidden">
      <header class="flex items-center gap-3 px-1">
        <Bug class="h-6 w-6 text-primary" />
        <div class="flex-1">
          <h1 class="text-xl font-medium text-foreground">Badcase v2</h1>
          <p class="text-sm text-muted-foreground">
            workspace · <span class="font-mono">{{ workspaceKey }}</span> ·
            匹配阶段"非完美"决定的反馈池 · 共 <TabularNumber :value="total" /> 条
          </p>
        </div>
        <!-- G8b(I4): 客户端 csv 导出 — 按当前筛选条件(verdict=wrong_match 是开发最常拉的) -->
        <Button variant="outline" size="sm" :disabled="loading || !rows.length" @click="exportCsv">导出 csv</Button>
        <Button variant="ghost" size="sm" :disabled="loading" @click="load">刷新</Button>
      </header>

      <div v-if="errorMsg" class="rounded-lg border border-status-error/30 bg-status-error/10 px-4 py-2 text-sm text-status-error">{{ errorMsg }}</div>
      <div v-else-if="successMsg" class="rounded-lg border border-status-ok/30 bg-status-ok/10 px-4 py-2 text-sm text-status-ok">{{ successMsg }}</div>

      <!-- 统计两栏 -->
      <section class="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div class="rounded-lg border border-border bg-card p-3 shadow-sm">
          <h3 class="text-xs font-medium text-muted-foreground">按阶段 + 类型</h3>
          <ul v-if="summary.byStageKind?.length" class="mt-2 space-y-1 text-sm">
            <li v-for="g in summary.byStageKind" :key="`${g.stage}-${g.kind}`" class="flex items-baseline justify-between gap-2">
              <span><code class="font-mono text-xs">{{ g.stage }}</code> / {{ g.kind }}</span>
              <TabularNumber :value="g.n" class="font-medium" />
            </li>
          </ul>
          <p v-else class="mt-2 text-xs text-muted-foreground">暂无</p>
        </div>
        <div class="rounded-lg border border-border bg-card p-3 shadow-sm">
          <h3 class="text-xs font-medium text-muted-foreground">按 verdict</h3>
          <ul v-if="summary.byVerdict?.length" class="mt-2 space-y-1 text-sm">
            <li v-for="g in summary.byVerdict" :key="g.verdict || 'null'" class="flex items-baseline justify-between gap-2">
              <StatusBadge :variant="VERDICT_VARIANT[g.verdict] || 'neutral'" size="sm">{{ VERDICT_LABEL[g.verdict] || g.verdict || '未处理' }}</StatusBadge>
              <TabularNumber :value="g.n" class="font-medium" />
            </li>
          </ul>
          <p v-else class="mt-2 text-xs text-muted-foreground">暂无</p>
        </div>
      </section>

      <!-- 筛选条 -->
      <section class="rounded-lg border border-border bg-card p-3 shadow-sm">
        <div class="flex flex-wrap items-end gap-3">
          <div class="flex flex-col gap-1">
            <Label class="text-xs">阶段</Label>
            <select v-model="filter.stage" class="h-8 rounded-md border border-input bg-background px-2 text-sm">
              <option value="">全部</option><option v-for="s in ['tour_match','bill_match','manual']" :key="s" :value="s">{{ STAGE[s] || s }}</option>
            </select>
          </div>
          <div class="flex flex-col gap-1">
            <Label class="text-xs">类型</Label>
            <select v-model="filter.kind" class="h-8 rounded-md border border-input bg-background px-2 text-sm">
              <option value="">全部</option>
              <option v-for="k in ['tour_not_found','agent_mismatch','mode_unresolved','ambiguous_match','fuzzy_match','field_conflict','unmatched']" :key="k" :value="k">{{ REMEDY_KIND[k] || k }}</option>
            </select>
          </div>
          <div class="flex flex-col gap-1">
            <Label class="text-xs">verdict</Label>
            <select v-model="filter.verdict" class="h-8 rounded-md border border-input bg-background px-2 text-sm">
              <option value="">全部</option>
              <option v-for="v in ALL_VERDICTS" :key="v" :value="v">{{ VERDICT_LABEL[v] }}</option>
            </select>
          </div>
          <div class="flex flex-col gap-1">
            <Label class="text-xs">rule_version</Label>
            <Input v-model="filter.ruleVersion" placeholder="2026-05-11-rule-set-v2" class="h-8 w-56" @keydown.enter.prevent="applyFilter" />
          </div>
          <Button variant="default" size="sm" class="ml-auto" @click="applyFilter">应用</Button>
          <Button variant="ghost" size="sm" @click="() => { filter.stage=''; filter.kind=''; filter.verdict=''; filter.ruleVersion=''; applyFilter() }">重置</Button>
        </div>
      </section>

      <DataTable
        :columns="columns" :rows="rows" :loading="loading"
        :total="total" :limit="limit" :offset="offset"
        empty-text="暂无 badcase"
        @prev="prev" @next="next"
      >
        <template #cell-stage="{ row }"><code class="font-mono text-xs">{{ row.stage }}</code></template>
        <template #cell-keys="{ row }">
          <div class="space-y-0.5 text-[11px] text-muted-foreground">
            <div v-if="row.receiptNo">小票: <code class="font-mono">{{ row.receiptNo }}</code></div>
            <div v-if="row.tourNo">团号: <code class="font-mono">{{ row.tourNo }}</code></div>
            <div v-if="row.passportNo">护照: <code class="font-mono">{{ row.passportNo }}</code></div>
          </div>
        </template>
        <template #cell-userVerdict="{ row }">
          <StatusBadge :variant="VERDICT_VARIANT[row.userVerdict] || 'neutral'" size="sm">
            {{ VERDICT_LABEL[row.userVerdict] || row.userVerdict || '未处理' }}
          </StatusBadge>
        </template>
        <template #cell-ruleVersion="{ row }"><code class="font-mono text-[11px]">{{ row.ruleVersion || '—' }}</code></template>
        <template #cell-actions="{ row }">
          <Button size="sm" variant="outline" @click="openDetail(row)">查看 / 标记</Button>
        </template>
      </DataTable>

      <!-- 详情 Drawer -->
      <Drawer :open="!!selected" @update:open="(v) => !v && closeDetail()">
        <div v-if="selected" class="flex h-full flex-col">
          <header class="border-b border-border pb-3">
            <h2 class="text-lg font-medium text-foreground">Badcase #{{ selected.id }}</h2>
            <p class="mt-1 text-xs font-mono text-muted-foreground">
              {{ selected.stage }} / {{ selected.kind }} · 规则版本 {{ selected.ruleVersion || '—' }}
            </p>
          </header>
          <div class="flex-1 space-y-3 overflow-y-auto py-4">
            <p v-if="detailLoading" class="text-xs text-muted-foreground">加载中…</p>
            <template v-else>
              <p class="text-sm">受影响行:daily #{{ selected.dailyReceiptId || '—' }} · bill #{{ selected.storeBillId || '—' }}</p>
              <details v-if="selected.snapshot" open class="text-xs">
                <summary class="cursor-pointer text-muted-foreground">现场快照</summary>
                <pre class="mt-2 max-h-72 overflow-auto rounded bg-muted/50 p-2 font-mono text-[11px]">{{ JSON.stringify(selected.snapshot, null, 2) }}</pre>
              </details>
              <div>
                <Label class="text-xs">verdict</Label>
                <select v-model="verdictDraft" class="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm">
                  <option v-for="v in ALL_VERDICTS" :key="v" :value="v">{{ VERDICT_LABEL[v] }}</option>
                </select>
              </div>
              <div>
                <Label class="text-xs">备注</Label>
                <textarea
                  v-model="noteDraft" rows="4"
                  class="mt-1 w-full rounded-md border border-input bg-background p-2 text-sm"
                  placeholder="例:当前规则把团号当 LOTTE 8 位处理,实际是 SHILLA 5 位"
                />
              </div>
            </template>
          </div>
          <footer class="flex justify-end gap-2 border-t border-border pt-3">
            <Button variant="ghost" size="sm" @click="closeDetail">关闭</Button>
            <Button variant="default" size="sm" :disabled="actionLoading.startsWith('verdict:')" @click="submitVerdict">提交 verdict</Button>
          </footer>
        </div>
      </Drawer>
    </div>
  </AppLayout>
</template>
