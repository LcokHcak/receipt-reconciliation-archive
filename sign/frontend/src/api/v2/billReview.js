import api from '../client'

function base(workspaceKey) {
  return `/monthly/workspaces/${encodeURIComponent(workspaceKey)}`
}

export function fetchBillReviewConflicts(workspaceKey, params = {}) {
  return api.get(`${base(workspaceKey)}/bill-match/conflicts`, { params })
}

export function fetchDailyWithoutBill(workspaceKey, params = {}) {
  return api.get(`${base(workspaceKey)}/bill-match/daily-without-bill`, { params })
}

// 改造B: 客户维度数量对账。params: { folder?, all? } → { rows, total }
// 默认只返回数量不一致的客户;all=1 时返回全部客户 diff。
export function fetchCountMismatch(workspaceKey, params = {}) {
  return api.get(`${base(workspaceKey)}/bill-match/count-mismatch`, { params })
}

// 未收清单 (账单有台账无,客户该补交),与导出文件同口径 → { rows, total }
export function fetchUnreceivedList(workspaceKey, params = {}) {
  return api.get(`${base(workspaceKey)}/bill-match/unreceived`, { params })
}

// 未收清单处理(link/延期/作废)→ 落库后该项从清单移除。
// payload: { items: [{ passportNo, name, receiptNo }], action, reason?, linkedRef? }
export function resolveUnreceived(workspaceKey, payload) {
  return api.post(`${base(workspaceKey)}/bill-match/unreceived/resolve`, payload)
}

// 未收补录(B2):从账单复制真实数据反向建台账行 + 自动重跑 bill_match。
// 含跑全量账单匹配,放宽超时。payload: { items: [{ passportNo, name, receiptNo }] }
export function backfillUnreceived(workspaceKey, payload) {
  return api.post(`${base(workspaceKey)}/bill-match/unreceived/backfill`, payload, {
    timeout: 10 * 60 * 1000,
  })
}

export function resolveBillReviewConflict(workspaceKey, payload) {
  return api.post(`${base(workspaceKey)}/bill-match/resolve-conflict`, payload)
}

export function rerunBillMatchRow(workspaceKey, dailyId) {
  return api.post(`${base(workspaceKey)}/bill-match/rerun-row`, { dailyId }, {
    timeout: 10 * 60 * 1000,
  })
}
