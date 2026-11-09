<script setup>
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { fetchAdminDashboard } from '../api/admin'

const dashboard = ref(null)
const loading = ref(false)
const error = ref('')
let refreshTimer = null

async function load() {
  loading.value = true
  error.value = ''
  try {
    dashboard.value = await fetchAdminDashboard()
  } catch (err) {
    error.value = err?.response?.data?.error || err?.message || String(err)
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  await load()
  // 每 10 秒刷新一次
  refreshTimer = setInterval(load, 10000)
})

onBeforeUnmount(() => {
  if (refreshTimer) clearInterval(refreshTimer)
})

function formatBytes(bytes) {
  if (!bytes) return '-'
  const units = ['B', 'KB', 'MB', 'GB']
  let n = bytes
  let i = 0
  while (n > 1024 && i < units.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(1)} ${units[i]}`
}

function formatUptime(sec) {
  if (!sec) return '-'
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return d > 0 ? `${d}天${h}小时` : (h > 0 ? `${h}小时${m}分` : `${m}分`)
}

function fmtTime(t) {
  return t ? new Date(t).toLocaleString('zh-CN') : '-'
}

const memoryMB = computed(() => {
  if (!dashboard.value?.memory) return null
  return {
    rss: (dashboard.value.memory.rss / 1024 / 1024).toFixed(0),
    heapUsed: (dashboard.value.memory.heapUsed / 1024 / 1024).toFixed(0),
    heapTotal: (dashboard.value.memory.heapTotal / 1024 / 1024).toFixed(0),
  }
})
</script>

<template>
  <section class="page-title">
    <div>
      <h1>管理员仪表盘</h1>
      <p>系统健康状况、最近 24 小时统计、运行中任务</p>
    </div>
    <div class="page-actions">
      <button type="button" :disabled="loading" @click="load">刷新</button>
      <router-link :to="{ name: 'training' }" class="training-export-link">导出上传训练数据</router-link>
      <router-link :to="{ name: 'admin-users' }">员工管理</router-link>
      <router-link :to="{ name: 'admin-logs' }">查看日志</router-link>
      <router-link :to="{ name: 'admin-feedback' }">用户反馈</router-link>
      <router-link :to="{ name: 'export', params: { batchId: 'latest' } }">旧批次结果导出</router-link>
    </div>
  </section>

  <p v-if="error" class="error-text">{{ error }}</p>
  <p v-if="loading && !dashboard" class="hint">加载中…</p>

  <template v-if="dashboard">
    <!-- 核心指标 -->
    <section class="panel">
      <div class="panel-header"><strong>系统状态</strong></div>
      <div class="panel-body grid-metrics">
        <div class="metric">
          <span>运行时长</span>
          <strong>{{ formatUptime(dashboard.uptime) }}</strong>
        </div>
        <div class="metric" :class="{ warn: dashboard.logs.errorCount > 0 }">
          <span>24h 错误</span>
          <strong>{{ dashboard.logs.errorCount }}</strong>
        </div>
        <div class="metric" :class="{ warn: dashboard.logs.warnCount > 10 }">
          <span>24h 警告</span>
          <strong>{{ dashboard.logs.warnCount }}</strong>
        </div>
        <div class="metric" :class="{ warn: dashboard.logs.slowRequestCount > 0 }">
          <span>24h 慢请求 (&gt;5s)</span>
          <strong>{{ dashboard.logs.slowRequestCount }}</strong>
        </div>
        <div class="metric">
          <span>内存 RSS</span>
          <strong>{{ memoryMB?.rss || '-' }} MB</strong>
        </div>
        <div class="metric">
          <span>Heap 使用</span>
          <strong>{{ memoryMB?.heapUsed || '-' }} / {{ memoryMB?.heapTotal || '-' }} MB</strong>
        </div>
        <div v-if="dashboard.databases.monthly" class="metric">
          <span>Monthly DB</span>
          <strong>{{ formatBytes(dashboard.databases.monthly.sizeBytes) }}</strong>
        </div>
        <div class="metric">
          <span>总日志数 (24h)</span>
          <strong>{{ dashboard.logs.totalLogs }}</strong>
        </div>
      </div>
    </section>

    <!-- 模型状态 -->
    <section v-if="dashboard.models" class="panel">
      <div class="panel-header"><strong>OCR 模型</strong></div>
      <div class="panel-body grid-metrics">
        <div class="metric" :class="{ warn: !dashboard.models.enabled }">
          <span>模型流水线</span>
          <strong>{{ dashboard.models.enabled ? '已启用' : '已关闭' }}</strong>
        </div>
        <div class="metric" :class="{ warn: !dashboard.models.detection }">
          <span>区域检测</span>
          <strong>{{ dashboard.models.detection ? '就绪' : '未就绪' }}</strong>
        </div>
        <div class="metric" :class="{ warn: !dashboard.models.classification }">
          <span>文档分类</span>
          <strong>{{ dashboard.models.classification ? '就绪' : '未就绪' }}</strong>
        </div>
        <div class="metric" :class="{ warn: !dashboard.models.passportField }">
          <span>护照字段</span>
          <strong>{{ dashboard.models.passportField ? '就绪' : '未就绪' }}</strong>
        </div>
        <div class="metric" :class="{ warn: !dashboard.models.receiptField }">
          <span>小票字段</span>
          <strong>{{ dashboard.models.receiptField ? '就绪' : '未就绪' }}</strong>
        </div>
      </div>
    </section>

    <!-- 阶段任务 -->
    <section v-if="dashboard.stageJobs" class="panel">
      <div class="panel-header"><strong>阶段任务</strong></div>
      <div class="panel-body">
        <div v-if="dashboard.stageJobs.running.length" class="running-stages">
          <h3>⚠ 运行中</h3>
          <ul>
            <li v-for="job in dashboard.stageJobs.running" :key="`${job.workspace_key}-${job.stage}-${job.started_at}`">
              {{ job.stage }} · {{ job.workspace_key }} · 开始于 {{ fmtTime(job.started_at) }}
            </li>
          </ul>
        </div>
        <p v-else class="hint">当前没有运行中的阶段任务</p>

        <h3>最近 24 小时</h3>
        <table class="rows-table">
          <thead>
            <tr>
              <th>阶段</th>
              <th>Workspace</th>
              <th>状态</th>
              <th>开始</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!dashboard.stageJobs.recent.length">
              <td colspan="4" class="hint">无</td>
            </tr>
            <tr v-for="job in dashboard.stageJobs.recent" :key="`${job.workspace_key}-${job.stage}-${job.started_at}`">
              <td>{{ job.stage }}</td>
              <td>{{ job.workspace_key }}</td>
              <td :class="job.status">{{ job.status }}</td>
              <td>{{ fmtTime(job.started_at) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 最近错误 -->
    <section v-if="dashboard.logs.recentErrors?.length" class="panel">
      <div class="panel-header">
        <strong>最近 5 条错误</strong>
        <router-link :to="{ name: 'admin-logs', query: { level: 'error' } }">查看全部</router-link>
      </div>
      <div class="panel-body">
        <div v-for="(log, idx) in dashboard.logs.recentErrors" :key="idx" class="error-entry">
          <div class="error-meta">
            <span>{{ fmtTime(log.time) }}</span>
            <span class="event-tag">{{ log.event || '-' }}</span>
          </div>
          <div class="error-msg">{{ log.msg || log.err?.message || '-' }}</div>
        </div>
      </div>
    </section>

    <!-- 事件分布 -->
    <section v-if="dashboard.logs.byEvent?.length" class="panel">
      <div class="panel-header"><strong>24h 事件分布</strong></div>
      <div class="panel-body">
        <ul class="event-list">
          <li v-for="item in dashboard.logs.byEvent" :key="item.event">
            <code>{{ item.event }}</code>
            <span class="event-count">{{ item.count }}</span>
          </li>
        </ul>
      </div>
    </section>
  </template>
</template>

<style scoped>
.page-actions { display: flex; gap: 12px; align-items: center; }
.grid-metrics { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
.metric { background: #f6f7f9; border-radius: 8px; padding: 12px; }
.metric.warn { background: #fef3c7; color: #92400e; }
.metric span { display: block; color: #6b7280; font-size: 12px; }
.metric strong { font-size: 20px; }
.running-stages { background: #fef3c7; padding: 12px; border-radius: 6px; margin-bottom: 12px; }
.running-stages h3 { margin-top: 0; color: #92400e; }
.rows-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.rows-table th, .rows-table td { border-bottom: 1px solid #e5e7eb; padding: 6px 8px; text-align: left; }
.rows-table .succeeded { color: var(--success); } /* 0729 绿删补漏:成功=正常态,灰阶 */
.rows-table .failed, .rows-table .cancelled { color: #dc2626; }
.rows-table .running { color: #d97706; }
.error-entry { padding: 8px; border-left: 3px solid #dc2626; margin-bottom: 8px; background: #fef2f2; }
.error-meta { font-size: 11px; color: #6b7280; display: flex; gap: 8px; }
.event-tag { background: #e5e7eb; padding: 1px 6px; border-radius: 3px; font-family: monospace; }
.error-msg { margin-top: 4px; font-family: monospace; font-size: 12px; }
.event-list { list-style: none; padding: 0; display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; }
.event-list li { display: flex; justify-content: space-between; padding: 4px 8px; background: #f6f7f9; border-radius: 4px; font-size: 12px; }
.event-list code { font-family: monospace; }
.event-count { font-weight: 500; }
.error-text { color: #dc2626; }
.hint { color: #6b7280; font-size: 12px; }
</style>
