/**
 * auditLogs — mock audit log data for D4b viewer.
 * Generates 220 entries spanning the last 30 days.
 */

const ACTIONS = [
  'login', 'logout',
  'import_daily', 'import_bill', 'import_group_code', 'import_received_receipt',
  'run_tour_match', 'run_bill_match', 'run_merge', 'run_second_pass',
  'resolve_pending_review', 'export_monthly',
  'publish_ledger', 'update_ledger_fields', 'delete_ledger_row', 'lock_workspace',
  'update_ledger_status', 'create_workspace', 'clear_workspace',
  'update_deduct_config', 'update_mode_mapping', 'migrate_daily_row',
]

const RESOURCE_TYPES = {
  login: 'auth', logout: 'auth',
  import_daily: 'daily_receipt', import_bill: 'store_bill',
  import_group_code: 'group_code', import_received_receipt: 'received_receipt',
  run_tour_match: 'stage_job', run_bill_match: 'stage_job',
  run_merge: 'stage_job', run_second_pass: 'stage_job',
  resolve_pending_review: 'pending_review',
  export_monthly: 'monthly_data',
  publish_ledger: 'daily_receipt', update_ledger_fields: 'daily_receipt',
  delete_ledger_row: 'daily_receipt', lock_workspace: 'monthly_workspace',
  update_ledger_status: 'daily_receipt', create_workspace: 'monthly_workspace',
  clear_workspace: 'monthly_workspace',
  update_deduct_config: 'monthly_workspace', update_mode_mapping: 'monthly_workspace',
  migrate_daily_row: 'daily_receipt',
}

const USERS = ['admin', 'operator1', 'operator2', 'system']
const WORKSPACES = ['demo-2026-05', 'demo-2026-04', 'demo-2026-03']
const IPS = ['192.168.1.10', '192.168.1.15', '192.168.1.22', '10.0.0.5']

function seededRand(seed) {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff
    return Math.abs(s) / 0xffffffff
  }
}

function pick(arr, rand) {
  return arr[Math.floor(rand() * arr.length)]
}

function fmtDate(d) {
  return d.toISOString()
}

export function getAuditLogs() {
  const rand = seededRand(42)
  const now = new Date('2026-05-23T08:00:00.000Z')
  const entries = []

  for (let i = 0; i < 220; i++) {
    const action = pick(ACTIONS, rand)
    const workspaceKey = action === 'login' || action === 'logout' ? null : pick(WORKSPACES, rand)
    const userId = action === 'run_tour_match' || action === 'run_merge' ? 'system' : pick(USERS, rand)
    const resourceType = RESOURCE_TYPES[action]
    const hasResourceId = resourceType === 'daily_receipt' || resourceType === 'pending_review'
    const resourceId = hasResourceId ? String(Math.floor(rand() * 900) + 100) : null
    // Spread entries over the last 30 days; denser near today
    const ageMs = rand() * 30 * 24 * 3600 * 1000
    const createdAt = new Date(now.getTime() - ageMs)

    entries.push({
      id: i + 1,
      seq: i + 1,
      workspaceKey,
      userId,
      action,
      resourceType,
      resourceId,
      details: buildDetails(action, workspaceKey, rand),
      ipAddress: userId === 'system' ? null : pick(IPS, rand),
      userAgent: userId === 'system' ? null : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      createdAt: fmtDate(createdAt),
    })
  }

  // Sort descending by createdAt
  entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return entries
}

function buildDetails(action, workspaceKey, rand) {
  const path = workspaceKey
    ? `/api/monthly/workspaces/${workspaceKey}/${action.replace(/_/g, '-')}`
    : `/api/monthly/${action.replace(/_/g, '-')}`
  const base = { method: methodFor(action), path, statusCode: 200 }

  if (action === 'import_daily') {
    return { ...base, rows: Math.floor(rand() * 400) + 50, filename: `daily_${workspaceKey}.xlsx` }
  }
  if (action === 'import_bill') {
    return { ...base, rows: Math.floor(rand() * 200) + 20, filename: `bill_${workspaceKey}.xlsx` }
  }
  if (action === 'run_merge' || action === 'run_bill_match' || action === 'run_tour_match') {
    return { ...base, inserted: Math.floor(rand() * 1200) + 100, skipped: Math.floor(rand() * 30) }
  }
  if (action === 'migrate_daily_row') {
    const src = pick(['demo-2026-05', 'demo-2026-04'], rand)
    const tgt = src === 'demo-2026-05' ? 'demo-2026-04' : 'demo-2026-03'
    return { sourceWorkspaceKey: src, targetWorkspaceKey: tgt, purchaseDate: '2026-04-15' }
  }
  if (action === 'export_monthly') {
    return { ...base, rows: Math.floor(rand() * 1500) + 200, folder: pick(['乐天首尔', '爱宝客', '济州新罗'], rand) }
  }
  return base
}

function methodFor(action) {
  if (action.startsWith('update_') || action === 'update_ledger_fields') return 'PATCH'
  if (action === 'update_deduct_config' || action === 'update_mode_mapping') return 'PUT'
  return 'POST'
}

export const DISTINCT_ACTIONS = ACTIONS
export const DISTINCT_USERS = USERS
export const DISTINCT_WORKSPACES = WORKSPACES
