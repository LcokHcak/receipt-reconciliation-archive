import api from './client'

// 配置台 P1(admin):模式记录规则的查看/保存/回滚/停用。
// 语义:保存即生效(后端 resolver 按变更水位失效缓存);删除=停用回落出厂,历史版本永存。

export function fetchConfigModes() {
  return api.get('/admin/config/modes')
}

export function fetchConfigModeVersions(name) {
  return api.get(`/admin/config/modes/${encodeURIComponent(name)}/versions`)
}

// body: { payload, expectBaseVersion, note } —— expectBaseVersion=编辑时看到的版本(乐观锁,409=被人抢先改了)
export function saveConfigMode(name, body) {
  return api.post(`/admin/config/modes/${encodeURIComponent(name)}`, body)
}

export function activateConfigModeVersion(name, version) {
  return api.post(`/admin/config/modes/${encodeURIComponent(name)}/activate`, { version })
}

export function deactivateConfigMode(name) {
  return api.post(`/admin/config/modes/${encodeURIComponent(name)}/deactivate`)
}

// ── P2:导出计划(文件夹交付)──内置=老planner引用;DSL=引擎;预览不落盘 ──
export function fetchExportPlans() {
  return api.get('/admin/config/export-plans')
}

export function fetchExportPlanVersions(name) {
  return api.get(`/admin/config/export-plans/${encodeURIComponent(name)}/versions`)
}

export function saveExportPlan(name, body) {
  return api.post(`/admin/config/export-plans/${encodeURIComponent(name)}`, body)
}

export function activateExportPlanVersion(name, version) {
  return api.post(`/admin/config/export-plans/${encodeURIComponent(name)}/activate`, { version })
}

export function deactivateExportPlan(name) {
  return api.post(`/admin/config/export-plans/${encodeURIComponent(name)}/deactivate`)
}

export function previewExportPlan(name, body) {
  return api.post(`/admin/config/export-plans/${encodeURIComponent(name)}/preview`, body)
}

// ── P3b-2:审核基线 / 店档案字段 / 冲突检查 / 真落盘 ──
export function fetchReviewBases() {
  return api.get('/admin/config/review-base')
}

export function impactReviewBase(docType, payload) {
  return api.post(`/admin/config/review-base/${encodeURIComponent(docType)}/impact`, { payload })
}

export function saveReviewBase(docType, body) {
  return api.post(`/admin/config/review-base/${encodeURIComponent(docType)}`, body)
}

export function deactivateReviewBase(docType) {
  return api.post(`/admin/config/review-base/${encodeURIComponent(docType)}/deactivate`)
}

export function fetchStoreProfiles() {
  return api.get('/admin/config/stores')
}

export function deactivateStoreFields(family) {
  return api.post(`/admin/config/stores/${encodeURIComponent(family)}/deactivate`)
}

export function saveStoreFields(family, body) {
  return api.post(`/admin/config/stores/${encodeURIComponent(family)}/fields`, body)
}

// 门店码点选清单(0727反馈#6):body = { branchOptions: [{code,name}], expectBaseVersion, note }
export function saveStoreBranchOptions(family, body) {
  return api.post(`/admin/config/stores/${encodeURIComponent(family)}/branch-options`, body)
}

export function fetchModeConflicts(name) {
  return api.get(`/admin/config/modes/${encodeURIComponent(name)}/conflicts`)
}

// 真落盘:返回文件流(zip/xlsx)。axios 拿 blob;422 时 error.response.data 也是 Blob,调用方解 JSON。
export function executeExportPlan(name, body) {
  return api.post(`/admin/config/export-plans/${encodeURIComponent(name)}/execute`, body, { responseType: 'blob' })
}

// ── P3c:字段管理(注册表只读)──
// 注:配置日志页 2026-07-16 重排时按用户决定删除;后端 /admin/config/changelog 端点仍在,
// 前端不再提供入口,故这里不保留 fetchChangelog 包装(避免死代码)。
export function fetchFieldRegistry() {
  return api.get('/admin/config/field-registry')
}
