// 批次下拉整理:按「创建日」分组(今天/昨天/MM-DD),组内按创建时间倒序。
// 背景:admin 能看所有人批次,每天新增几十个;批次名前缀是"工作区日期"
// (昨天的工作区今天导入,名字仍是 260701)→ 纯按名字看像乱序。以创建时间为准分组,
// 选项带 收票员+时刻 消歧义(同名的"客户导入"批次靠这个区分)。

function dayKey(date) {
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function groupBatchesByDay(batches = [], now = new Date()) {
  const sorted = [...(batches || [])].sort(
    (a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')),
  )
  const todayKey = dayKey(now)
  const yesterdayKey = dayKey(new Date(now.getTime() - 86400000))
  const groups = []
  const byKey = new Map()
  for (const batch of sorted) {
    const created = batch?.createdAt ? new Date(batch.createdAt) : null
    const key = created && !Number.isNaN(created.getTime()) ? dayKey(created) : '未知日期'
    if (!byKey.has(key)) {
      const suffix = key === todayKey ? '（今天）' : (key === yesterdayKey ? '（昨天）' : '')
      const group = { key, label: `${key}${suffix}`, items: [] }
      byKey.set(key, group)
      groups.push(group)
    }
    byKey.get(key).items.push(batch)
  }
  return groups
}

// 选项显示文案:名字 · 收票员 · HH:mm。owner/时间缺失就省略对应段。
export function batchOptionLabel(batch = {}) {
  const name = batch.name || batch.id || batch.batchId || ''
  const owner = String(batch.ownerUsername || batch.createdBy || '').trim()
  let time = ''
  if (batch.createdAt) {
    const d = new Date(batch.createdAt)
    if (!Number.isNaN(d.getTime())) {
      time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    }
  }
  return [name, owner, time].filter(Boolean).join(' · ')
}
