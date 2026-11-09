import api from '../client'

function base(workspaceKey) {
  return `/monthly/workspaces/${encodeURIComponent(workspaceKey)}`
}

const EXPORT_TIMEOUT_MS = 10 * 60 * 1000

export function runReceivedReceiptExport(workspaceKey) {
  return api.post(`${base(workspaceKey)}/exports/received-receipt`, {}, { timeout: EXPORT_TIMEOUT_MS })
}

export function fetchFinalDeliveryReadiness(workspaceKey) {
  return api.get(`${base(workspaceKey)}/exports/final-delivery/readiness`)
}

export function runFinalDeliveryExport(workspaceKey, options = {}) {
  return api.post(`${base(workspaceKey)}/exports/final-delivery`, options, { timeout: EXPORT_TIMEOUT_MS })
}

export function fetchExportFiles(workspaceKey, params = {}) {
  return api.get(`${base(workspaceKey)}/exports/files`, { params })
}

export function downloadExportUrl(workspaceKey, filename) {
  return `/api${base(workspaceKey)}/exports/files/${encodeURIComponent(filename)}`
}
