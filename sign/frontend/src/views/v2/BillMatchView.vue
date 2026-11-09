<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { GitBranch, Receipt } from 'lucide-vue-next'

import AppLayout from '@/layouts/AppLayout.vue'
import Button from '@/components/ui/button.vue'
import StatusBadge from '@/components/ui/status-badge.vue'
import TabularNumber from '@/components/ui/tabular-number.vue'
import BucketCard from '@/components/v2/BucketCard.vue'
import UnmappedModesPanel from '@/components/v2/UnmappedModesPanel.vue'
import ConfigConfirmBar from '@/components/v2/ConfigConfirmBar.vue'
import { fetchBuckets } from '@/api/v2/billMatchBuckets'
import { runBillMatch, runTourMatch } from '@/api/v2/stages'

const route = useRoute()
const workspaceKey = computed(() => String(route.params.workspaceKey || ''))
const data = ref({ buckets: [], global: {} })
const loading = ref(false)
const errorMsg = ref('')
const runningAll = ref(false)
const runningTour = ref(false)
const reconcileSteps = ref([])

const buckets = computed(() => Array.isArray(data.value?.buckets) ? data.value.buckets : [])
const global = computed(() => data.value?.global || {})
const globalReceivedBillRows = computed(() => Number(global.value.matchedBillRows || 0))
const globalMatchedDailyRows = computed(() => Number(global.value.matched || 0))
const matchRateLabel = computed(() => formatPercent(global.value.matchRate))
const billDetailCoverageLabel = computed(() => formatPercent(
  global.value.billDetailCoverageRate ?? (
    Number(global.value.totalBills || 0) > 0
      ? globalReceivedBillRows.value / Number(global.value.totalBills || 0)
      : 0
  )
))
const folders = computed(() => buckets.value.map((b) => b.folder).filter(Boolean))
const unmappedPanel = ref(null)
const configBar = ref(null)

function formatPercent(value) {
  const percent = Number(value || 0) * 100
  if (!Number.isFinite(percent) || percent <= 0) return '0%'
  if (percent < 0.01) return '<0.01%'
  if (percent < 1) return `${percent.toFixed(2)}%`
  return `${Math.round(percent)}%`
}

function onModesChanged() {
  load()
  configBar.value?.reload?.()
}

function describeError(error, fallback) {
  return error?.response?.data?.error || error?.message || fallback
}

async function load() {
  if (!workspaceKey.value) return
  loading.value = true
  errorMsg.value = ''
  try {
    data.value = await fetchBuckets(workspaceKey.value)
  } catch (error) {
    errorMsg.value = describeError(error, '账单匹配数据加载失败')
    data.value = { buckets: [], global: {} }
  } finally {
    loading.value = false
  }
}

async function runAll() {
  if (runningAll.value) return
  if (!window.confirm('一键重对账会先跑团号匹配,再跑账单匹配。继续?')) return
  runningAll.value = true
  reconcileSteps.value = []
  errorMsg.value = ''
  try {
    reconcileSteps.value.push('团号匹配中')
    await runTourMatch(workspaceKey.value)
    reconcileSteps.value.push('团号匹配完成')
    reconcileSteps.value.push('账单匹配中')
    await runBillMatch(workspaceKey.value)
    reconcileSteps.value.push('账单匹配完成')
    await load()
  } catch (error) {
    errorMsg.value = describeError(error, '一键重对账失败')
  } finally {
    runningAll.value = false
  }
}

async function runTour() {
  if (runningTour.value) return
  if (!window.confirm('确认先运行团号匹配？')) return
  runningTour.value = true
  errorMsg.value = ''
  try {
    await runTourMatch(workspaceKey.value)
    await load()
  } catch (error) {
    errorMsg.value = describeError(error, '团号匹配失败')
  } finally {
    runningTour.value = false
  }
}

onMounted(load)
watch(workspaceKey, load)
</script>

<template>
  <AppLayout :workspace-key="workspaceKey">
    <div class="min-w-0 space-y-5 overflow-x-hidden">
      <header class="flex flex-wrap items-start gap-3 px-1">
        <Receipt class="mt-1 h-6 w-6 text-primary" />
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <h1 class="text-xl font-medium text-foreground">账单匹配</h1>
            <StatusBadge v-if="workspaceKey.startsWith('demo-')" variant="test" size="sm">测试模式</StatusBadge>
          </div>
          <p class="text-sm text-muted-foreground">
            四个业务桶集中处理扣点、模式归类、账单导入和匹配统计。
          </p>
        </div>
        <Button variant="ghost" size="sm" :disabled="loading" @click="load">刷新</Button>
      </header>

      <div v-if="errorMsg" class="rounded-lg border border-status-error/30 bg-status-error/10 px-4 py-2 text-sm text-status-error">
        {{ errorMsg }}
      </div>

      <section class="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div class="rounded-lg border border-border bg-card p-3 shadow-sm">
          <p class="text-xs text-muted-foreground">账单明细行</p>
          <TabularNumber :value="Number(global.totalBills || 0)" class="mt-1 text-2xl font-medium" />
          <p class="mt-1 text-xs text-muted-foreground">
            账单明细覆盖 <TabularNumber :value="globalReceivedBillRows" /> 行 · {{ billDetailCoverageLabel }}
          </p>
        </div>
        <div class="rounded-lg border border-border bg-card p-3 shadow-sm">
          <p class="text-xs text-muted-foreground">台账小票</p>
          <TabularNumber :value="Number(global.totalDaily || 0)" class="mt-1 text-2xl font-medium" />
        </div>
        <div class="rounded-lg border border-status-ok/30 bg-status-ok/5 p-3 shadow-sm">
          <p class="text-xs text-muted-foreground">已匹配台账</p>
          <TabularNumber :value="globalMatchedDailyRows" class="mt-1 text-2xl font-medium text-status-ok" />
        </div>
        <div class="rounded-lg border border-border bg-card p-3 shadow-sm">
          <p class="text-xs text-muted-foreground">台账匹配率</p>
          <p class="mt-1 text-2xl font-medium">{{ matchRateLabel }}</p>
        </div>
      </section>

      <ConfigConfirmBar
        ref="configBar"
        :workspace-key="workspaceKey"
      />

      <UnmappedModesPanel
        ref="unmappedPanel"
        :workspace-key="workspaceKey"
        :folders="folders"
        @changed="onModesChanged"
      />

      <section v-if="loading" class="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
        加载账单匹配控制台中...
      </section>
      <section v-else class="space-y-4">
        <BucketCard
          v-for="bucket in buckets"
          :key="bucket.folder"
          :bucket="bucket"
          :workspace-key="workspaceKey"
          @match-finished="load"
          @import-completed="load"
          @config-changed="() => { load(); unmappedPanel?.reload?.(); configBar?.reload?.() }"
        />
      </section>

      <section class="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-3 shadow-sm">
        <span class="text-xs text-muted-foreground">全局操作</span>
        <Button size="sm" :disabled="runningAll" @click="runAll">
          <Receipt class="h-4 w-4" />
          {{ runningAll ? '重对账中' : '一键重对账' }}
        </Button>
        <Button variant="outline" size="sm" :disabled="runningTour" @click="runTour">
          <GitBranch class="h-4 w-4" />
          {{ runningTour ? '匹配中' : '先跑团号匹配' }}
        </Button>
        <span v-if="reconcileSteps.length" class="text-xs text-muted-foreground">
          {{ reconcileSteps.join(' / ') }}
        </span>
      </section>
    </div>
  </AppLayout>
</template>
