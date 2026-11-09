<script setup>
// v2 LogsView (Sprint F F9a): stage_jobs 历史 (tour-match / bill-match / merge / second_pass / export / ...)
// 简化版:替代 v1 复杂的 timeline UI,用 DataTable 看每条 job 的 stage/status/operator/timing/stats。
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ScrollText } from 'lucide-vue-next'

import AppLayout from '@/layouts/AppLayout.vue'
import Button from '@/components/ui/button.vue'
import Label from '@/components/ui/label.vue'
import StatusBadge from '@/components/ui/status-badge.vue'
import TabularNumber from '@/components/ui/tabular-number.vue'
import DataTable from '@/components/v2/DataTable.vue'
import {
  fetchRunningStageJobs,
  fetchStageJobs,
  stageJobLogUrl,
} from '@/api/v2/listings'

const route = useRoute()
const workspaceKey = computed(() => String(route.params.workspaceKey || ''))

const filter = reactive({ stage: '', status: '' })
const limit = ref(50)
const offset = ref(0)
const rows = ref([])
const total = ref(0)
const running = ref([])
const loading = ref(false)
const errorMsg = ref('')

// G6 live-probe: 后端实际 status 是 'succeeded' (不是 'success'); 全列出
const STATUS_VARIANT = {
  succeeded: 'ok', success: 'ok', completed: 'ok', done: 'ok',
  running: 'info', queued: 'info', pending: 'info',
  failed: 'error', error: 'error',
  cancelled: 'warn', force_finished: 'warn', skipped: 'warn',
}

const columns = [
  { key: 'id',         label: '#',      width: '60px',
    format: (r) => `#${r.id}` },
  { key: 'stage',      label: 'Stage',  width: '130px' },
  { key: 'status',     label: '状态',   width: '90px' },
  { key: 'operator',   label: '操作人', width: '110px',
    format: (r) => r.operator || '—' },
  { key: 'startedAt',  label: '开始',   width: '160px',
    format: (r) => r.startedAt ? new Date(r.startedAt).toLocaleString('zh-CN') : '—' },
  { key: 'finishedAt', label: '结束',   width: '160px',
    format: (r) => r.finishedAt ? new Date(r.finishedAt).toLocaleString('zh-CN') : '—' },
  { key: 'stats',      label: '摘要',
    format: (r) => summarizeStats(r) },
  { key: 'log',        label: '日志',   align: 'right', width: '80px' },
]

// G6 live-probe: stage_job.stats 实际字段为
//   inserted / skipped / matched / unmatched / unreceived
//   skippedNoFolder / skippedBillNoFolder / deletedExisting (merge 专属)
//   folderBreakdown: { '乐天首尔':N, '爱宝客':N, ... }
// 之前用的 merged / processed 是猜的,不存在。
function summarizeStats(job) {
  const s = job?.stats || {}
  const parts = []
  if (Number.isFinite(s.inserted))   parts.push(`inserted ${s.inserted}`)
  if (Number.isFinite(s.matched))    parts.push(`matched ${s.matched}`)
  if (Number.isFinite(s.unmatched))  parts.push(`unmatched ${s.unmatched}`)
  if (Number.isFinite(s.unreceived)) parts.push(`unreceived ${s.unreceived}`)
  if (Number.isFinite(s.skipped) && s.skipped) parts.push(`skip ${s.skipped}`)
  // 0729 静默排查:这三个「因归不了桶而被丢出合并」的计数,字段在上面的注释里躺了很久,
  // 但全站没有任何组件读它 —— 行从 monthly_data 里消失,零痕迹。
  // 多数情况下它是**对的**(那些渠道本就不走四桶交付),但"本该如此"和"归类坏了"
  // 长得一模一样,不显示就永远分不出来。
  // 两类分开显示:NoFolder=真的归不出来(要有人去配模式映射);
  // OutOfScope=百货等本就不走四桶的正常越界(只备查,最终核对页不拿它提醒人)。
  // 生产实测 2026-08:2883 行里 2823 行属后者,混成一个数字会把真信号淹掉。
  const noFolder = (Number(s.skippedNoFolder) || 0)
    + (Number(s.skippedBillNoFolder) || 0)
    + (Number(s.skippedBrandNoFolder) || 0)
  if (noFolder) parts.push(`未归桶丢弃 ${noFolder}`)
  const outOfScope = (Number(s.skippedBillOutOfScope) || 0) + (Number(s.skippedBrandOutOfScope) || 0)
  if (outOfScope) parts.push(`越界跳过 ${outOfScope}(百货等,正常)`)
  if (Number.isFinite(s.fetchFailed) && s.fetchFailed) parts.push(`取行失败 ${s.fetchFailed}`)
  if (s.folderBreakdown && typeof s.folderBreakdown === 'object') {
    const fb = Object.entries(s.folderBreakdown).map(([k, v]) => `${k}:${v}`).join(',')
    if (fb) parts.push(`[${fb}]`)
  }
  if (job?.errorMessage) parts.push(`err: ${String(job.errorMessage).slice(0, 80)}`)
  return parts.join(' · ') || '—'
}

async function load() {
  if (!workspaceKey.value) return
  loading.value = true
  errorMsg.value = ''
  try {
    const [jobsPayload, runningPayload] = await Promise.all([
      fetchStageJobs(workspaceKey.value, {
        stage:  filter.stage  || undefined,
        status: filter.status || undefined,
        limit:  limit.value,
        offset: offset.value,
      }),
      fetchRunningStageJobs(workspaceKey.value).catch(() => ({ rows: [] })),
    ])
    rows.value = jobsPayload?.rows || []
    total.value = Number(jobsPayload?.total || 0)
    running.value = runningPayload?.rows || []
  } catch (error) {
    const data = error?.response?.data || {}
    errorMsg.value = data.code === 'service_unavailable'
      ? `${data.service || '服务'} 不可用 (503)`
      : data.error || error?.message || '加载失败'
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
        <ScrollText class="h-6 w-6 text-primary" />
        <div class="flex-1">
          <h1 class="text-xl font-medium text-foreground">操作日志 v2</h1>
          <p class="text-sm text-muted-foreground">
            workspace · <span class="font-mono">{{ workspaceKey }}</span> ·
            共 <TabularNumber :value="total" /> 条 stage_job 记录
          </p>
        </div>
        <Button variant="ghost" size="sm" :disabled="loading" @click="load">刷新</Button>
      </header>

      <div v-if="errorMsg" class="rounded-lg border border-status-error/30 bg-status-error/10 px-4 py-2 text-sm text-status-error">{{ errorMsg }}</div>

      <!-- 正在运行的 stage -->
      <div v-if="running.length" class="rounded-lg border border-status-info/30 bg-status-info/5 px-4 py-2 text-sm">
        <StatusBadge variant="info" size="sm" dot class="mr-2">运行中</StatusBadge>
        <span v-for="(job, i) in running" :key="job.id">
          <code class="font-mono text-xs">{{ job.stage }}</code> #{{ job.id }} ({{ job.operator || 'system' }})<span v-if="i < running.length - 1"> · </span>
        </span>
      </div>

      <section class="rounded-lg border border-border bg-card p-3 shadow-sm">
        <div class="flex flex-wrap items-end gap-3">
          <div class="flex flex-col gap-1">
            <Label class="text-xs">Stage</Label>
            <select v-model="filter.stage" class="h-8 rounded-md border border-input bg-background px-2 text-sm">
              <option value="">全部</option>
              <!-- G6: stage_job 只记 4 stage (import 在 import_job 表) -->
              <option v-for="s in ['tour_match','bill_match','merge','second_pass','export']" :key="s" :value="s">{{ s }}</option>
            </select>
          </div>
          <div class="flex flex-col gap-1">
            <Label class="text-xs">状态</Label>
            <select v-model="filter.status" class="h-8 rounded-md border border-input bg-background px-2 text-sm">
              <option value="">全部</option>
              <!-- G6: 后端用 succeeded 不是 success -->
              <option v-for="s in ['succeeded','running','failed','cancelled','queued']" :key="s" :value="s">{{ s }}</option>
            </select>
          </div>
          <Button variant="default" size="sm" class="ml-auto" @click="applyFilter">应用</Button>
          <Button variant="ghost" size="sm" @click="() => { filter.stage = ''; filter.status = ''; applyFilter() }">重置</Button>
        </div>
      </section>

      <DataTable
        :columns="columns" :rows="rows" :loading="loading"
        :total="total" :limit="limit" :offset="offset"
        empty-text="当前月份还没有 stage_job 记录"
        @prev="prev" @next="next"
      >
        <template #cell-stage="{ row }">
          <code class="font-mono text-xs">{{ row.stage }}</code>
        </template>
        <template #cell-status="{ row }">
          <StatusBadge :variant="STATUS_VARIANT[row.status] || 'neutral'" size="sm">{{ row.status }}</StatusBadge>
        </template>
        <template #cell-log="{ row }">
          <a
            :href="stageJobLogUrl(workspaceKey, row.id)" target="_blank" rel="noopener"
            class="text-xs text-primary hover:underline"
          >下载</a>
        </template>
      </DataTable>
    </div>
  </AppLayout>
</template>
