<script setup>
import { onMounted, ref, watch } from 'vue'
import { fetchAdminFeedback, resolveAdminFeedback } from '../api/admin'

const status = ref('open')
const rows = ref([])
const total = ref(0)
const loading = ref(false)
const error = ref('')
const message = ref('')
const selected = ref(null)
const resolution = ref('')

async function load() {
  loading.value = true
  error.value = ''
  try {
    const result = await fetchAdminFeedback({ status: status.value || undefined, limit: 100 })
    rows.value = result.rows || []
    total.value = result.total || 0
  } catch (err) {
    error.value = err?.response?.data?.error || err?.message || String(err)
  } finally {
    loading.value = false
  }
}

function openDetail(row) {
  selected.value = row
  resolution.value = ''
  error.value = ''
}

function closeDetail() {
  selected.value = null
  resolution.value = ''
}

async function submitResolve() {
  if (!selected.value) return
  if (!confirm('确认关闭这条反馈？')) return
  try {
    await resolveAdminFeedback(selected.value.id, resolution.value)
    message.value = '已关闭反馈'
    closeDetail()
    await load()
  } catch (err) {
    error.value = err?.response?.data?.error || err?.message || String(err)
  }
}

function fmtTime(t) { return t ? new Date(t).toLocaleString('zh-CN') : '-' }

watch(status, load)
onMounted(load)
</script>

<template>
  <section class="page-title">
    <div>
      <h1>用户反馈</h1>
      <p>团队成员通过页面右下角"反馈问题"按钮提交的报告</p>
    </div>
    <div class="page-actions">
      <select v-model="status">
        <option value="open">未处理</option>
        <option value="resolved">已处理</option>
        <option value="">全部</option>
      </select>
      <button type="button" :disabled="loading" @click="load">刷新</button>
      <router-link :to="{ name: 'admin-dashboard' }">← 仪表盘</router-link>
    </div>
  </section>

  <p v-if="message" class="status-message">{{ message }}</p>
  <p v-if="error" class="error-text">{{ error }}</p>

  <section class="panel">
    <div class="panel-header">
      <strong>反馈列表（共 {{ total }} 条）</strong>
    </div>
    <div class="panel-body">
      <table class="rows-table">
        <thead>
          <tr>
            <th>id</th>
            <th>用户</th>
            <th>时间</th>
            <th>页面</th>
            <th>状态</th>
            <th>描述</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="!rows.length">
            <td colspan="7" class="hint">暂无</td>
          </tr>
          <tr v-for="row in rows" :key="row.id" :class="row.status">
            <td>#{{ row.id }}</td>
            <td>{{ row.username || '-' }}</td>
            <td>{{ fmtTime(row.created_at) }}</td>
            <td class="page-url">{{ row.page_url || '-' }}</td>
            <td>{{ row.status }}</td>
            <td class="description">{{ row.description }}</td>
            <td><button type="button" @click="openDetail(row)">查看</button></td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>

  <section v-if="selected" class="panel modal-panel">
    <div class="panel-header">
      <strong>反馈 #{{ selected.id }}</strong>
      <button type="button" @click="closeDetail">关闭</button>
    </div>
    <div class="panel-body">
      <p><strong>用户：</strong>{{ selected.username || '-' }}</p>
      <p><strong>时间：</strong>{{ fmtTime(selected.created_at) }}</p>
      <p><strong>页面：</strong><code>{{ selected.page_url || '-' }}</code></p>
      <p>
        <strong>请求 ID：</strong><code>{{ selected.request_id || '-' }}</code>
        <span v-if="selected.request_id" class="hint">
          （在日志页面用这个 ID 搜索可找到当时的全部请求）
        </span>
      </p>
      <p><strong>浏览器：</strong><code class="ua">{{ selected.user_agent || '-' }}</code></p>
      <div class="description-box">
        <strong>用户描述：</strong>
        <pre>{{ selected.description }}</pre>
      </div>
      <template v-if="selected.status === 'open'">
        <div class="field">
          <label>处理备注</label>
          <textarea v-model="resolution" rows="3" placeholder="说明如何处理的（可留空）" />
        </div>
        <div class="actions">
          <button type="button" class="primary-button" @click="submitResolve">标记为已处理</button>
        </div>
      </template>
      <template v-else>
        <p><strong>处理人：</strong>{{ selected.resolved_by || '-' }}</p>
        <p><strong>处理时间：</strong>{{ fmtTime(selected.resolved_at) }}</p>
        <p v-if="selected.resolution"><strong>处理备注：</strong>{{ selected.resolution }}</p>
      </template>
    </div>
  </section>
</template>

<style scoped>
.page-actions { display: flex; gap: 12px; align-items: center; }
.rows-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.rows-table th, .rows-table td { border-bottom: 1px solid #e5e7eb; padding: 6px 8px; text-align: left; vertical-align: top; }
.rows-table tr.open { background: #fef3c7; }
.rows-table .page-url, .rows-table .description { max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rows-table .description { white-space: pre-wrap; }
.modal-panel { border: 2px solid #2563eb; margin-top: 16px; }
.modal-panel code { background: #f3f4f6; padding: 2px 4px; font-size: 12px; }
.modal-panel .ua { font-size: 10px; word-break: break-all; }
.description-box { background: #f9fafb; padding: 12px; border-radius: 6px; margin: 12px 0; }
.description-box pre { white-space: pre-wrap; font-family: inherit; margin-top: 6px; }
.field { display: flex; flex-direction: column; gap: 4px; margin: 12px 0; }
.field textarea { width: 100%; }
.actions { display: flex; gap: 8px; }
.status-message { color: var(--success); } /* 0729 绿删补漏:成功提示走灰阶 */
.error-text { color: #dc2626; }
.hint { color: #6b7280; font-size: 12px; }
</style>
