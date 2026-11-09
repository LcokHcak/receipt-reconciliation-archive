// F1: Sprint F — 统一走 axios client。
import api from '../client'

export function fetchOrphanBills(workspaceKey, params = {}) {
  return api.get(`/monthly/v2/${encodeURIComponent(workspaceKey)}/orphans/bills`, { params })
}

export function fetchOrphanRows(workspaceKey, params = {}) {
  return api.get(`/monthly/v2/${encodeURIComponent(workspaceKey)}/orphans/rows`, { params })
}
