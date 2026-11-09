<script setup>
// v2 AuditDashboardView (F9a): 月度对账核对 dashboard — 4 口径 + 闭合公式。
// 区别 D4b 的 AuditLogsView (/audit/v2/logs) — 那个看 audit_log 记录,这里看数。
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { CheckCircle, Scale, XCircle } from 'lucide-vue-next'

import AppLayout from '@/layouts/AppLayout.vue'
import Button from '@/components/ui/button.vue'
import StatusBadge from '@/components/ui/status-badge.vue'
import TabularNumber from '@/components/ui/tabular-number.vue'
import { fetchMonthlyOverview } from '@/api/v2/monthly'
import { fetchReconciliation } from '@/api/v2/listings'

const route = useRoute()
const workspaceKey = computed(() => String(route.params.workspaceKey || ''))

const counts = ref({})              // overview.counts
const reconciliation = ref({})      // { metrics?, formulas? }
const loading = ref(false)
const errorMsg = ref('')

// ── derived metrics ─────────────────────────────────────────────────────────
function countMonthlyByMatched(matched) {
  return (counts.value.monthlyByMode || [])
    .filter((row) => Boolean(Number(row.unmatched || row.is_unmatched)) !== matched)
    .reduce((sum, row) => sum + Number(row.n || row.count || 0), 0)
}
const ledgerStatusMap = computed(() => {
  const map = {}
  for (const item of counts.value.ledgerByStatus || []) {
    map[item.status] = Number(item.n || item.count || 0)
  }
  return map
})

const storeBills = computed(() => Number(counts.value.storeBills || 0))
const monthlyData = computed(() => Number(counts.value.monthlyData || 0))
const posted = computed(() =>
  Number(ledgerStatusMap.value.posted || 0) + Number(ledgerStatusMap.value.locked || 0))
const unreceived = computed(() => countMonthlyByMatched(false))
const matched = computed(() => Math.max(0, storeBills.value - unreceived.value))
const pendingOpen = computed(() => Number(counts.value.pendingOpen || 0))

const auditMetrics = computed(() => [
  { id: 'storeBills',    label: '账单明细总数', value: storeBills.value,
    definition: '本月导入的店铺账单明细行数。',
    source: 'store_bill', rule: '工作区内全部有效账单明细。' },
  { id: 'posted',        label: '已确认入账', value: posted.value,
    definition: '台账已确认进入本月财务流程的数据。',
    source: 'daily_receipt_export', rule: 'ledger_status ∈ {posted, locked}。' },
  { id: 'unreceived',    label: '未收待处理', value: unreceived.value,
    definition: '店铺账单有记录但台账中暂时找不到对应小票。',
    source: 'monthly_data', rule: 'is_unmatched=1。' },
  { id: 'pendingReview', label: '待人工确认', value: pendingOpen.value,
    definition: '系统无法自动判断,需要人工处理的候选。',
    source: 'pending_review', rule: 'status=open。' },
])

// 闭合公式 — 后端 reconciliation.formulas 优先,否则前端兜底
const formulas = computed(() => {
  if (reconciliation.value?.formulas?.length) return reconciliation.value.formulas
  return [
    { id: 'bill-closure', label: '账单闭合关系', expression: '账单明细 = 已匹配 + 未收待处理',
      left:  { label: '账单明细', value: storeBills.value },
      parts: [{ label: '已匹配', value: matched.value }, { label: '未收待处理', value: unreceived.value }],
      balanced: storeBills.value === matched.value + unreceived.value,
      note: '待人工确认是异常池,不与未收数字混算。' },
    { id: 'monthly-output', label: '月度数据关系', expression: '月度数据 = 已确认入账 + 未收待处理',
      left:  { label: '月度数据', value: monthlyData.value },
      parts: [{ label: '已确认入账', value: posted.value }, { label: '未收待处理', value: unreceived.value }],
      balanced: monthlyData.value === posted.value + unreceived.value,
      note: '用于判断交付包是否来自同一批结果。' },
  ]
})

const activeMetricId = ref('unreceived')
const activeMetric = computed(() =>
  auditMetrics.value.find((m) => m.id === activeMetricId.value) || auditMetrics.value[0])

async function load() {
  if (!workspaceKey.value) return
  loading.value = true
  errorMsg.value = ''
  try {
    const [overview, recon] = await Promise.all([
      fetchMonthlyOverview(workspaceKey.value),
      fetchReconciliation(workspaceKey.value).catch(() => ({})),
    ])
    counts.value = overview?.counts || {}
    reconciliation.value = recon || {}
  } catch (error) {
    const data = error?.response?.data || {}
    errorMsg.value = data.code === 'service_unavailable'
      ? `${data.service || '服务'} 不可用 (503)`
      : data.error || error?.message || '加载失败'
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(workspaceKey, load)
</script>

<template>
  <AppLayout :workspace-key="workspaceKey">
    <div class="min-w-0 space-y-5 overflow-x-hidden">
      <header class="flex items-center gap-3 px-1">
        <Scale class="h-6 w-6 text-primary" />
        <div class="flex-1">
          <h1 class="text-xl font-medium text-foreground">对账总览 v2</h1>
          <p class="text-sm text-muted-foreground">
            workspace · <span class="font-mono">{{ workspaceKey }}</span> ·
            4 个核心口径 + 2 条闭合公式。
            <RouterLink :to="{ name: 'v2-audit-logs' }" class="ml-1 text-primary underline">audit_log 记录 →</RouterLink>
          </p>
        </div>
        <Button variant="ghost" size="sm" :disabled="loading" @click="load">刷新</Button>
      </header>

      <div v-if="errorMsg" class="rounded-lg border border-status-error/30 bg-status-error/10 px-4 py-2 text-sm text-status-error">{{ errorMsg }}</div>

      <!-- 4 张口径卡 (可点切换 activeMetric) -->
      <section class="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <button
          v-for="m in auditMetrics" :key="m.id"
          type="button"
          class="rounded-lg border bg-card p-3 text-left shadow-sm transition hover:border-primary"
          :class="activeMetricId === m.id ? 'border-primary ring-2 ring-primary/30' : 'border-border'"
          @click="activeMetricId = m.id"
        >
          <p class="text-xs text-muted-foreground">{{ m.label }}</p>
          <TabularNumber :value="m.value" class="mt-1 text-2xl font-medium" />
        </button>
      </section>

      <!-- active 口径的定义 / 来源 / 规则 -->
      <section v-if="activeMetric" class="rounded-lg border border-border bg-card p-4 shadow-sm">
        <div class="flex items-baseline gap-3">
          <h2 class="text-base font-medium text-foreground">{{ activeMetric.label }}</h2>
          <TabularNumber :value="activeMetric.value" class="text-2xl font-medium text-primary" />
        </div>
        <dl class="mt-3 space-y-2 text-sm">
          <div><dt class="text-xs text-muted-foreground">定义</dt><dd class="text-foreground">{{ activeMetric.definition }}</dd></div>
          <div><dt class="text-xs text-muted-foreground">数据来源</dt><dd class="text-foreground">{{ activeMetric.source }}</dd></div>
          <div><dt class="text-xs text-muted-foreground">统计规则</dt><dd class="text-foreground">{{ activeMetric.rule }}</dd></div>
        </dl>
      </section>

      <!-- 闭合公式 -->
      <section class="space-y-3">
        <h2 class="text-sm font-medium text-foreground px-1">闭合校验</h2>
        <article
          v-for="f in formulas" :key="f.id"
          class="rounded-lg border bg-card p-4 shadow-sm"
          :class="f.balanced ? 'border-status-ok/30' : 'border-status-error/30'"
        >
          <div class="flex items-center justify-between gap-3">
            <div class="flex items-center gap-2">
              <component
                :is="f.balanced ? CheckCircle : XCircle"
                :class="f.balanced ? 'h-5 w-5 text-status-ok' : 'h-5 w-5 text-status-error'"
              />
              <strong class="text-sm text-foreground">{{ f.label }}</strong>
              <StatusBadge :variant="f.balanced ? 'ok' : 'error'" size="sm">
                {{ f.balanced ? '已闭合' : '未闭合' }}
              </StatusBadge>
            </div>
            <code class="font-mono text-xs text-muted-foreground">{{ f.expression }}</code>
          </div>
          <div class="mt-3 flex flex-wrap items-baseline gap-2 text-sm">
            <strong>{{ f.left.label }}</strong>
            <TabularNumber :value="f.left.value" class="font-medium" />
            <span class="text-muted-foreground">=</span>
            <template v-for="(p, i) in f.parts" :key="`${f.id}-p${i}`">
              <span class="text-foreground">{{ p.label }}</span>
              <TabularNumber :value="p.value" class="font-medium" />
              <span v-if="i < f.parts.length - 1" class="text-muted-foreground">+</span>
            </template>
          </div>
          <p v-if="f.note" class="mt-2 text-xs text-muted-foreground">{{ f.note }}</p>
        </article>
      </section>
    </div>
  </AppLayout>
</template>
