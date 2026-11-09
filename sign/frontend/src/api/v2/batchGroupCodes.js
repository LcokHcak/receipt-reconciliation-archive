import api from '../client'

function base(workspaceKey) {
  return `/monthly/workspaces/${encodeURIComponent(workspaceKey)}`
}

export function fetchBatchGroupCodeModes(workspaceKey, batchId) {
  return api.get(`${base(workspaceKey)}/batch-group-codes/modes`, {
    params: { batchId },
  })
}

export function fetchBatchGroupCodes(workspaceKey, params = {}) {
  return api.get(`${base(workspaceKey)}/batch-group-codes`, { params })
}
