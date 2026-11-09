import { activities, bills, dailyRows, SEED } from './seed.js'

const MODES = ['乐天首尔', '乐天釜山', '爱宝客', '济州新罗']
const customerByNo = new Map(SEED.customers.map((c) => [c.customerNo, c]))
const passportById = new Map(SEED.passports.map((p) => [p.id, p]))

export function getMonthly(workspaceKey = 'demo-2026-05') {
  const isDemo = workspaceKey.startsWith('demo-')
  const negative = workspaceKey.endsWith('06')
  return {
    workspaceKey,
    isDemo,
    modeBindings: MODES.map((mode) => ({
      mode,
      folder: mode === '乐天釜山' ? null : `/Users/monthly/${mode}-202605`,
      bound: mode !== '乐天釜山',
    })),
    pipeline: {
      recognize: { count: 12, total: 72, hint: '耗时 4.2 分 → 进展', warning: null, unit: 'passports' },
      review: { count: 38, total: 53, hint: '最久 2 小时', warning: '1 卡顿', unit: 'passports' },
      bridge: { count: 164, total: 164, hint: 'bridge 干净', warning: null, unit: 'rows' },
      match: { count: 1203, total: 1370, hint: '6 类匹配齐全', warning: '11 待审', unit: 'rows' },
    },
    alerts: [
      { id: 1, severity: 'error', label: '字段冲突', count: 3, link: `/monthly/v2/${workspaceKey}/conflicts`, age: 9 },
      { id: 2, severity: 'warn', label: '跨月分摊未确认', count: 1, link: '#', age: 8 },
      { id: 3, severity: 'warn', label: 'bill 未匹配', count: 11, link: `/monthly/v2/${workspaceKey}/unreceived`, age: 7 },
      { id: 4, severity: 'warn', label: '模式未绑定文件夹', count: 1, link: '#', age: 6 },
      { id: 5, severity: 'info', label: '手动锁字段(不会被覆盖)', count: 27, link: '#', age: 5 },
    ],
    summary: {
      netKrw: 124830200,
      netUsd: 102343.21,
      commission: 4213.88,
      lastMonthDiff: negative ? -382.21 : 382.21,
      lastMonthDiffDirection: negative ? 'down' : 'up',
      scan7d: [4, 8, 14, 22, 38, 51, 62],
      healthOk: !negative,
      healthLastCheck: '2 分钟前',
      failedChecks: negative ? ['H2', 'H5'] : [],
    },
    activities,
  }
}

export function getConflicts() {
  const pending = SEED.passports.slice(0, 12).map((p, i) => {
    const c = customerByNo.get(p.customerNo)
    return {
      id: `c${i + 1}`,
      rowId: `d${i + 1}`,
      passportId: p.id,
      passportNo: p.passportNo,
      customerName: c.nameZh,
      mode: p.mode,
      age: i ? `${i} 小时前` : '2 分钟前',
      fields: [
        { field: 'birth', label: '出生日期', current: p.birth, incoming: p.birth.replace('-04-', '-03-'), severity: i % 3 ? 'warn' : 'error', currentSource: '上次审核', incomingSource: '本次复跑', isLocked: false },
        { field: 'customerName', label: '客户姓名', current: c.nameZh, incoming: c.nameZh, severity: 'warn', currentSource: '台账', incomingSource: 'OCR', isLocked: i % 4 === 0 },
      ],
    }
  })
  return { pending, resolved: pending.slice(0, 8).map((item) => ({ ...item, resolved: true })) }
}

export function getUnreceived() {
  const billRows = bills.slice(0, 23).map((b, i) => ({
    ...b,
    matchedRowId: null,
    billNo: `B-2026-${10038 + i}`,
    candidates: dailyRows.slice(i, i + 3).map((row, j) => {
      const p = passportById.get(row.passportId)
      const c = customerByNo.get(p.customerNo)
      return { rowId: row.id, passportNo: p.passportNo, customerName: c.nameZh, score: [0.87, 0.64, 0.48][j], matchedFields: ['amount', 'date', 'mode'].slice(0, 3 - j) }
    }),
  }))
  return {
    orphanBills: billRows,
    knownMissing: dailyRows.slice(0, 3).map((row, i) => {
      const p = passportById.get(row.passportId)
      const c = customerByNo.get(p.customerNo)
      return {
        ...row,
        receiptNo: row.id,
        amount: row.netKrw,
        currency: 'KRW',
        priority: (i % 6) + 1,
        date: row.purchaseDate,
        customerName: c.nameZh,
        passportNo: p.passportNo,
        candidates: [],
      }
    }),
  }
}

// getManualEntries 已删除(2026-06-12):手动录入页下线,未收补录在未收清单页走真实接口。

export function getRowHistory(rowId = 'd1') {
  const row = dailyRows.find((item) => item.id === rowId) || dailyRows[0]
  const p = passportById.get(row.passportId)
  const c = customerByNo.get(p.customerNo)
  return {
    rowId,
    passportNo: p.passportNo,
    customerName: c.nameZh,
    mode: row.mode,
    events: ['manual_edit', 'bridge_migration', 'pending_resolution', 'ocr', 'manual_no_image'].flatMap((source, i) => [0, 1, 2].map((n) => ({ ts: `2026-05-23T${14 - i}:${20 - n * 4}:00`, actor: i % 2 ? '系统' : '韩', actorType: i % 2 ? 'system' : 'user', changeSource: source, field: ['birth', 'workspace_key', 'customerName'][n], label: ['出生日期', 'workspace_key', '客户姓名'][n], before: n ? '2026-05' : '1985-03-04', after: n ? '2026-06' : '1985-04-04', conflictId: source === 'pending_resolution' ? 'c1' : null, locked: n === 2 }))),
  }
}
