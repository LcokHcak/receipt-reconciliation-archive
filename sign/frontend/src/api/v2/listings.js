// F9a: Sprint F — v2 通用列表 API (missing/stage-jobs/reconciliation)。
// 走 F1 axios client。
import api from '../client'

function base(workspaceKey) {
  return `/monthly/workspaces/${encodeURIComponent(workspaceKey)}`
}

// params: { status?, limit?, offset? } → { rows, total }
export function fetchMissing(workspaceKey, params = {}) {
  return api.get(`${base(workspaceKey)}/missing`, { params })
}

// params: { stage?, status?, limit?, offset? } → { rows, total }
export function fetchStageJobs(workspaceKey, params = {}) {
  return api.get(`${base(workspaceKey)}/stage-jobs`, { params })
}

// → { rows: [...] } running stage jobs (for the running-now indicator)
export function fetchRunningStageJobs(workspaceKey) {
  return api.get(`${base(workspaceKey)}/stage-jobs/running`)
}

// stage_job 完整日志的下载 URL (浏览器直链)
export function stageJobLogUrl(workspaceKey, id) {
  return `/api${base(workspaceKey)}/stage-jobs/${encodeURIComponent(id)}/log`
}

// → { metrics?, formulas? } 月度对账数值核对
export function fetchReconciliation(workspaceKey, params = {}) {
  return api.get(`${base(workspaceKey)}/reconciliation`, { params })
}
