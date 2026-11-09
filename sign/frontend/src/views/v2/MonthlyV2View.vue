<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ClipboardList,
  FileSpreadsheet,
  ListChecks,
  ReceiptText,
  RefreshCw,
  SearchCheck,
} from 'lucide-vue-next'
import AppLayout from '@/layouts/AppLayout.vue'
import MonthlyHeader from '@/components/v2/MonthlyHeader.vue'
import RowHistoryDrawer from '@/components/v2/RowHistoryDrawer.vue'
import StatusBadge from '@/components/ui/status-badge.vue'
import { getMonthly } from '@/mocks/v2'
import { fetchMonthlyOverview } from '@/api/v2/monthly'
import { createMonthlyWorkspace, fetchMonthlyWorkspaces } from '@/api/monthly'
import { runMerge } from '@/api/v2/stages'
import { mapOverviewToMonthlyV2 } from '@/lib/v2/derive_overview'
import { reviewReasonLabel } from '@/lib/reviewReasons'
import { allowV2MockFallback, v2MockFallbackLabel, v2MockFallbackVariant } from '@/lib/v2/mock_fallback'

const route = useRoute()
const router = useRouter()

const initialKey = String(route.params.workspaceKey || 'latest')
const activeWorkspace = ref(initialKey === 'latest' ? '' : initialKey)
const apiData = ref(null)
const apiFailed = ref(false)
const apiError = ref('')
const isLoading = ref(false)
const workspaceMissing = ref(false)
const creatingWorkspace = ref(false)
const workspaces = ref([])
const resolveError = ref('')
const runningStage = ref(null)
const stageResult = ref(null)
const wsConfig = ref({ deductConfirmed: false, modeConfirmed: false })

function pickLatest(list) {
  if (!Array.isArray(list) || list.length === 0) return ''
  const normalized = list
    .map((w) => String(w.workspaceKey || w.key || w))
    .filter(Boolean)
  const production = normalized.filter((k) => !k.startsWith('demo-')).sort().reverse()
  if (production.length > 0) return production[0]
  return normalized.sort().reverse()[0] || ''
}

async function resolveLatest() {
  try {
    const res = await fetchMonthlyWorkspaces()
    const items = Array.isArray(res?.workspaces) ? res.workspaces
      : Array.isArray(res?.data) ? res.data
      : Array.isArray(res?.data?.items) ? res.data.items
      : Array.isArray(res?.items) ? res.items
      : []
    workspaces.value = items
    const latest = pickLatest(items)
    if (latest) {
      activeWorkspace.value = latest
      router.replace({ name: 'v2-monthly-shell', params: { workspaceKey: latest } })
    } else {
      resolveError.value = 'NO_WORKSPACE'
    }
  } catch (error) {
    console.warn('workspaces lookup failed', error)
    resolveError.value = '加载月份列表失败，请稍后重试'
  }
}

watch(() => route.params.workspaceKey, (key) => {
  const k = String(key || '')
  if (k && k !== 'latest') activeWorkspace.value = k
  if (k === 'latest') resolveLatest()
})

if (initialKey === 'latest') {
  resolveLatest()
}

const fallbackData = computed(() => getMonthly(activeWorkspace.value || 'demo-2026-05'))
const productionFallbackData = computed(() => ({
  ...fallbackData.value,
  summary: {
    netKrw: null,
    netUsd: null,
    commission: null,
    lastMonthDiff: null,
    lastMonthDiffDirection: 'flat',
    scan7d: [],
    healthOk: false,
    failedChecks: ['待接入'],
    healthLastCheck: '等待后端数据',
    summaryUnavailable: true,
  },
}))
const overviewFallbackData = computed(() => (
  allowV2MockFallback ? fallbackData.value : productionFallbackData.value
))
const data = computed(() => apiData.value || (allowV2MockFallback ? fallbackData.value : null))

async function loadOverview() {
  if (!activeWorkspace.value) return
  isLoading.value = true
  workspaceMissing.value = false
  try {
    const payload = await fetchMonthlyOverview(activeWorkspace.value)
    // 月份合法但还没创建 → 正常空态(引导创建),不是接口错误。
    if (payload && payload.exists === false) {
      apiData.value = null
      apiFailed.value = false
      apiError.value = ''
      workspaceMissing.value = true
      wsConfig.value = { deductConfirmed: false, modeConfirmed: false }
      return
    }
    apiData.value = mapOverviewToMonthlyV2(payload, overviewFallbackData.value)
    apiFailed.value = false
    apiError.value = ''
    const ws = payload?.workspace
    wsConfig.value = {
      deductConfirmed: Boolean(ws?.deductConfigConfirmedAt),
      modeConfirmed: Boolean(ws?.modeMappingConfirmedAt),
    }
  } catch (error) {
    console.warn('monthly overview failed', error)
    apiData.value = null
    apiError.value = error?.response?.data?.message || error?.response?.data?.error || error?.message || '月度总览接口加载失败'
    apiFailed.value = true
  } finally {
    isLoading.value = false
  }
}

const blockingAlerts = computed(() => data.value?.alerts || [])
const alertCount = computed(() => blockingAlerts.value.reduce((sum, item) => sum + Number(item.count || 0), 0))
// 首页阻塞文案按「实际阻塞原因」生成,不再写死"字段冲突/多候选/模糊匹配"
// (否则会出现首页说有阻塞、账单核对对应 tab 却是 0 的口径不一致)。
const blockingReasonText = computed(() => {
  const labels = []
  const seen = new Set()
  for (const item of blockingAlerts.value) {
    if (Number(item.count || 0) <= 0) continue
    const label = reviewReasonLabel(item.label)
    if (label && !seen.has(label)) { seen.add(label); labels.push(`${label}（${item.count}）`) }
    if (labels.length >= 3) break
  }
  return labels.join('、')
})

// 阻塞原因分两类去向:团号/日期/代理/归类类 → 「待补救」页;字段冲突/多候选/模糊匹配
// → 「账单核对」页。首页据此把按钮指到真正能处理的页面(避免"让去账单核对、核对却是空的")。
const REMEDY_REASONS = new Set([
  'tour_not_found', 'tour_ambiguous', 'date_out_of_window', 'agent_mismatch', 'mode_unresolved',
])
const blockingRoute = computed(() => {
  let remedy = 0
  let review = 0
  for (const item of blockingAlerts.value) {
    const n = Number(item.count || 0)
    if (n <= 0) continue
    if (REMEDY_REASONS.has(item.label)) remedy += n
    else review += n
  }
  if (remedy > 0 && remedy >= review) return { route: 'daily-remedy-workspace', label: '先去待补救处理' }
  return { route: 'v2-monthly-bill-review', label: '先处理账单核对' }
})
const ledgerRows = computed(() => Number(data.value?.pipeline?.bridge?.count || 0))
const matchedRows = computed(() => Number(data.value?.pipeline?.match?.count || 0))

const nextAction = computed(() => {
  if (!data.value) return null
  if (alertCount.value > 0) {
    return {
      label: blockingRoute.value.label,
      route: blockingRoute.value.route,
      icon: AlertTriangle,
      variant: 'warn',
      description: blockingReasonText.value
        ? `当前有 ${alertCount.value} 个阻塞项：${blockingReasonText.value}，去对应页面处理后再继续交付。`
        : `当前有 ${alertCount.value} 个阻塞项，去对应页面处理后再继续交付。`,
    }
  }
  if (ledgerRows.value === 0) {
    return {
      label: '查看收票台账',
      route: 'v2-monthly-ledger',
      icon: ReceiptText,
      variant: 'info',
      description: '审核批次导入后，先确认小票是否已经按购买日期进入本月台账。',
    }
  }
  if (matchedRows.value === 0) {
    return {
      label: '去账单匹配',
      route: 'v2-monthly-bill-match',
      icon: SearchCheck,
      variant: 'info',
      description: '台账已有数据，下一步按四个桶导入账单并运行匹配。',
    }
  }
  return {
    label: '准备月度交付',
    route: 'v2-monthly-delivery',
    icon: FileSpreadsheet,
    variant: 'ok',
    description: '当前没有阻塞项。导出前建议再刷新一次健康检查和账单核对。',
  }
})

const quickActions = computed(() => [
  {
    label: '收票台账',
    description: '看审核通过后实际入月的小票',
    route: 'v2-monthly-ledger',
    icon: ReceiptText,
  },
  {
    label: '账单匹配',
    description: '四个桶导入账单、设置扣点、跑匹配',
    route: 'v2-monthly-bill-match',
    icon: SearchCheck,
  },
  {
    label: '账单核对',
    description: '处理字段冲突、未收小票、小票无账单、多候选、模糊匹配',
    route: 'v2-monthly-bill-review',
    icon: ListChecks,
  },
  {
    label: '未收清单',
    description: '账单有但台账无，或台账有但账单未到',
    route: 'v2-monthly-unreceived',
    icon: ClipboardList,
  },
  {
    label: '月度交付',
    description: '生成月度数据并导出交付文件',
    route: 'v2-monthly-delivery',
    icon: FileSpreadsheet,
  },
])

function mergeBlockedReason() {
  if (!wsConfig.value.deductConfirmed) return '扣点表未确认'
  if (!wsConfig.value.modeConfirmed) return '模式归类未确认'
  return ''
}

function describeStageError(error) {
  const payload = error?.response?.data || {}
  if (payload.code === 'PIPELINE_LOCKED') return `流水线被 ${payload.runningStage || '其他任务'} 占用，请稍后重试`
  if (payload.code === 'merge_blocked') return payload.message || '前置条件未满足'
  if (payload.code === 'STAGE_ALREADY_RUNNING') return '该阶段已经在运行'
  if (payload.code === 'service_unavailable') return `${payload.service || '后端服务'} 不可用`
  return error?.message || '请求失败'
}

function summarizeStagePayload(stage, payload) {
  if (!payload || typeof payload !== 'object') return '完成'
  const stats = payload.stats || payload
  const parts = []
  if (Number.isFinite(stats.inserted)) parts.push(`inserted ${stats.inserted}`)
  if (Number.isFinite(stats.matched)) parts.push(`matched ${stats.matched}`)
  if (Number.isFinite(stats.unmatched)) parts.push(`unmatched ${stats.unmatched}`)
  if (Number.isFinite(stats.unreceived)) parts.push(`unreceived ${stats.unreceived}`)
  if (Number.isFinite(stats.pendingReviews)) parts.push(`pending ${stats.pendingReviews}`)
  if (Number.isFinite(stats.skipped) && stats.skipped) parts.push(`skip ${stats.skipped}`)
  if (payload.job?.status) parts.push(`job ${payload.job.status}`)
  return parts.join(' · ') || `${stage} 完成`
}

function handleWorkspaceChange(workspaceKey) {
  activeWorkspace.value = workspaceKey
  router.push({ name: 'v2-monthly-shell', params: { workspaceKey } })
}

async function createCurrentWorkspace() {
  if (!activeWorkspace.value || creatingWorkspace.value) return
  creatingWorkspace.value = true
  try {
    await createMonthlyWorkspace(activeWorkspace.value)
    await loadOverview()
  } catch (error) {
    apiError.value = error?.response?.data?.error || error?.message || '创建本月失败'
    apiFailed.value = true
    workspaceMissing.value = false
  } finally {
    creatingWorkspace.value = false
  }
}

function routeFor(name) {
  return { name, params: { workspaceKey: activeWorkspace.value } }
}

async function handleExportReport() {
  if (!activeWorkspace.value || runningStage.value) return
  const reason = mergeBlockedReason()
  if (reason) {
    stageResult.value = { stage: 'export-report', success: false, message: `出报表被拦截：${reason}` }
    return
  }
  if (!window.confirm('出报表会先生成 monthly_data，再进入月度交付页。继续？')) return
  runningStage.value = 'export-report'
  stageResult.value = null
  try {
    const result = await runMerge(activeWorkspace.value)
    stageResult.value = {
      stage: 'export-report',
      success: true,
      message: `月度数据生成完成 · ${summarizeStagePayload('merge', result)}`,
      payload: result,
    }
    await loadOverview()
    router.push(routeFor('v2-monthly-delivery'))
  } catch (error) {
    stageResult.value = {
      stage: 'export-report',
      success: false,
      message: `出报表失败 · ${describeStageError(error)}`,
    }
  } finally {
    runningStage.value = null
  }
}

watch(activeWorkspace, loadOverview, { immediate: true })
onMounted(() => document.body.classList.add('v2-monthly-route'))
onBeforeUnmount(() => document.body.classList.remove('v2-monthly-route'))
</script>

<template>
  <AppLayout :workspace-key="activeWorkspace">
    <div class="min-w-0 space-y-5 overflow-x-hidden">
      <div
        v-if="resolveError === 'NO_WORKSPACE'"
        class="flex flex-wrap items-center gap-3 rounded-lg border border-status-warn/30 bg-status-warn/10 px-4 py-3 text-sm text-status-warn"
      >
        <span>尚未创建任何月份 workspace。</span>
        <RouterLink
          :to="{ name: 'v2-monthly-bill-match', params: { workspaceKey: 'demo-2026-05' } }"
          class="rounded-md border border-status-warn px-3 py-1 text-xs font-medium hover:bg-status-warn/20"
        >
          去账单匹配中心
        </RouterLink>
      </div>
      <div
        v-else-if="resolveError"
        class="rounded-lg border border-status-warn/30 bg-status-warn/10 px-4 py-3 text-sm text-status-warn"
      >
        {{ resolveError }}
      </div>

      <div class="flex items-center justify-between gap-3">
        <MonthlyHeader
          v-if="data"
          :data="data"
          :workspaces="workspaces"
          @workspace-change="handleWorkspaceChange"
        />
        <div
          v-else-if="workspaceMissing"
          class="flex flex-1 flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3 text-sm shadow-sm"
        >
          <div>
            <p class="font-medium text-foreground">本月（{{ activeWorkspace }}）还没有创建</p>
            <p class="mt-1 text-muted-foreground">
              这个月份还没开始处理。可以现在创建本月工作台，或从右上角切换到已有月份。
            </p>
          </div>
          <button
            type="button"
            class="inline-flex shrink-0 items-center gap-2 rounded-md border border-primary bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            :disabled="creatingWorkspace"
            @click="createCurrentWorkspace"
          >
            {{ creatingWorkspace ? '创建中…' : `创建本月（${activeWorkspace}）` }}
          </button>
        </div>
        <div
          v-else-if="isLoading"
          class="rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground shadow-sm"
        >
          正在加载月度总览…
        </div>
        <div
          v-else
          class="rounded-lg border border-status-error/30 bg-status-error/10 px-4 py-3 text-sm text-status-error"
        >
          月度总览加载失败。生产环境不会使用 mock 数据，请刷新或检查后端接口。
        </div>
        <StatusBadge v-if="apiFailed" :variant="v2MockFallbackVariant" size="sm">
          {{ v2MockFallbackLabel }}
        </StatusBadge>
        <StatusBadge v-else-if="isLoading" variant="info" size="sm">加载中</StatusBadge>
      </div>

      <div
        v-if="apiFailed && !allowV2MockFallback"
        class="rounded-lg border border-status-error/30 bg-status-error/10 px-4 py-3 text-sm text-status-error"
      >
        {{ apiError }}
      </div>

      <div
        v-if="data && stageResult"
        class="rounded-lg border px-4 py-3 text-sm"
        :class="stageResult.success
          ? 'border-status-ok/30 bg-status-ok/10 text-status-ok'
          : 'border-status-error/30 bg-status-error/10 text-status-error'"
      >
        {{ stageResult.message }}
      </div>

      <template v-if="data">
        <section class="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div class="rounded-lg border border-border bg-card p-5 shadow-sm lg:col-span-2">
            <div class="mb-5 flex flex-wrap items-start justify-between gap-4">
              <div>
                <p class="text-xs font-medium uppercase tracking-wide text-muted-foreground">月度处理控制台</p>
                <h1 class="mt-2 text-2xl font-medium text-foreground">下一步建议</h1>
                <p class="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
                  首页只放本月接下来该做的事。具体数据核对、导入和修正都进入对应工作台处理。
                </p>
              </div>
              <StatusBadge :variant="nextAction?.variant || 'info'" dot>
                {{ data.workspaceKey }}
              </StatusBadge>
            </div>

            <div class="rounded-lg border border-border bg-muted/30 p-4">
              <div class="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                <div class="flex min-w-0 items-start gap-3">
                  <component
                    :is="nextAction?.icon || CheckCircle2"
                    class="mt-0.5 h-5 w-5 shrink-0 text-primary"
                    aria-hidden="true"
                  />
                  <div class="min-w-0">
                    <p class="text-base font-medium text-foreground">{{ nextAction?.label }}</p>
                    <p class="mt-1 text-sm leading-6 text-muted-foreground">{{ nextAction?.description }}</p>
                  </div>
                </div>
                <RouterLink
                  v-if="nextAction"
                  :to="routeFor(nextAction.route)"
                  class="inline-flex items-center justify-center gap-2 rounded-md border border-primary bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                >
                  进入处理
                  <ArrowRight class="h-4 w-4" />
                </RouterLink>
              </div>
            </div>
          </div>

          <div class="rounded-lg border border-border bg-card p-5 shadow-sm">
            <div class="mb-4 flex items-center justify-between">
              <h2 class="font-medium text-foreground">快捷入口</h2>
              <RefreshCw class="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            </div>
            <div class="space-y-2">
              <RouterLink
                v-for="item in quickActions"
                :key="item.route"
                :to="routeFor(item.route)"
                class="flex items-start gap-3 rounded-md border border-border px-3 py-3 transition hover:bg-muted/50"
              >
                <component :is="item.icon" class="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                <span class="min-w-0">
                  <span class="block text-sm font-medium text-foreground">{{ item.label }}</span>
                  <span class="mt-1 block text-xs leading-5 text-muted-foreground">{{ item.description }}</span>
                </span>
              </RouterLink>
              <button
                type="button"
                class="flex w-full items-start gap-3 rounded-md border border-border px-3 py-3 text-left transition hover:bg-muted/50 disabled:opacity-60"
                :disabled="!!runningStage"
                @click="handleExportReport"
              >
                <FileSpreadsheet class="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                <span class="min-w-0">
                  <span class="block text-sm font-medium text-foreground">
                    {{ runningStage === 'export-report' ? '生成中' : '生成交付数据' }}
                  </span>
                  <span class="mt-1 block text-xs leading-5 text-muted-foreground">
                    校验扣点和模式归类后，生成 monthly_data。
                  </span>
                </span>
              </button>
            </div>
          </div>
        </section>
      </template>

      <RowHistoryDrawer :workspace-key="activeWorkspace" />

      <footer class="border-t border-border/40 pt-4 text-xs text-muted-foreground">
        新版工作台(v2) · 月度首页现在只负责指路，细节操作进入对应工作台。
      </footer>
    </div>
  </AppLayout>
</template>

<style scoped>
:deep(.v2-layout main) {
  min-width: 0;
}

:global(body.v2-monthly-route .workspace) {
  padding: 0;
}

:global(body.v2-monthly-route .shell > .sidebar) {
  display: none;
}

@media (max-width: 767px) {
  :global(body.v2-monthly-route .v2-layout aside) {
    display: none;
  }

  :global(body.v2-monthly-route .shell) {
    display: block;
  }

  :global(body.v2-monthly-route .v2-layout > .flex) {
    min-width: 0;
    width: 100%;
  }
}
</style>
