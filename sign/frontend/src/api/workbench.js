import api from './client'

export function fetchWorkbenchState() {
  return api.get('/state')
}

export function fetchBatch(batchId) {
  return api.get(`/batches/${encodeURIComponent(batchId)}`)
}

export function updateTask(batchId, taskId, payload) {
  return api.patch(`/batches/${encodeURIComponent(batchId)}/tasks/${encodeURIComponent(taskId)}`, payload)
}

export function approveSourceGroup(batchId, groupKey) {
  return api.post(`/batches/${encodeURIComponent(batchId)}/source-groups/${encodeURIComponent(groupKey)}/approve`)
}

export function importBatchLedger(batchId) {
  return api.post(`/batches/${encodeURIComponent(batchId)}/import-ledger`)
}

// 流式逐客户:通过并结算(写台账 + 即时团号匹配)→ 返回按小票的渠道模式 + 结算状态。
export function settleSourceGroup(batchId, groupKey) {
  return api.post(`/batches/${encodeURIComponent(batchId)}/source-groups/${encodeURIComponent(groupKey)}/settle`)
}

// 台账侧订正(admin):撤销已结算组台账(删行+快照留痕),组回可编辑态。原因必填。
export function correctGroupLedger(batchId, groupKey, reason) {
  return api.post(`/batches/${encodeURIComponent(batchId)}/source-groups/${encodeURIComponent(groupKey)}/ledger-correction`, { reason })
}

// 流式逐客户:确认已命中小票的渠道模式(人工背书)。
export function confirmGroupModes(batchId, groupKey) {
  return api.post(`/batches/${encodeURIComponent(batchId)}/source-groups/${encodeURIComponent(groupKey)}/confirm-modes`)
}

// 确认站/回发前端已下线(2026-07-14 用户拍板):tour-candidates/confirm-tour/unconfirm-tour/
// tour-responded/tour-prior/sendback-queue 的前端包装随 TourConfirmPanel/SendbackPanel 一并删除;
// 后端端点保留(tourConfirmedAt 盖章数据仍被 SLIM 车道消费),后端摘除另行立项。

// 替换本批次团号表(审核台入口):multipart 上传 xlsx,后端 replace batch_group_code(不重导客户图)
export function replaceBatchGroupCode(batchId, file) {
  const form = new FormData()
  form.append('groupCodeFile', file)
  return api.post(`/customer-library/batches/${encodeURIComponent(batchId)}/group-code`, form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 60000,
  })
}

export function deleteTask(batchId, taskId) {
  return api.delete(`/batches/${encodeURIComponent(batchId)}/tasks/${encodeURIComponent(taskId)}`)
}

// 删除整个客户组(重复建档兜底):连客户文件夹+组内所有任务一起清,并解掉本组占用。
// 后端 forceRemove+deleteCustomerDirectory;已入台账的另一份客户不受影响(独立记录)。
export function deleteSourceGroupCustomer(batchId, groupKey) {
  return api.delete(`/batches/${encodeURIComponent(batchId)}/source-groups/${encodeURIComponent(groupKey)}/customer`)
}

// 「同图补一条小票」(2026-07-06 漏切人工兜底):一张图里两张票只建了一条记录时,
// 基于当前任务同一张图追加一条空白小票记录,操作员照图手填字段(30秒级)。
// 手画文档框(0730 第2期):在原图上框出这条任务对应的那张单据,交付时按它裁。
// box = [x1,y1,x2,y2] 原图归一化坐标。
// P2-b:按已保存的人工框重读票面字段。只更新 *Auto(建议值),不碰 *Final(人的决定)。
export function rereadTaskBox(batchId, taskId) {
  return api.post(`/batches/${encodeURIComponent(batchId)}/tasks/${encodeURIComponent(taskId)}/reread-box`)
}

export function setTaskDocBox(batchId, taskId, box) {
  return api.post(`/batches/${encodeURIComponent(batchId)}/tasks/${encodeURIComponent(taskId)}/doc-box`, { box })
}

export function createManualReceiptFromTask(batchId, taskId, recordLabel = '') {
  return api.post(`/batches/${encodeURIComponent(batchId)}/tasks/${encodeURIComponent(taskId)}/manual-receipt`, {
    recordLabel,
  })
}

// P2d 改店重切:按(新)店档案用客户库原图强制重切,旧任务删除,新切片归回同批次。
// storeFamily 空 = 不改店纯重切(多票漏切重试);已审保护由后端 409。
export function resplitTask(batchId, taskId, storeFamily = '') {
  return api.post(`/batches/${encodeURIComponent(batchId)}/tasks/${encodeURIComponent(taskId)}/resplit`, {
    storeFamily,
  })
}

export function deleteBatch(batchId) {
  return api.delete(`/batches/${encodeURIComponent(batchId)}`)
}

export function queueTaskWebsiteSignature(batchId, taskId) {
  return api.post(`/batches/${encodeURIComponent(batchId)}/tasks/${encodeURIComponent(taskId)}/queue-website-signature`)
}

export function queueBatchWebsiteSignatures(batchId) {
  return api.post(`/batches/${encodeURIComponent(batchId)}/queue-website-signatures`)
}

export function deleteWebsiteSignature(batchId, taskId) {
  return api.delete(`/batches/${encodeURIComponent(batchId)}/tasks/${encodeURIComponent(taskId)}/website-signature`)
}

export function deleteManualSignature(batchId, taskId) {
  return api.delete(`/batches/${encodeURIComponent(batchId)}/tasks/${encodeURIComponent(taskId)}/manual-signature`)
}

export function exportBatch(batchId, { excludeNoRecord = false } = {}) {
  // excludeNoRecord:隐藏「不用记」模式整行(默认关=保留+标注,2026-07-21 拍板)
  return api.post(`/batches/${encodeURIComponent(batchId)}/export`, { excludeNoRecord })
}

// 工作台首页聚合(今日待办/今日进度/本月进度)。
export function fetchWorkbenchOverview(workspaceKey = '') {
  const params = workspaceKey ? { workspaceKey } : {}
  return api.get('/workbench/overview', { params })
}

// 导出当前批次客户数据(每客户一个文件夹 + 图片,不含账单 xlsx),返回 zip Blob。
export function exportBatchCustomerData(batchId) {
  return api.post(`/batches/${encodeURIComponent(batchId)}/export-customer-data`, {}, {
    responseType: 'blob',
    timeout: 30 * 60 * 1000,
  })
}
