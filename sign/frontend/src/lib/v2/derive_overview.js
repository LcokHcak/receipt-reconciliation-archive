function rowCount(rows, key, value) {
  if (!Array.isArray(rows)) return 0
  const found = rows.find((row) => String(row[key]) === String(value))
  return Number(found?.n ?? found?.count ?? 0)
}

function sumRows(rows) {
  if (!Array.isArray(rows)) return 0
  return rows.reduce((sum, row) => sum + Number(row?.n ?? row?.count ?? 0), 0)
}

function maxOf(...values) {
  return Math.max(0, ...values.map((value) => Number(value || 0)))
}

const STAGE_LABELS = {
  tour_match: '团号匹配',
  bill_match: '账单匹配',
  merge: '生成月度数据',
  export: '月度导出',
  second_pass: '二次召回',
  cross_check: '交叉检查',
}

const STATUS_LABELS = {
  pending: '等待中',
  running: '运行中',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
}

const ACTIVITY_VERBS = {
  pending: '等待',
  running: '运行',
  succeeded: '完成',
  failed: '失败',
  cancelled: '取消',
}

function stageLabel(stage) {
  return STAGE_LABELS[stage] || stage || '阶段'
}

function statusLabel(status) {
  return STATUS_LABELS[status] || status || ''
}

export function deriveAlerts(counts = {}) {
  const pendingRows = Array.isArray(counts.pendingByReason) ? counts.pendingByReason : []
  const errorRows = Array.isArray(counts.errorsByType) ? counts.errorsByType : []
  const pending = pendingRows.map((row, index) => ({
    id: `pending-${row.reason || index}`,
    severity: row.reason === 'field_conflict' ? 'error' : 'warn',
    label: row.reason || 'pending_review',
    count: Number(row.n || row.count || 0),
    link: '#',
    age: 100 - index,
  }))
  const errors = errorRows
    // 已解决(resolved)的错误不是活跃阻塞,不计入首页阻塞项,避免数字虚高
    .filter((row) => row.status !== 'resolved')
    // TM_* 是 tour_match 失败的镜像记录:同一失败行已计入 pendingByReason
    // (tour_not_found/date_out_of_window/...),两边都算会让阻塞数翻倍。
    // error_record 自己的页面照常展示 TM_*,只是首页聚合去重。
    .filter((row) => !String(row.error_type || '').startsWith('TM_'))
    .map((row, index) => ({
      id: `error-${row.error_type || index}`,
      severity: row.severity === 'critical' ? 'error' : 'warn',
      label: row.error_type || 'error_record',
      count: Number(row.count || row.n || 0),
      link: '#',
      age: 50 - index,
    }))
  return [...pending, ...errors]
    .filter((item) => item.count > 0)
    .sort((a, b) => {
      const rank = { error: 3, warn: 2, info: 1 }
      return (rank[b.severity] || 0) - (rank[a.severity] || 0) || b.age - a.age
    })
    .slice(0, 5)
}

export function mapOverviewToMonthlyV2(payload, fallback) {
  const counts = payload?.counts || {}
  const dailyTotal = Number(counts.dailyReceipts || 0)
  const matchRows = counts.dailyByMatchStatus || []
  const billRows = counts.billMatchByStatus || []
  const ledgerRows = counts.ledgerByStatus || []
  const pendingTour = rowCount(matchRows, 'status', 'pending')
  const inReview = rowCount(ledgerRows, 'status', 'in_review') || Number(counts.pendingReviewOpen || 0)
  const postedRows = rowCount(ledgerRows, 'status', 'posted')
  const billMatched = rowCount(billRows, 'status', 'matched') || rowCount(billRows, 'status', 'success')
  const alerts = deriveAlerts(counts)
  const activities = Array.isArray(counts.stageJobsRecent)
    ? counts.stageJobsRecent.map((job) => ({
        ts: job.created_at || job.startedAt || job.started_at || '',
        actor: 'system',
        actorLabel: '系统',
        verb: ACTIVITY_VERBS[job.status] || '记录',
        subject: `${stageLabel(job.stage)}${job.status ? ` ${statusLabel(job.status)}` : ''}`.trim(),
        before: '',
        after: job.errorMessage || '',
        rowId: job.dailyRowId || job.daily_row_id || '',
      }))
    : []

  return {
    ...fallback,
    workspaceKey: payload?.workspace?.workspaceKey || payload?.workspace?.workspace_key || fallback.workspaceKey,
    isDemo: Boolean(payload?.isTestMode),
    pipeline: {
      recognize: {
        ...fallback.pipeline.recognize,
        count: pendingTour,
        total: maxOf(dailyTotal, pendingTour),
      },
      review: {
        ...fallback.pipeline.review,
        count: inReview,
        total: maxOf(dailyTotal, inReview),
      },
      bridge: {
        ...fallback.pipeline.bridge,
        count: dailyTotal,
        total: dailyTotal,
      },
      match: {
        ...fallback.pipeline.match,
        count: billMatched || Number(counts.billMatchLogs || 0),
        total: maxOf(Number(counts.storeBills || 0), sumRows(billRows), billMatched),
      },
      closed: {
        ...fallback.pipeline.closed,
        count: postedRows,
        total: maxOf(dailyTotal, postedRows),
      },
    },
    alerts,
    summary: fallback.summary,
    activities,
  }
}
