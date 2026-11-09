// F7: Sprint F — v2 errors API 包装。
// 走 F1 axios client;端点契约对齐 v1。
import api from '../client'

function base(workspaceKey) {
  return `/monthly/workspaces/${encodeURIComponent(workspaceKey)}`
}

// → { rows, summary: [{ error_type, status, count }] }
export function fetchErrors(workspaceKey, params = {}) {
  return api.get(`${base(workspaceKey)}/errors`, { params })
}

// → { totalErrors, byType, departureSync? }
export function runCrossCheck(workspaceKey, { withDepartureSync = false } = {}) {
  return api.post(`${base(workspaceKey)}/cross-check`, { withDepartureSync })
}

// → { rewritten, audit: [...] }
export function runDepartureSync(workspaceKey) {
  return api.post(`${base(workspaceKey)}/departure-sync`)
}

// → { rows, total }
export function fetchDepartureSyncAudit(workspaceKey, params = {}) {
  return api.get(`${base(workspaceKey)}/departure-sync/audit`, { params })
}

// → { ok: true }
export function resolveError(workspaceKey, id, note = '') {
  return api.post(`${base(workspaceKey)}/errors/${id}/resolve`, { note })
}
