import api from '../client'

function base(workspaceKey) {
  return `/monthly/workspaces/${encodeURIComponent(workspaceKey)}`
}

export function fetchLedger(workspaceKey, params = {}) {
  return api.get(`${base(workspaceKey)}/ledger`, { params })
}

export function fetchLedgerStatusCounts(workspaceKey, params = {}) {
  return api.get(`${base(workspaceKey)}/ledger/status-counts`, { params })
}

// 按团号匹配状态分组的计数。注意跟上面那个**不是一个维度**:
// status-counts 按 ledger_status 分组,这个按 tour_match_status 分组,
// 后者才是「异常补救」页的口径(团号没命中/日期越界/代理不符/模式无法归类)。
// 只回 {status, n},专给审核台页签的承接角标用。
export function fetchLedgerTourStatusCounts(workspaceKey, params = {}) {
  return api.get(`${base(workspaceKey)}/ledger/tour-status-counts`, { params })
}

// payload = { purchaseDate?, tourNo?, agent?, modeRaw? }
export function updateLedgerFields(workspaceKey, id, payload) {
  return api.patch(`${base(workspaceKey)}/ledger/${id}/fields`, payload)
}

export function deleteLedgerRow(workspaceKey, id) {
  return api.delete(`${base(workspaceKey)}/ledger/${id}`)
}
