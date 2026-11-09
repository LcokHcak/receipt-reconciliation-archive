// F5: Sprint F — v2 bills + group codes API 包装。
// 走 F1 axios client；自持薄包装避免 F10 删 v1 时连带断。
import api from '../client'

function base(workspaceKey) {
  return `/monthly/workspaces/${encodeURIComponent(workspaceKey)}`
}

// params: { family?, mode?, limit?, offset? } → { rows, total, byFamily? }
export function fetchBills(workspaceKey, params = {}) {
  return api.get(`${base(workspaceKey)}/bills`, { params })
}

// params: { query?, limit?, offset? } → { rows, total }
export function fetchGroupCodes(workspaceKey, params = {}) {
  return api.get(`${base(workspaceKey)}/group-codes`, { params })
}

export function fetchUsedGroupCodes(workspaceKey, params = {}) {
  return api.get(`${base(workspaceKey)}/group-codes/used`, { params })
}

// 批次团号表(审核批次随台账带上来的团号表,tour_match 的真正匹配来源)。
// params: { batchId, tourNo? } → { rows, total }
export function fetchBatchGroupCodes(workspaceKey, params = {}) {
  return api.get(`${base(workspaceKey)}/batch-group-codes`, { params })
}

// 批次团号表覆盖的模式枚举(待补救台展示"这份团号表有几种模式")。
// params: { batchId } → { modes }
export function fetchBatchGroupCodeModes(workspaceKey, params = {}) {
  return api.get(`${base(workspaceKey)}/batch-group-codes/modes`, { params })
}

// 换团号表 / 用当前表后,重新匹配某批次的未命中行(reset 待补救→pending + 重跑 tour_match)。
// → { resetCount, batchId, matched, tourNotFound, ... }
export function rematchBatchTourMatch(workspaceKey, batchId) {
  return api.post(`${base(workspaceKey)}/stages/tour-rematch`, { batchId }, { timeout: 120000 })
}
