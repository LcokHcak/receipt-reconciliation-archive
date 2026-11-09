// G1: Sprint G — v2 月初设置 API 包装 (开月 + 扣点表 + 模式归类 + 月度管理)。
// 走 F1 axios client (401 redirect / requestId / draft snapshot)。
//
// 后端端点 (来自 routes/monthly/workspace_routes.js + config_routes.js):
//   POST /workspaces                        创建 workspace
//   POST /workspaces/:ws/clear              清月 (admin)
//   POST /workspaces/:ws/seed               灌种子 (仅 demo-)
//   POST /workspaces/:ws/health-check       健康检查
//   GET  /workspaces/:ws/health-check.csv   健康检查 csv 直链
//   GET  /workspaces/:ws/deduct-config      读扣点表
//   PUT  /workspaces/:ws/deduct-config      写扣点表 + confirm
//   POST /workspaces/:ws/deduct-config/copy-from-previous
//   GET  /workspaces/:ws/mode-mapping       读模式归类
//   PUT  /workspaces/:ws/mode-mapping       写模式归类 + confirm
//   POST /workspaces/:ws/mode-mapping/copy-from-previous
import api from '../client'

function base(workspaceKey) {
  return `/monthly/workspaces/${encodeURIComponent(workspaceKey)}`
}

// ── 开月 / 清 / 种子 / 健康 ───────────────────────────────────────────────
export function createWorkspace(workspaceKey) {
  return api.post('/monthly/workspaces', { workspaceKey })
}

// clear 要求 confirmWorkspaceKey 二次确认避免误删
export function clearWorkspace(workspaceKey, confirmWorkspaceKey) {
  return api.post(
    `${base(workspaceKey)}/clear`,
    { confirmWorkspaceKey },
    { timeout: 10 * 60 * 1000 },
  )
}

// scenario 必须 == services/monthly/seed_service.js#ALLOWED_SCENARIOS (snake_case)
export const SEED_SCENARIOS = Object.freeze([
  { value: 'all_matched',          label: '全匹配 (基线)' },
  { value: 'field_conflict',       label: '字段冲突' },
  { value: 'unmatched_unreceived', label: '未到货 / 未收' },
  { value: 'cross_month',          label: '跨月拆分' },
  { value: 'large_volume',         label: '10000 行压测' },
])
export function seedWorkspace(workspaceKey, scenario = 'all_matched') {
  return api.post(`${base(workspaceKey)}/seed`, { scenario })
}

export function runHealthCheck(workspaceKey) {
  return api.post(`${base(workspaceKey)}/health-check`)
}

// G8-fix(C1+B4): 团号命中率 — 账单 × 团号表 重叠率
// → { billsTotal, billsDistinctTours, groupsDistinctTours, overlap, coverageRate }
export function fetchTourCoverage(workspaceKey) {
  return api.get(`${base(workspaceKey)}/coverage`)
}

export function healthCheckCsvUrl(workspaceKey) {
  return `/api${base(workspaceKey)}/health-check.csv`
}

// ── 扣点表配置 ─────────────────────────────────────────────────────────────
// → { workspaceKey, isTestMode, confirmedAt, rows: [{ modeFolder, deductValue, ... }] }
export function fetchDeductConfig(workspaceKey) {
  return api.get(`${base(workspaceKey)}/deduct-config`)
}

// payload: { rows: [{ modeFolder, deductValue }], confirm?: boolean }
export function updateDeductConfig(workspaceKey, payload) {
  return api.put(`${base(workspaceKey)}/deduct-config`, payload)
}

export function copyDeductFromPrevious(workspaceKey) {
  return api.post(`${base(workspaceKey)}/deduct-config/copy-from-previous`)
}

// ── 模式归类 ───────────────────────────────────────────────────────────────
// → { workspaceKey, isTestMode, confirmedAt, items: [{ modeRaw, modeFolder }], unmapped: [...] }
export function fetchModeMapping(workspaceKey) {
  return api.get(`${base(workspaceKey)}/mode-mapping`)
}

// payload: { mappings: [{ modeRaw, modeFolder }], confirm?: boolean }
export function updateModeMapping(workspaceKey, payload) {
  return api.put(`${base(workspaceKey)}/mode-mapping`, payload)
}

export function copyModeMappingFromPrevious(workspaceKey) {
  return api.post(`${base(workspaceKey)}/mode-mapping/copy-from-previous`)
}
