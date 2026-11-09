// 工作台首页(管理员/审核员分离,2026-07-18)的展示口径纯函数。
// 不碰 store/网络,node 可直接 import —— UI 契约测试锁这里的口径,
// 页面组件只做渲染,数字算错在这层就能被单测逮住。

// 人工待审(审核员要动手的):图片确认+字段+签字+终审。
export function batchPendingCount(batch) {
  const c = batch?.counts || {}
  return num(c.classification) + num(c.fields) + num(c.signature) + num(c.finalReview)
}

// 全部积压 = 人工待审 + 机器没跑完(queued/processing) + 故障未清(error/rephoto)。
// error/rephoto 不算进去的话,一批里 30 张 OCR 失败其余全过会被误标"已完成",
// 与异常提醒胶囊自相矛盾(2026-07-18 评审 M1)。
export function batchBacklogCount(batch) {
  const c = batch?.counts || {}
  return batchPendingCount(batch) + num(c.queued) + num(c.processing)
    + num(c.error) + num(c.rephoto)
}

export function batchTotalCount(batch) {
  return num(batch?.fileCount || batch?.taskCount || batch?.counts?.total)
}

export function batchApprovedCount(batch) {
  return num(batch?.approvedCount || batch?.counts?.approved)
}

// 异常遗留 = OCR失败 + 待重拍。它们不挡"这批干完了",但必须在表里如实标出来。
export function batchAbnormalCount(batch) {
  const c = batch?.counts || {}
  return num(c.error) + num(c.rephoto)
}

// 待收尾 = 人工待审 + 机器在途。**不含异常**(异常有独立列,两边都算会让人以为有两拨活)。
// 与 batchBacklogCount 的差就是 batchAbnormalCount,三者恒满足:待收尾 + 异常 = 全部积压。
export function batchOpenWorkCount(batch) {
  const c = batch?.counts || {}
  return batchPendingCount(batch) + num(c.queued) + num(c.processing)
}

// 完成(2026-07-27 用户拍板A改口径)= 有内容 + 人工审完(待审=0) + 机器不在途(queued/processing=0)。
// ⭐为什么把 error/rephoto 从阻塞条件里拿掉:旧口径要求"零积压"且积压含异常,而生产一批几百张
// 几乎必然剩一两张 OCR 失败或待重拍 —— 于是「已完成批次」表**永远是空的**,功能等于不存在
// (用户实际反馈:"这个没有看到")。异常遗留另有「异常补救」入口专门处理,不该卡住产能记录。
// 诚实性由 batchAbnormalCount 兜住:表里有独立的「异常」列,有几张遗留一眼可见,不藏。
// 注:batchBacklogCount(含异常)保持原样不动——它是"还有活"徽标与 stale 判定的口径,语义不同。
export function isBatchCompleted(batch) {
  const c = batch?.counts || {}
  return batchTotalCount(batch) > 0
    && batchPendingCount(batch) === 0
    && num(c.queued) === 0
    && num(c.processing) === 0
}

// 完成时间 = 最后一次审核动作。**没有审核动作就没有完成时间**,返回空 → 显示「—」。
//
// ⚠️ 2026-08-01 修:原来退回 updatedAt/createdAt。那是"写盘时间"或"建批时间",
// 不是任何人完成任何事的时刻。可达形状实测过:整批任务全被标重拍时 reviewedAt 会被清空
// (services/workbench_write/task.js:377/389),于是这批既满足"完成"判据、又零审核 ——
// 看板给出的完成时间 2026-07-11 09:00、耗时 10天0小时,是**从没测量过**的数。
// 宁可显「—」也不拿写盘时间冒充测量值:看板上的数被人拿去算人效和排班。
export function batchCompletedAt(batch) {
  return batch?.reviewStats?.lastReviewedAt || ''
}

// 耗时 = 建批 → 最后审核。任一端缺失/倒挂给 null(显示 —,不显示负数)。
// 完成时间为空(零审核动作)时这里自然也是 null —— 两列一起显「—」,口径一致。
export function batchDurationMs(batch) {
  const start = new Date(batch?.createdAt || '').getTime()
  const end = new Date(batchCompletedAt(batch)).getTime()
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null
  return end - start
}

export function fmtDuration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—'
  const totalMinutes = Math.round(ms / 60000)
  const d = Math.floor(totalMinutes / 1440)
  const h = Math.floor((totalMinutes % 1440) / 60)
  const m = totalMinutes % 60
  // 超过一天给"天"级单位(耗时含排队等待,批次躺几天很常见,"78小时"没人看得懂)
  if (d > 0) return `${d}天${h}小时`
  if (h > 0) return `${h}小时${String(m).padStart(2, '0')}分`
  return `${m}分`
}

export function fmtDateTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// 导出留痕(P1):exportKind → 中文徽标。未盖章显示"未导出"。
export const EXPORT_KIND_LABELS = {
  workbook: '结果表',
  customer_data: '客户资料',
  hyundai: '现代交付',
  lotte_dept: '乐天百货',
  mode: '交付包',
}

export function exportKindLabel(kind) {
  const key = String(kind || '').trim()
  if (!key) return ''
  return EXPORT_KIND_LABELS[key] || key
}

export function isBatchExported(batch) {
  return Boolean(String(batch?.exportedAt || '').trim())
}

// KPI/看板完成率统一整数百分比(提示词样式:79%)。
// 99% 护栏:没真做完(rate<1)不许四舍五入显示 100%——"看着100%其实还剩1张"
// 是完成率场景最误导的观感(项目先例:customer store 的 Math.min(99,...))。
export function fmtPct(rate) {
  const n = Number(rate)
  if (!Number.isFinite(n)) return '0%'
  const rounded = Math.round(Math.min(1, Math.max(0, n)) * 100)
  if (rounded >= 100 && n < 1) return '99%'
  return `${rounded}%`
}

// 工作区列截断:长期在岗的收票员跨很多月份,全量 join 会撑坏表格——
// 只显示最近 2 个,其余收进"等N月"(悬浮 title 给全量)。
export function formatWorkspaces(workspaces) {
  const list = Array.isArray(workspaces) ? workspaces.filter(Boolean) : []
  if (!list.length) return { text: '—', title: '' }
  const full = list.join(' / ')
  if (list.length <= 2) return { text: full, title: '' }
  return { text: `${list.slice(0, 2).join(' / ')} 等${list.length}月`, title: full }
}

// 收票员看板排序(拍板口径:员工编号=用户名自然序为默认)。
export const COLLECTOR_SORTS = [
  { key: 'owner', label: '员工编号' },
  { key: 'workspace', label: '工作区' },
  { key: 'completionRate', label: '完成率' },
  { key: 'pending', label: '待审数量' },
]

// 员工编号排序:异常桶(未分配/#userId)显式置顶——这类行代表归属有问题,必须显眼,
// 不能依赖 localeCompare 的 Unicode collation 摆位(换 Node/ICU 版本会静默漂移)。
function ownerCompare(a, b) {
  const rankOf = (owner) => {
    const key = String(owner || '')
    if (key === '未分配') return 0
    if (key.startsWith('#')) return 1
    return 2
  }
  return rankOf(a.owner) - rankOf(b.owner)
    || String(a.owner).localeCompare(String(b.owner), 'zh-Hans-CN', { numeric: true })
}

export function sortCollectors(collectors, sortKey) {
  const list = [...(collectors || [])]
  switch (sortKey) {
    case 'workspace':
      // 月份工作区降序(新月在前),同月按员工编号
      return list.sort((a, b) => String(b.workspaces?.[0] || '').localeCompare(String(a.workspaces?.[0] || ''))
        || ownerCompare(a, b))
    case 'completionRate':
      return list.sort((a, b) => (b.completionRate || 0) - (a.completionRate || 0) || ownerCompare(a, b))
    case 'pending':
      return list.sort((a, b) => (b.pending || 0) - (a.pending || 0) || ownerCompare(a, b))
    case 'owner':
    default:
      // 员工编号:数字感知(小票2 < 小票10),异常桶置顶
      return list.sort(ownerCompare)
  }
}

export function filterCollectors(collectors, keyword) {
  const kw = String(keyword || '').trim().toLowerCase()
  if (!kw) return collectors || []
  return (collectors || []).filter((c) => String(c.owner || '').toLowerCase().includes(kw))
}

// 批次的 owner 归键:与后端 buildCollectorBreakdown 同口径(用户名 → #userId → 未分配)。
// 看板行的 owner 就是这个键;展开行必须用同一套归键,否则「未分配/#id」桶展开永远为空。
export function ownerKeyOfBatch(batch) {
  const username = String(batch?.ownerUsername || batch?.createdBy || '').trim()
  if (username) return username
  const userId = batch?.ownerUserId ?? batch?.createdByUserId ?? null
  return (userId !== null && userId !== undefined && userId !== '') ? `#${userId}` : '未分配'
}

// 某收票员的未完批次(看板展开行):按批次号升序,只列还有活的。
// 某收票员的**全部**批次(2026-07-29 需求A1 修正):展开行原先只列未完成批次,
// 于是「完成时间/耗时/导出状态」三列没处落——用户看到的仍是三列极简表,需求等于没做。
// 改为全部批次:未完成在前(还有活的优先,积压多的在上),已完成在后(完成时间倒序)。
export function ownerBatches(batches, ownerKey) {
  const key = String(ownerKey || '').trim()
  return (batches || [])
    .filter((b) => ownerKeyOfBatch(b) === key)
    .sort((a, b) => {
      const openA = batchBacklogCount(a) > 0 ? 0 : 1;
      const openB = batchBacklogCount(b) > 0 ? 0 : 1;
      if (openA !== openB) return openA - openB;
      if (openA === 0) return batchBacklogCount(b) - batchBacklogCount(a);
      return String(batchCompletedAt(b)).localeCompare(String(batchCompletedAt(a)));
    })
}

// 已完成批次列表:完成时间倒序。
export function completedBatches(batches) {
  return (batches || [])
    .filter(isBatchCompleted)
    .sort((a, b) => String(batchCompletedAt(b)).localeCompare(String(batchCompletedAt(a))))
}

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}
