<script setup>
import { onMounted, onBeforeUnmount, ref } from 'vue'
import { fetchAdminLogs } from '../api/admin'

const filters = ref({
  source: 'app',
  level: '',
  q: '',
  event: '',
  startTime: '',
  endTime: '',
  maxLines: 500,
})

const logs = ref([])
const loading = ref(false)
const error = ref('')
const autoRefresh = ref(false)
let refreshTimer = null
const expandedRows = ref(new Set())

async function load() {
  loading.value = true
  error.value = ''
  try {
    const params = {}
    Object.entries(filters.value).forEach(([k, v]) => {
      if (v !== '' && v != null) params[k] = v
    })
    const result = await fetchAdminLogs(params)
    logs.value = result.logs || []
  } catch (err) {
    error.value = err?.response?.data?.error || err?.message || String(err)
  } finally {
    loading.value = false
  }
}

function toggleExpanded(idx) {
  if (expandedRows.value.has(idx)) {
    expandedRows.value.delete(idx)
  } else {
    expandedRows.value.add(idx)
  }
  expandedRows.value = new Set(expandedRows.value)
}

function toggleAutoRefresh() {
  autoRefresh.value = !autoRefresh.value
  if (autoRefresh.value) {
    refreshTimer = setInterval(load, 5000)
  } else if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
}

function levelClass(label) {
  return `level-${label}`
}

function fmtTime(t) {
  return t ? new Date(t).toLocaleString('zh-CN') : '-'
}

function summarize(log) {
  const parts = []
  if (log.msg) parts.push(log.msg)
  if (log.event) parts.push(`[${log.event}]`)
  if (log.err?.message) parts.push(log.err.message)
  if (log.route) parts.push(log.route)
  if (log.stage) parts.push(`stage=${log.stage}`)
  if (log.workspaceKey) parts.push(`ws=${log.workspaceKey}`)
  if (log.durationMs != null) parts.push(`${log.durationMs}ms`)
  return parts.join(' · ')
}

onMounted(load)

onBeforeUnmount(() => {
  if (refreshTimer) clearInterval(refreshTimer)
})
</script>

<template>
  <section class="page-title">
    <div>
      <h1>系统日志</h1>
      <p>查看最近的运行日志、错误和警告</p>
    </div>
    <div class="page-actions">
      <router-link :to="{ name: 'admin-dashboard' }">← 仪表盘</router-link>
      <button type="button" :class="{ active: autoRefresh }" @click="toggleAutoRefresh">
        {{ autoRefresh ? '⏸ 停止自动刷新' : '▶ 每 5 秒刷新' }}
      </button>
      <button type="button" :disabled="loading" @click="load">立即刷新</button>
    </div>
  </section>

  <section class="panel">
    <div class="panel-header"><strong>过滤</strong></div>
    <div class="panel-body filter-grid">
      <label>日志来源
        <select v-model="filters.source" @change="load">
          <option value="app">app.log（全部）</option>
          <option value="error">error.log（仅错误）</option>
        </select>
      </label>
      <label>级别
        <select v-model="filters.level" @change="load">
          <option value="">全部</option>
          <option value="error">error</option>
          <option value="warn">warn</option>
          <option value="info">info</option>
          <option value="debug">debug</option>
        </select>
      </label>
      <label>事件名
        <input v-model="filters.event" placeholder="如 stage_failed" @change="load">
      </label>
      <label>关键词
        <input v-model="filters.q" placeholder="如 EA12345678" @keyup.enter="load">
      </label>
      <label>开始时间
        <input v-model="filters.startTime" type="datetime-local" @change="load">
      </label>
      <label>结束时间
        <input v-model="filters.endTime" type="datetime-local" @change="load">
      </label>
      <label>最多读取
        <select v-model.number="filters.maxLines" @change="load">
          <option :value="200">200</option>
          <option :value="500">500</option>
          <option :value="1000">1000</option>
          <option :value="2000">2000</option>
          <option :value="5000">5000</option>
        </select>
      </label>
    </div>
  </section>

  <p v-if="error" class="error-text">{{ error }}</p>

  <section class="panel">
    <div class="panel-header">
      <strong>结果（{{ logs.length }} 条）</strong>
      <span v-if="loading" class="hint">加载中…</span>
    </div>
    <div class="panel-body">
      <p v-if="!logs.length" class="hint">没有匹配的日志</p>
      <div v-else class="log-list">
        <div
          v-for="(log, idx) in logs"
          :key="idx"
          class="log-entry"
          :class="levelClass(log.levelLabel)"
        >
          <div class="log-line" @click="toggleExpanded(idx)">
            <span class="log-time">{{ fmtTime(log.time) }}</span>
            <span class="log-level">{{ log.levelLabel }}</span>
            <span class="log-summary">{{ summarize(log) }}</span>
            <span class="log-toggle">{{ expandedRows.has(idx) ? '▼' : '▶' }}</span>
          </div>
          <pre v-if="expandedRows.has(idx)" class="log-detail">{{ JSON.stringify(log, null, 2) }}</pre>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.page-actions { display: flex; gap: 12px; align-items: center; }
.page-actions .active { background: #fef3c7; color: #92400e; }
.filter-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
.filter-grid label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #6b7280; }
.filter-grid input, .filter-grid select { padding: 4px 8px; }
.log-list { max-height: 70vh; overflow-y: auto; }
.log-entry { border-bottom: 1px solid #e5e7eb; }
.log-entry.level-error { border-left: 3px solid #dc2626; background: #fef2f2; }
.log-entry.level-warn { border-left: 3px solid #d97706; background: #fffbeb; }
.log-entry.level-info { border-left: 3px solid #2563eb; }
.log-entry.level-debug { border-left: 3px solid #9ca3af; }
.log-line { display: flex; gap: 12px; padding: 6px 12px; cursor: pointer; font-family: monospace; font-size: 12px; align-items: center; }
.log-line:hover { background: rgba(0,0,0,0.03); }
.log-time { color: #6b7280; min-width: 160px; }
.log-level { min-width: 50px; font-weight: 500; }
.level-error .log-level { color: #dc2626; }
.level-warn .log-level { color: #d97706; }
.level-info .log-level { color: #2563eb; }
.level-debug .log-level { color: #6b7280; }
.log-summary { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.log-toggle { color: #6b7280; font-size: 10px; }
.log-detail { background: #1f2937; color: #f3f4f6; padding: 12px; margin: 0; overflow-x: auto; font-size: 11px; max-height: 400px; }
.error-text { color: #dc2626; }
.hint { color: #6b7280; font-size: 12px; }
</style>
