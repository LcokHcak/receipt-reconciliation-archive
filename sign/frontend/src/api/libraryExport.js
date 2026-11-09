import api from './client'

// 资料库:按团号匹配模式(mode_raw)分类 + 导出客户数据 + 需重拍回收。
// 已结算客户源 daily_receipt_export(可按 workspaceKey/batchId 筛);重拍客户源审核批次。
export function fetchLibraryExportWorkspaces() {
  return api.get('/monthly/library-export/workspaces')
}

export function fetchLibraryExportBatches() {
  return api.get('/monthly/library-export/batches')
}

export function fetchLibraryModeSummary({ workspaceKey = '', batchId = '' } = {}) {
  return api.get('/monthly/library-export/summary', { params: { workspaceKey, batchId } })
}

// 客户级列表(姓名/护照/团号模式/小票数/状态);前端可再按模式筛选。不含账单信息。
export function fetchLibraryCustomers({ workspaceKey = '', batchId = '' } = {}) {
  return api.get('/monthly/library-export/customers', { params: { workspaceKey, batchId } })
}

// 导出前真实预检(0727反馈#15):台账行按交付合同核票号形态/购买日期,
// 疑似审核失误带批次+客户定位返回;只读不拦导出。
//
// ⚠️ batchIds 必须传(2026-08-01 补):后端 filterFromReq 一直支持跨批 IN 查询,
// 是**前端没接**——于是跨批多选导出和整月导出这两条路径根本不触发预检,
// 而月底交付最常走的恰恰是这两条。预检的筛选必须和「你正要导出的那一批」完全同口径,
// 否则它检的是另一批数据,给的是假安心。
export function fetchLibraryPrecheck({ workspaceKey = '', batchId = '', batchIds = [] } = {}) {
  const params = batchIds.length
    ? { workspaceKey, batchIds: batchIds.join(',') }
    : { workspaceKey, batchId }
  return api.get('/monthly/library-export/precheck', { params })
}

// batchIds(2026-07-28 跨批多选):勾选多个批次一次出一张 Excel(逗号串给后端 IN 查询)
export function downloadLibraryModeExport({ workspaceKey = '', batchId = '', batchIds = [] } = {}) {
  if (batchIds.length) {
    return api.get('/monthly/library-export/download', {
      params: { workspaceKey, batchIds: batchIds.join(',') },
      responseType: 'blob',
    })
  }
  return api.get('/monthly/library-export/download', {
    params: { workspaceKey, batchId },
    responseType: 'blob',
  })
}

// 客户文件夹 zip 导出(当前批次):每客户一文件夹装图片。后端有并发闸(默认2)。
export function downloadBatchCustomerFolders(batchId) {
  return api.post(`/batches/${encodeURIComponent(batchId)}/export-customer-data`, null, {
    responseType: 'blob',
  })
}

// 现代交付包(当前批次):按类型三池(护照/机票/小票),小票按票号命名。共用导出并发闸。
export function downloadHyundaiDelivery(batchId) {
  return api.post(`/batches/${encodeURIComponent(batchId)}/export-hyundai-delivery`, null, {
    responseType: 'blob',
  })
}

// 乐天百货交付包(P4;2026-07-20 重构):门店店名分夹(明洞/蚕室/釜山/仁川,一店两码并一夹)→
// 客户夹(购买日期 空格 英文名)→双图(交易编号图=小票整图 + 护照.jpg=独立护照图,
// 无独立护照用同框整图兜底不阻断)。缺交易编号/门店 409 阻断。
export function downloadLotteDeptDelivery(batchId) {
  return api.post(`/batches/${encodeURIComponent(batchId)}/export-lotte-dept-delivery`, null, {
    responseType: 'blob',
  })
}

// 多模式交付包(当前批次,2026-07-07 四规则):济州道辉按团号建客户夹/现代三池/
// 其他模式各一文件夹(客户夹=姓名+护照前4)/S活动小票另按票号复制一份。共用导出并发闸。
// zone(2026-07-16 单渠道切片)/zones(2026-07-28 多选导出,F4 参考图):只打包选中渠道区;不传=整包。
export function downloadModeDelivery(batchId, { zone = '', zones = [] } = {}) {
  const body = zones.length ? { zones } : (zone ? { zone } : null)
  return api.post(`/batches/${encodeURIComponent(batchId)}/export-mode-delivery`, body, {
    responseType: 'blob',
  })
}

// ── 交付工作台(2026-07-16 P0)────────────────────────────────────────
// 首屏聚合:workspaces+batches(带已结算徽章)+summary+customers 一次拿全(重拍单遍扫描)。
// lite=1:只拿 workspaces+批次徽章(首屏引导用,跳过重拍全扫——复核H2)。
export function fetchLibraryOverview({ workspaceKey = '', batchId = '', lite = '' } = {}) {
  return api.get('/monthly/library-export/overview', { params: { workspaceKey, batchId, lite } })
}

// 交付计划列表(与配置台注册表 1:1 同源)+ 该批次内计数/渠道子卡。
export function fetchDeliveryPlans(batchId) {
  return api.get('/library/delivery-plans', { params: { batchId } })
}

// 按需 dry-run 预检:一个计划 × 一个批次 → 阻断/跳过明细(带审核台定位信息)。
export function fetchDeliveryReadiness({ batchId, planName }) {
  return api.post('/library/delivery-readiness', { batchId, planName })
}
