// G1: Sprint G — v2 数据导入 API 包装。
// 5 种 import + 1 个 validate (来自 routes/monthly/import_routes.js).
// 走 F1 axios client + multipart 文件上传。
import api from '../client'

function base(workspaceKey) {
  return `/monthly/workspaces/${encodeURIComponent(workspaceKey)}`
}

const IMPORT_TIMEOUT_MS = 5 * 60 * 1000   // 5 分钟 — 后端 handleImport 长任务
const UPLOAD_TIMEOUT_MS = 30 * 60 * 1000  // 真实月度 Excel 上传在弱网下可能超过 10 分钟

// G12a/G13: 月度主流程只需要店家账单；团号表由日度审核批次上传并随导入台账入月。
// 其他 3 种 (missing / received-receipt / daily-receipt) 是"算出/审核台桥接"产生的,
// 不是"导入"动作:
//   - 未收清单    = bill_match + second_pass 算出的 daily 行差集 (UnreceivedView 在线看)
//   - 已收回执    = daily_receipt_export 表 → /exports/received-receipt xlsx (DeliveryView 导出)
//   - 日度收票汇总 = 审核台批准 group → bridge 自动写,无需导入;LedgerView 在线看
// 后端 import 端点仍保留(灾难恢复 / 历史数据迁移),只是 UI 不暴露。
export const IMPORT_KINDS = Object.freeze([
  { slug: 'group-code', label: '团号表(兼容)', description: '历史/补录入口；正常流程在日度审核批次上传团号表' },
  { slug: 'store-bill', label: '店家账单', description: '免税店发的账单 xlsx (月末统一导,支持 4 类多文件)' },
])

// 上传前校验 — 返回 { ok, warnings, errors, sample, ... }
// importType 是后端 jobType 名 (group_code / store_bill / missing / received_receipt / daily_receipt)
export function validateImport(workspaceKey, file, importType) {
  const form = new FormData()
  form.append('file', file)
  form.append('importType', importType)
  return api.post(`${base(workspaceKey)}/imports/validate`, form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: IMPORT_TIMEOUT_MS,
  })
}

// 上传执行 — slug 必须是 IMPORT_KINDS 里的。
// 异步:后端建好 job 立刻返回 {job:{id,status:'running'}}(不占连接跑完整导入,避免大文件 408)。
// 本函数随后轮询 import-jobs/:id 直到 done/failed,返回最终 job。调用方 await 拿到的还是最终结果,无需改动。
export async function uploadImport(workspaceKey, slug, file, { onUploadProgress = null, bucketFolder = null, onProcessing = null } = {}) {
  const form = new FormData()
  form.append('file', file)
  if (bucketFolder) form.append('bucketFolder', bucketFolder)
  const res = await api.post(`${base(workspaceKey)}/imports/${slug}`, form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: UPLOAD_TIMEOUT_MS, // 只等"上传+建job",不等整段导入
    onUploadProgress,
  })
  const job0 = res?.job || res || {}
  const jobId = job0.id
  // 旧路径(同步返回已 done)或拿不到 id → 直接返回
  if (!jobId || (job0.status && job0.status !== 'running')) return res

  // 轮询直到完成(后台异步入库)。最长 ~30 分钟,1.5s 一次。
  const started = Date.now()
  const MAX_MS = 30 * 60 * 1000
  // 简易延时
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  while (Date.now() - started < MAX_MS) {
    await sleep(1500)
    let cur
    try {
      cur = await fetchImportJob(workspaceKey, jobId)
    } catch {
      continue // 轮询偶发失败不致命,继续
    }
    const job = cur?.job || cur || {}
    if (typeof onProcessing === 'function') onProcessing(job)
    if (job.status === 'done') return { job }
    if (job.status === 'failed') {
      const err = new Error(job.errorMessage || '导入失败')
      err.response = { data: { error: job.errorMessage || '导入失败' } }
      throw err
    }
  }
  throw new Error('导入超时(后台仍在处理,可稍后在导入历史查看)')
}

// import_job 历史 — params: { kind?, status?, limit?, offset? }
export function fetchImportJobs(workspaceKey, params = {}) {
  return api.get(`${base(workspaceKey)}/import-jobs`, { params })
}

export function fetchImportJob(workspaceKey, id) {
  return api.get(`${base(workspaceKey)}/import-jobs/${encodeURIComponent(id)}`)
}

// slug → 后端 jobType 名 (validate 需要的格式)
export function slugToJobType(slug) {
  if (!slug) return null
  return String(slug).replace(/-/g, '_')
}
