// F3: Sprint F — v2 stage API 包装。
//
// 端点契约与 v1 `api/monthly.js` 完全一致（同一组后端 stage routes），
// 但 v2 独立持有自己的薄包装，避免 F10 删 v1 时 v2 跟着断。
// 所有 stage 端点都是 blocking 同步 POST，最长 10 分钟。
//
// 错误形态（按 routes/monthly/route_utils.handleStageError 统一）：
//   400 MERGE_BLOCKED                ← 扣点表 / 模式归类未确认 etc.
//   409 STAGE_ALREADY_RUNNING        ← 上一次还没结束
//   423 WORKSPACE_LOCKED             ← 月份已锁
//   423 PIPELINE_LOCKED              ← 流水线被其他 stage 占
//   503 service_unavailable          ← F2 硬化后:依赖未注入
import api from '../client'

function base(workspaceKey) {
  return `/monthly/workspaces/${encodeURIComponent(workspaceKey)}`
}

const STAGE_TIMEOUT_MS = 10 * 60 * 1000

export function runTourMatch(workspaceKey, { scope = 'all' } = {}) {
  return api.post(`${base(workspaceKey)}/stages/tour-match`, { scope }, { timeout: STAGE_TIMEOUT_MS })
}

export function runBillMatch(workspaceKey) {
  return api.post(`${base(workspaceKey)}/stages/bill-match`, {}, { timeout: STAGE_TIMEOUT_MS })
}

export function runMerge(workspaceKey) {
  return api.post(`${base(workspaceKey)}/stages/merge`, {}, { timeout: STAGE_TIMEOUT_MS })
}

export function runSecondPass(workspaceKey, { dateWindowDays = 2 } = {}) {
  return api.post(
    `${base(workspaceKey)}/stages/second-pass`,
    { dateWindowDays },
    { timeout: STAGE_TIMEOUT_MS },
  )
}

export function runMonthlyExport(workspaceKey) {
  return api.post(`${base(workspaceKey)}/exports/monthly-data`, {}, { timeout: STAGE_TIMEOUT_MS })
}

// 按需重算:若派生数据已过期(改了账单/团号/模式/扣点等),从最浅脏阶段重跑到 merge;
// 新鲜则 no-op。返回 { ran: [...stages] }。进最终核对页 / 出包前调用,保证导出跟最新结果走。
export function ensureFresh(workspaceKey) {
  return api.post(`${base(workspaceKey)}/stages/ensure-fresh`, {}, { timeout: STAGE_TIMEOUT_MS })
}
