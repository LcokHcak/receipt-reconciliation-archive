// F1 Sprint F — v2 conflicts (field_conflict 专用解决) API。
// F8: fetchPendingReviews 已抽到 ./pendingReviews.js 共用,
// 这里 re-export 以保持 ConflictsView 的导入不变。
import api from '../client'

export { fetchPendingReviews } from './pendingReviews'

// 字段冲突的智能写回:必须携带 decision 才会走 pendingReviewResolutionService;
// 若 service 未注入,F2 后端会返回 503 resolution_service_unavailable。
export function resolveConflict({
  workspaceKey,
  id,
  decision,
  status = 'resolved',
  resolution = null,
}) {
  return api.post(
    `/monthly/workspaces/${encodeURIComponent(workspaceKey)}/pending-reviews/${encodeURIComponent(id)}/resolve`,
    { decision, status, resolution },
  )
}
