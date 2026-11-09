// F8: Sprint F — v2 pending-reviews API 包装(覆盖全部 reasonType,
// 不仅是 field_conflict)。走 F1 axios client。
import api from '../client'

function base(workspaceKey) {
  return `/monthly/workspaces/${encodeURIComponent(workspaceKey)}`
}

// params: { status?, limit?, offset? } → { rows, total, byReason }
export function fetchPendingReviews(workspaceKey, params = {}) {
  return api.get(`${base(workspaceKey)}/pending-reviews`, { params })
}

// 通用解决: 不带 decision 走后端 Sprint 1 fallback (仅状态更新 + resolution 备注)。
// 带 decision 的智能写回入口在 api/v2/conflicts.js#resolveConflict (F1)。
// payload: { status: 'resolved'|'rejected', resolution?: string }
export function resolvePendingReview(workspaceKey, id, payload = {}) {
  return api.post(
    `${base(workspaceKey)}/pending-reviews/${encodeURIComponent(id)}/resolve`,
    {
      status: payload.status || 'resolved',
      resolution: payload.resolution || null,
    },
  )
}

// 批量否决(fuzzy/ambiguous 历史噪声清理):rejected 只翻状态,不动业务数据。
// payload: { ids: number[], resolution?: string } → { ok, rejected, skipped }
export function batchRejectPendingReviews(workspaceKey, payload) {
  return api.post(`${base(workspaceKey)}/pending-reviews/batch-reject`, payload)
}
