// F10: 收尾后 v1 monthly api 瘦身完毕。
// v2 月度 API 全部在 frontend/src/api/v2/*;本文件只保留:
//   - fetchMonthlyWorkspaces  (v2 MonthlyV2View 拉月份列表)
//   - createMonthlyWorkspace + uploadMonthlyImport  (v1 daily 保留页
//     CustomerLibraryView 在新建工作区/上传 daily 时用)
// 历史上有 ~30+ 个 export 已随 v1 月度 12 页一同删除,改去 api/v2/*。
import api from './client'

function base(workspaceKey) {
  return `/monthly/workspaces/${encodeURIComponent(workspaceKey)}`
}

export function fetchMonthlyWorkspaces(params = {}) {
  return api.get('/monthly/workspaces', { params })
}

export function createMonthlyWorkspace(workspaceKey) {
  return api.post('/monthly/workspaces', { workspaceKey })
}

export function uploadMonthlyImport(workspaceKey, kind, file) {
  const form = new FormData()
  form.append('file', file)
  return api.post(`${base(workspaceKey)}/imports/${kind}`, form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 5 * 60 * 1000,
  })
}
