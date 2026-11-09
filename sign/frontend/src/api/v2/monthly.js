// F1: Sprint F — 统一走 axios client，享受 401 重定向 / 草稿快照 /
// requestId 头记录 / 集中 5xx 日志。
import api from '../client'

export function fetchMonthlyOverview(workspaceKey) {
  return api.get(`/monthly/workspaces/${encodeURIComponent(workspaceKey)}/overview`)
}
