// F9b: Sprint F — v2 badcase API 包装。走 F1 axios client。
import api from '../client'

function base(workspaceKey) {
  return `/monthly/workspaces/${encodeURIComponent(workspaceKey)}`
}

// params: { stage?, kind?, verdict?, ruleVersion?, limit?, offset? } → { rows, total }
export function fetchBadcases(workspaceKey, params = {}) {
  return api.get(`${base(workspaceKey)}/badcases`, { params })
}

// → { byStageKind: [...], byVerdict: [...] }
export function fetchBadcaseSummary(workspaceKey) {
  return api.get(`${base(workspaceKey)}/badcases/summary`)
}

// → full row including snapshot
export function fetchBadcaseDetail(workspaceKey, id) {
  return api.get(`${base(workspaceKey)}/badcases/${encodeURIComponent(id)}`)
}

// body: { userNote, userVerdict }
export function submitBadcaseVerdict(workspaceKey, id, { userNote = null, userVerdict = 'pending' } = {}) {
  return api.post(
    `${base(workspaceKey)}/badcases/${encodeURIComponent(id)}/verdict`,
    { userNote, userVerdict },
  )
}
