<script setup>
/**
 * AdminUsersView — admin 后台员工管理。
 * 仅 admin 角色可访问（路由 meta.roles 已强制）。
 *
 * 功能：
 *   - 列出所有员工（含已停用）
 *   - 添加员工：账号 / 密码 / 角色 / 中文姓名 / 员工编号（agent_code）
 *   - 修改员工资料（不含密码）
 *   - 重置密码
 *   - 停用员工（软删除）
 */

import { computed, onMounted, reactive, ref } from 'vue'
import api from '../api/client'

const users = ref([])
const roles = ref([])
const loading = ref(false)
const error = ref('')
const message = ref('')

const showCreate = ref(false)
const createForm = reactive({
  username: '',
  password: '',
  role: 'reviewer',
  displayName: '',
  agentCode: '',
  email: '',
})

const editingUser = ref(null)
const editForm = reactive({
  username: '',
  role: 'reviewer',
  displayName: '',
  agentCode: '',
  email: '',
  isActive: 1,
})

const resetTarget = ref(null)
const resetPassword = ref('')

function setMessage(text) {
  message.value = text
  error.value = ''
  setTimeout(() => {
    if (message.value === text) message.value = ''
  }, 3500)
}

function setError(err) {
  error.value = err?.response?.data?.error || err?.message || String(err || '')
  message.value = ''
}

async function loadUsers() {
  loading.value = true
  error.value = ''
  try {
    const payload = await api.get('/admin/users')
    users.value = payload.users || []
    roles.value = payload.roles?.length ? payload.roles : ['admin', 'reviewer', 'finance']
  } catch (err) {
    setError(err)
  } finally {
    loading.value = false
  }
}

function resetCreateForm() {
  createForm.username = ''
  createForm.password = ''
  createForm.role = 'reviewer'
  createForm.displayName = ''
  createForm.agentCode = ''
  createForm.email = ''
}

async function submitCreate() {
  if (!createForm.username.trim() || !createForm.password.trim()) {
    setError('账号和密码不能为空')
    return
  }
  if (createForm.password.length < 6) {
    setError('密码至少 6 位')
    return
  }
  try {
    await api.post('/admin/users', { ...createForm })
    setMessage(`已添加员工 ${createForm.username}`)
    showCreate.value = false
    resetCreateForm()
    await loadUsers()
  } catch (err) {
    setError(err)
  }
}

function startEdit(user) {
  editingUser.value = user
  editForm.username = user.username
  editForm.role = roles.value.includes(user.role) ? user.role : 'reviewer'
  editForm.displayName = user.display_name || ''
  editForm.agentCode = user.agent_code || ''
  editForm.email = user.email || ''
  editForm.isActive = user.is_active
}

function cancelEdit() {
  editingUser.value = null
}

async function submitEdit() {
  if (!editingUser.value) return
  try {
    await api.patch(`/admin/users/${editingUser.value.id}`, { ...editForm })
    setMessage('已更新')
    editingUser.value = null
    await loadUsers()
  } catch (err) {
    setError(err)
  }
}

function startReset(user) {
  resetTarget.value = user
  resetPassword.value = ''
}

function cancelReset() {
  resetTarget.value = null
  resetPassword.value = ''
}

async function submitReset() {
  if (!resetTarget.value) return
  if (resetPassword.value.length < 6) {
    setError('新密码至少 6 位')
    return
  }
  try {
    await api.post(`/admin/users/${resetTarget.value.id}/reset-password`, { password: resetPassword.value })
    setMessage(`已重置 ${resetTarget.value.username} 的密码`)
    resetTarget.value = null
    resetPassword.value = ''
  } catch (err) {
    setError(err)
  }
}

async function deactivate(user) {
  if (!window.confirm(`确认停用员工 ${user.username}（${user.display_name || ''}）？\n停用后不能登录，但历史数据保留。`)) {
    return
  }
  try {
    await api.delete(`/admin/users/${user.id}`)
    setMessage('已停用')
    await loadUsers()
  } catch (err) {
    setError(err)
  }
}

const activeUsers = computed(() => users.value.filter((u) => u.is_active === 1))
const inactiveUsers = computed(() => users.value.filter((u) => u.is_active !== 1))

const ROLE_LABELS = {
  admin: '管理员',
  reviewer: '审核员',
  finance: '财务',
}

function roleLabel(role) {
  return ROLE_LABELS[role] || role
}

onMounted(loadUsers)
</script>

<template>
  <section class="page-title">
    <div>
      <h1>员工管理</h1>
      <p>添加员工账号、分配角色与员工编号（用于收票汇总 sheet 分组）。</p>
    </div>
    <div class="page-actions">
      <button class="ghost-button" type="button" :disabled="loading" @click="loadUsers">
        {{ loading ? '加载中' : '刷新' }}
      </button>
      <button class="primary-button" type="button" @click="showCreate = true">
        + 添加员工
      </button>
    </div>
  </section>

  <section v-if="error || message" class="notice-panel">
    <span v-if="error" class="error-text">{{ error }}</span>
    <span v-else class="success-text">{{ message }}</span>
  </section>

  <!-- 创建员工弹框 -->
  <section v-if="showCreate" class="panel modal-panel">
    <div class="panel-header">
      <strong>添加员工</strong>
      <button class="ghost-button small" type="button" @click="showCreate = false">关闭</button>
    </div>
    <div class="panel-body form-grid">
      <div class="field">
        <label>登录账号 *</label>
        <input v-model="createForm.username" placeholder="例如 alice">
      </div>
      <div class="field">
        <label>初始密码 * （≥6 位）</label>
        <input v-model="createForm.password" type="password" placeholder="设置一个密码">
      </div>
      <div class="field">
        <label>角色 *</label>
        <select v-model="createForm.role">
          <option v-for="r in roles" :key="r" :value="r">{{ roleLabel(r) }}</option>
        </select>
      </div>
      <div class="field">
        <label>中文姓名</label>
        <input v-model="createForm.displayName" placeholder="例如 侯丹妮">
      </div>
      <div class="field">
        <label>员工编号 <em class="muted">（用于收票汇总 sheet 分组）</em></label>
        <input v-model="createForm.agentCode" placeholder="例如 9号">
      </div>
      <div class="field">
        <label>邮箱（可选）</label>
        <input v-model="createForm.email" placeholder="可选">
      </div>
    </div>
    <div class="panel-body" style="border-top: 1px solid var(--line);">
      <div class="action-row">
        <button class="primary-button" type="button" @click="submitCreate">保存</button>
        <button class="ghost-button" type="button" @click="showCreate = false">取消</button>
      </div>
    </div>
  </section>

  <!-- 重置密码弹框 -->
  <section v-if="resetTarget" class="panel modal-panel">
    <div class="panel-header">
      <strong>重置密码：{{ resetTarget.username }} ({{ resetTarget.display_name || '-' }})</strong>
      <button class="ghost-button small" type="button" @click="cancelReset">关闭</button>
    </div>
    <div class="panel-body">
      <div class="field">
        <label>新密码（≥6 位）</label>
        <input v-model="resetPassword" type="password" placeholder="输入新密码">
      </div>
      <div class="action-row">
        <button class="primary-button" type="button" @click="submitReset">确认重置</button>
        <button class="ghost-button" type="button" @click="cancelReset">取消</button>
      </div>
    </div>
  </section>

  <!-- 用户列表 -->
  <section class="panel">
    <div class="panel-header">
      <strong>启用中的员工</strong>
      <span class="count">{{ activeUsers.length }} 人</span>
    </div>
    <table v-if="activeUsers.length" class="table">
      <thead>
        <tr>
          <th>账号</th>
          <th>姓名</th>
          <th>员工编号</th>
          <th>角色</th>
          <th>最后登录</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="user in activeUsers" :key="user.id">
          <tr v-if="editingUser?.id !== user.id">
            <td><strong>{{ user.username }}</strong></td>
            <td>{{ user.display_name || '-' }}</td>
            <td>{{ user.agent_code || '-' }}</td>
            <td><span class="status">{{ roleLabel(user.role) }}</span></td>
            <td>{{ user.last_login_at ? user.last_login_at.slice(0, 16).replace('T', ' ') : '从未登录' }}</td>
            <td class="action-cell">
              <button class="ghost-button small" type="button" @click="startEdit(user)">编辑</button>
              <button class="ghost-button small" type="button" @click="startReset(user)">改密</button>
              <button class="danger-button small" type="button" @click="deactivate(user)">停用</button>
            </td>
          </tr>
          <tr v-else class="edit-row">
            <td><input v-model="editForm.username"></td>
            <td><input v-model="editForm.displayName"></td>
            <td><input v-model="editForm.agentCode"></td>
            <td>
              <select v-model="editForm.role">
                <option v-for="r in roles" :key="r" :value="r">{{ roleLabel(r) }}</option>
              </select>
            </td>
            <td>{{ user.last_login_at ? user.last_login_at.slice(0, 16).replace('T', ' ') : '从未登录' }}</td>
            <td class="action-cell">
              <button class="primary-button small" type="button" @click="submitEdit">保存</button>
              <button class="ghost-button small" type="button" @click="cancelEdit">取消</button>
            </td>
          </tr>
        </template>
      </tbody>
    </table>
    <div v-else-if="loading" class="empty">加载中…</div>
    <div v-else class="empty">暂无启用中的员工</div>
  </section>

  <section v-if="inactiveUsers.length" class="panel" style="margin-top: 14px;">
    <div class="panel-header">
      <strong>已停用员工</strong>
      <span class="count">{{ inactiveUsers.length }} 人</span>
    </div>
    <table class="table">
      <thead>
        <tr>
          <th>账号</th>
          <th>姓名</th>
          <th>员工编号</th>
          <th>角色</th>
          <th>停用时间</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="user in inactiveUsers" :key="user.id" class="muted-row">
          <td>{{ user.username }}</td>
          <td>{{ user.display_name || '-' }}</td>
          <td>{{ user.agent_code || '-' }}</td>
          <td>{{ roleLabel(user.role) }}</td>
          <td>{{ user.updated_at ? user.updated_at.slice(0, 16).replace('T', ' ') : '-' }}</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<style scoped>
.modal-panel {
  border-left: 3px solid var(--accent);
  margin-bottom: 14px;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.action-cell {
  display: flex;
  gap: 6px;
}

.edit-row td {
  background: var(--accent-weak);
}

.edit-row input,
.edit-row select {
  width: 100%;
  height: 32px;
  border: 1px solid var(--line-strong);
  border-radius: 4px;
  padding: 0 8px;
  background: #fff;
}

.muted-row td {
  color: var(--muted);
  font-style: italic;
}

.field em.muted {
  font-style: normal;
  font-size: 11px;
}
</style>
