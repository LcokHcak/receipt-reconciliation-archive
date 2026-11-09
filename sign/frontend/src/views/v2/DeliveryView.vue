<script setup>
// 最终交付:极简终点页,只管"出包 + 看结果"。
// 所有过程性内容(生成交付数据 merge、交付前检查、逐行核对、过程导出、文件列表)
// 都在「最终核对」页;到这一页默认已核对通过,分两类一键出包:
//   ① 汇总-最终数据类:四桶最终数据 xlsx(+收据单/未收清单/交付清单)
//   ② 客户-最终文件类:每客户文件夹(收据单+图片)+客户 PDF
// 结果用计数展示(导出文件 N 个/客户文件夹 N/收据单 N/客户 PDF N),不列文件清单。
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { Download, FileArchive, FolderDown, ShieldCheck } from 'lucide-vue-next'

import AppLayout from '@/layouts/AppLayout.vue'
import Button from '@/components/ui/button.vue'
import TabularNumber from '@/components/ui/tabular-number.vue'
import { fetchFinalDeliveryReadiness, runFinalDeliveryExport } from '@/api/v2/delivery'
import { ensureFresh } from '@/api/v2/stages'

const route = useRoute()
const workspaceKey = computed(() => String(route.params.workspaceKey || ''))

const readiness = ref(null)
const loadingReadiness = ref(false)
const actionLoading = ref('')
const errorMsg = ref('')
const successMsg = ref('')
// 最近一次导出的结果计数(本次会话内;来自 final-delivery 响应的 counts)
const lastCounts = ref(null)
const lastProducedAt = ref('')

const PACKAGES = Object.freeze([
  {
    type: 'data',
    title: '汇总 - 最终数据类',
    icon: FileArchive,
    hint: '四桶最终数据 xlsx(乐天首尔/乐天釜山/爱宝客/济州新罗V团) + 收据单 + 未收清单 + 交付清单',
    button: '一键导出数据包',
  },
  {
    type: 'customer',
    title: '客户 - 最终文件类',
    icon: FolderDown,
    hint: '每客户两类:文件夹①收据单(Sheet1,2)+客户图片(护照/小票/机票);文件夹②客户 PDF(综合)',
    button: '下载客户文件包',
  },
])

const checkTarget = computed(() => `/monthly/v2/${encodeURIComponent(workspaceKey.value)}/delivery-check`)

const resultCards = computed(() => {
  const c = lastCounts.value
  if (!c) return []
  return [
    { label: '导出文件', value: c.finalDataFileCount, unit: '个' },
    { label: '总客户文件夹', value: c.customerFolderCount, unit: '个' },
    { label: '生成收据单', value: c.receiptCount, unit: '个' },
    { label: '生成客户 PDF', value: c.customerPdfCount, unit: '个' },
  ]
})

async function loadReadiness() {
  if (!workspaceKey.value) return
  loadingReadiness.value = true
  try {
    readiness.value = await fetchFinalDeliveryReadiness(workspaceKey.value)
  } catch (error) {
    errorMsg.value = decodeError(error, '交付检查失败')
    readiness.value = null
  } finally {
    loadingReadiness.value = false
  }
}

async function handleExport(pkg) {
  if (!workspaceKey.value || actionLoading.value) return
  await loadReadiness()
  // 出包前按需重算:若派生数据过期(改了账单/团号/模式/扣点)或从未生成 → 先重跑到 merge,
  // 保证出的包永远跟最新匹配结果走;新鲜则 no-op。monthly_data 纯派生,重算无人工修改可丢。
  if (readiness.value && (readiness.value.merged === false || readiness.value.derivationDirtyFrom)) {
    if (!window.confirm(`交付数据需按最新状态生成后再出「${pkg.title}」。继续？`)) return
    actionLoading.value = pkg.type
    errorMsg.value = ''
    try {
      await ensureFresh(workspaceKey.value)
      await loadReadiness()
    } catch (error) {
      errorMsg.value = decodeError(error, '生成交付数据失败')
      actionLoading.value = ''
      return
    }
  }
  if (!readiness.value?.ok) {
    errorMsg.value = '交付检查未通过，请先去「最终核对」处理'
    return
  }
  if (actionLoading.value !== pkg.type && !window.confirm(`生成「${pkg.title}」？完成后会自动下载 zip。`)) return
  actionLoading.value = pkg.type
  errorMsg.value = ''
  try {
    const result = await runFinalDeliveryExport(workspaceKey.value, { packageTypes: [pkg.type] })
    triggerArchiveDownload(result.archive)
    lastCounts.value = result?.counts || null
    lastProducedAt.value = result?.producedAt || new Date().toISOString()
    flashSuccess(`${pkg.title}已生成：${result?.archive?.filename || ''}，已开始下载`)
    await loadReadiness()
  } catch (error) {
    errorMsg.value = decodeError(error, '导出失败')
  } finally {
    actionLoading.value = ''
  }
}

function triggerArchiveDownload(archive) {
  if (!archive?.downloadPath) return
  const link = document.createElement('a')
  link.href = archive.downloadPath
  link.download = archive.filename || ''
  document.body.appendChild(link)
  link.click()
  link.remove()
}

function decodeError(error, fallback) {
  const data = error?.response?.data || {}
  if (data.code === 'FINAL_DELIVERY_BLOCKED') return '交付检查未通过，请先去「最终核对」处理'
  if (data.code === 'PIPELINE_LOCKED') return `流水线被 ${data.runningStage || '其他任务'} 占用`
  if (data.code === 'WORKSPACE_LOCKED') return '月份已锁定'
  if (data.code === 'STAGE_ALREADY_RUNNING') return data.error || '上一个任务还在运行，请稍后重试'
  if (data.code === 'service_unavailable') return `${data.service || '服务'} 不可用`
  return data.error || error?.message || fallback
}

function flashSuccess(text, ms = 6000) {
  successMsg.value = text
  errorMsg.value = ''
  setTimeout(() => { if (successMsg.value === text) successMsg.value = '' }, ms)
}

onMounted(loadReadiness)
watch(workspaceKey, () => {
  lastCounts.value = null
  loadReadiness()
})
</script>

<template>
  <AppLayout :workspace-key="workspaceKey">
    <div class="min-w-0 space-y-5 overflow-x-hidden">
      <header class="flex flex-wrap items-center gap-3 px-1" data-testid="delivery-header">
        <Download class="h-6 w-6 text-primary" />
        <div class="min-w-0 flex-1">
          <h1 class="text-xl font-medium text-foreground">最终交付</h1>
          <p class="text-sm text-muted-foreground">workspace · <span class="font-mono">{{ workspaceKey }}</span></p>
        </div>
        <Button variant="outline" size="sm" :disabled="loadingReadiness" @click="loadReadiness">刷新</Button>
      </header>

      <div v-if="errorMsg" class="rounded-lg border border-status-error/30 bg-status-error/10 px-4 py-2 text-sm text-status-error">{{ errorMsg }}</div>
      <div v-else-if="successMsg" class="rounded-lg border border-status-ok/30 bg-status-ok/10 px-4 py-2 text-sm text-status-ok">{{ successMsg }}</div>

      <!-- 只读状态条:检查在「最终核对」做,这里只看结论 -->
      <section
        class="flex flex-wrap items-center gap-3 rounded-lg border p-4 shadow-sm"
        :class="readiness?.ok ? 'border-status-ok/30 bg-status-ok/5' : 'border-status-error/30 bg-status-error/5'"
        data-testid="delivery-readiness-bar"
      >
        <ShieldCheck class="h-5 w-5" :class="readiness?.ok ? 'text-status-ok' : 'text-status-error'" />
        <template v-if="readiness?.ok">
          <span class="text-sm font-medium">已通过最终核对，可交付行 <TabularNumber :value="readiness?.eligibleRows || 0" /> 条</span>
        </template>
        <template v-else>
          <span class="text-sm font-medium">交付检查未通过（{{ (readiness?.blocking || []).length }} 个阻断项）</span>
          <RouterLink :to="checkTarget" class="text-sm text-primary hover:underline">去最终核对处理 →</RouterLink>
        </template>
      </section>

      <!-- 两类一键出包 -->
      <section class="grid gap-4 md:grid-cols-2">
        <article
          v-for="pkg in PACKAGES"
          :key="pkg.type"
          class="flex flex-col rounded-lg border border-border bg-card p-4 shadow-sm"
          :data-testid="`delivery-package-${pkg.type}`"
        >
          <div class="flex items-center gap-2">
            <component :is="pkg.icon" class="h-5 w-5 text-primary" />
            <h2 class="text-base font-medium">{{ pkg.title }}</h2>
          </div>
          <p class="mt-2 flex-1 text-sm text-muted-foreground">{{ pkg.hint }}</p>
          <Button
            class="mt-4 w-full"
            :disabled="!!actionLoading || !readiness?.ok"
            @click="handleExport(pkg)"
          >
            {{ actionLoading === pkg.type ? '生成中…' : pkg.button }}
          </Button>
        </article>
      </section>

      <!-- 结果计数(不列 3000 个文件,看规模就够) -->
      <section v-if="resultCards.length" class="rounded-lg border border-border bg-card p-4 shadow-sm" data-testid="delivery-result-counts">
        <div class="mb-3 flex flex-wrap items-center gap-2">
          <h2 class="text-base font-medium">本次生成结果</h2>
          <span class="text-xs text-muted-foreground">{{ lastProducedAt ? new Date(lastProducedAt).toLocaleString('zh-CN') : '' }}</span>
        </div>
        <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
          <div v-for="card in resultCards" :key="card.label" class="rounded-lg border border-border p-3">
            <p class="text-xs text-muted-foreground">{{ card.label }}</p>
            <p class="mt-1 text-2xl font-medium">
              <TabularNumber :value="Number(card.value) || 0" /><span class="ml-1 text-sm font-normal text-muted-foreground">{{ card.unit }}</span>
            </p>
          </div>
        </div>
      </section>
    </div>
  </AppLayout>
</template>
