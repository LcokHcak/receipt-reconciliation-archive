// 品牌活动(活动数据)第5个桶 API 包装。
// 导入走普通账单导入(后端自动识别 返点模式=品牌活动 分流),这里只做 列表/汇总/清空。
import api from '../client'

function base(workspaceKey) {
  return `/monthly/workspaces/${encodeURIComponent(workspaceKey)}`
}

// params: { limit?, offset? } → { rows, total, summary:{rows,rebateTotal,negativeRows} }
export function fetchBrandActivity(workspaceKey, params = {}) {
  return api.get(`${base(workspaceKey)}/brand-activity`, { params })
}

// 清空品牌活动桶(替换前清旧;清空后需重跑 merge)。
export function clearBrandActivity(workspaceKey) {
  return api.delete(`${base(workspaceKey)}/brand-activity`)
}
