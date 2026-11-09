import api from './client'

// 代理工作台 V2 API(后端 routes/agent_workspace_routes.js,前缀 /agent-workspace/v1)。
// 客户端 baseURL 已含 /api;这里只拼相对路径。列表参数由 store 统一组装。

const BASE = '/agent-workspace/v1'

function query(params = {}) {
  const usp = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    const v = String(value == null ? '' : value).trim()
    if (v) usp.set(key, v)
  }
  const s = usp.toString()
  return s ? `?${s}` : ''
}

export function fetchWorkspaceMonths() {
  return api.get(`${BASE}/months`)
}

export function fetchWorkspaceSummary(params) {
  return api.get(`${BASE}/summary${query(params)}`)
}

export function fetchWorkspaceAgents(params) {
  return api.get(`${BASE}/agents${query(params)}`)
}

export function fetchWorkspaceCustomers(params) {
  return api.get(`${BASE}/customers${query(params)}`)
}

export function fetchWorkspaceTasks(params) {
  return api.get(`${BASE}/tasks${query(params)}`)
}

export function completeWorkspaceTask(taskId, { note = '', expectedVersion } = {}) {
  return api.post(`${BASE}/tasks/${encodeURIComponent(taskId)}/complete`, {
    note,
    ...(expectedVersion == null ? {} : { expectedVersion }),
  })
}

// ── B 页:未收客户组(P2,2026-07-16)──

export function fetchUnreceivedWorkspaces() {
  return api.get(`${BASE}/unreceived/workspaces`)
}

export function fetchUnreceived(params) {
  return api.get(`${BASE}/unreceived${query(params)}`)
}

// xlsx 下载走浏览器直链(cookie 鉴权自动带);baseURL 已含 /api,这里手工拼全路径
export function unreceivedExportUrl(workspaceKey) {
  return `/api${BASE}/unreceived/export?workspaceKey=${encodeURIComponent(workspaceKey)}`
}

// 「无需补」豁免/恢复(P3;reviewer 及以上,finance 只读 403)
export function waiveUnreceived({ workspaceKey, items, note = '' }) {
  return api.post(`${BASE}/unreceived/waive`, { workspaceKey, items, note })
}

export function unwaiveUnreceived({ workspaceKey, itemKeys }) {
  return api.post(`${BASE}/unreceived/unwaive`, { workspaceKey, itemKeys })
}
