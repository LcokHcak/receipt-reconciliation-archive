// G0: 撤掉 F1 时遗留的 silent mock fallback。后端 audit_log 路由 F2 已
// 加 503 硬化,生产中如果挂了应该让用户看到错误而不是悄悄退化到 mock —
// 否则运维察觉不到。401 由 interceptor 提前重定向,不影响这里。
import api from '../client'

async function fetchDistinct(path) {
  const payload = await api.get(`/audit/distinct/${path}`)
  return payload?.values || payload?.items || []
}

export async function fetchAuditLogs({
  action = null,
  userId = null,
  workspaceKey = null,
  resourceType = null,
  startDate = null,
  endDate = null,
  limit = 100,
  offset = 0,
} = {}) {
  const params = {}
  if (action)       params.action = action
  if (userId)       params.userId = userId
  if (workspaceKey) params.workspaceKey = workspaceKey
  if (resourceType) params.resourceType = resourceType
  if (startDate)    params.startDate = startDate
  if (endDate)      params.endDate = endDate
  params.limit = limit
  params.offset = offset

  const payload = await api.get('/audit/logs', { params })
  return payload?.logs || payload?.items || []
}

export function fetchDistinctActions()       { return fetchDistinct('actions') }
export function fetchDistinctUsers()         { return fetchDistinct('users') }
export function fetchDistinctWorkspaces()    { return fetchDistinct('workspaces') }
export function fetchDistinctResourceTypes() { return fetchDistinct('resource-types') }
