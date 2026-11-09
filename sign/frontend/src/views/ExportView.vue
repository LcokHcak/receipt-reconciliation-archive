<script setup>
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import BatchSelector from '../components/BatchSelector.vue'
import { useWorkbenchStore } from '../stores/workbench'
import { PROCESS_RESULT } from '../lib/statusLabels'

const route = useRoute()
const router = useRouter()
const workbench = useWorkbenchStore()
const exporting = ref(false)
const exportResult = ref(null)
const selectedBatchId = ref('')
// 隐藏不用记行(2026-07-21 拍板):默认关=不用记行保留并带【代理标注:不用记】;勾选后整行不进表
const excludeNoRecord = ref(false)
const exportLinks = computed(() => {
  if (!exportResult.value) {
    return []
  }
  return [
    ['Excel', exportResult.value.xlsxUrl],
    ['CSV', exportResult.value.csvUrl],
  ].filter(([, url]) => Boolean(url))
})

async function loadBatch() {
  exportResult.value = null
  try {
    if (!workbench.batches.length) {
      await workbench.fetchBatches()
    }
    const batchId = workbench.resolveBatchId(route.params.batchId)
    selectedBatchId.value = batchId
    await workbench.fetchBatch(batchId)
  } catch {
    // workbench.error is set by the store; template already surfaces it.
  }
}

async function runExport() {
  exporting.value = true
  workbench.error = ''
  try {
    exportResult.value = await workbench.exportCurrentBatch({ excludeNoRecord: excludeNoRecord.value })
  } catch (error) {
    workbench.setError?.(error) || (workbench.error = error?.response?.data?.error || error?.message || '导出失败')
    exportResult.value = null
  } finally {
    exporting.value = false
  }
}

function changeBatch(batchId) {
  if (!batchId || batchId === route.params.batchId) {
    return
  }
  exportResult.value = null
  router.push({ name: 'export', params: { batchId } })
}

onMounted(loadBatch)
</script>

<template>
  <section class="page-title">
    <div>
      <h1>旧批次结果导出</h1>
      <p>仅用于管理员处理历史审核批次和异常归档；日常财务导出请从结算中心进入。</p>
    </div>
    <div class="page-actions">
      <BatchSelector
        v-model="selectedBatchId"
        :batches="workbench.batches"
        :loading="workbench.loading"
        @update:model-value="changeBatch"
        @on-refresh="loadBatch"
      />
      <label class="exclude-norecord" title="勾选后「不用记」模式的小票整行不进表;默认保留并带【代理标注:不用记】标注,防止误以为丢票">
        <input v-model="excludeNoRecord" type="checkbox"> 隐藏不用记行
      </label>
      <button class="primary-button" type="button" :disabled="exporting || !workbench.currentBatch" @click="runExport">
        {{ exporting ? '导出中' : '导出旧批次' }}
      </button>
    </div>
  </section>

  <section class="panel">
    <div class="panel-header">
      <strong>{{ workbench.currentBatch?.name || workbench.currentBatch?.id || '未选择批次' }}</strong>
      <span class="status">{{ workbench.currentBatch?.status || '-' }}</span>
    </div>
    <div class="panel-body">
      <div class="grid-metrics">
        <div class="metric"><span>文件</span><strong>{{ workbench.tasks.length }}</strong></div>
        <div class="metric"><span>通过</span><strong>{{ workbench.tasks.filter((task) => task.processResult === PROCESS_RESULT.APPROVED).length }}</strong></div>
        <div class="metric"><span>需重拍</span><strong>{{ workbench.tasks.filter((task) => task.processResult === PROCESS_RESULT.REPHOTO).length }}</strong></div>
        <div class="metric"><span>待处理</span><strong>{{ workbench.tasks.filter((task) => task.processResult !== '已通过').length }}</strong></div>
      </div>

      <div v-if="exportResult" class="export-result">
        <strong>导出完成</strong>
        <span>账单处理：{{ exportResult.finalizations?.finalized?.length || 0 }} 个完成，{{ exportResult.finalizations?.errors?.length || 0 }} 个异常</span>
        <a v-for="[label, url] in exportLinks" :key="label" :href="url" target="_blank" rel="noreferrer">
          打开 {{ label }}
        </a>
      </div>
    </div>
  </section>
</template>
