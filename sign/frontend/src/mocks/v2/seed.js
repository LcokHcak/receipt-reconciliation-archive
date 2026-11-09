const MODES = ['乐天首尔', '乐天釜山', '爱宝客', '济州新罗']
const NAMES = [
  ['KR-2024-0117', '韩雪', '한설'],
  ['KR-2024-0118', '金哲', '김철'],
  ['KR-2024-0119', '李敏', '이민'],
  ['KR-2024-0120', '朴恩', '박은'],
  ['KR-2024-0121', '崔娜', '최나'],
  ['KR-2024-0122', '郑宇', '정우'],
  ['KR-2024-0123', '宋雅', '송아'],
  ['KR-2024-0124', '姜俊', '강준'],
]

export const SEED = {
  workspaces: ['2026-05', '2026-04', '2026-03', 'demo-2026-05'],
  customers: NAMES.map(([customerNo, nameZh, nameKo], i) => ({
    customerNo,
    nameZh,
    nameKo,
    phone: `010-12${i}4-56${i}8`,
    vip: i % 3 === 0,
  })),
  passports: Array.from({ length: 30 }, (_, i) => {
    const customer = NAMES[i % NAMES.length]
    return {
      id: `p${i + 1}`,
      passportNo: `M12345${String(678 + i).padStart(3, '0')}`,
      customerNo: customer[0],
      birth: `1985-04-${String((i % 20) + 1).padStart(2, '0')}`,
      expiry: `2032-09-${String((i % 20) + 1).padStart(2, '0')}`,
      mode: MODES[i % MODES.length],
      purchaseDate: `2026-05-${String((i % 24) + 1).padStart(2, '0')}`,
      batchId: `b${(i % 4) + 1}`,
      ocrLocked: i % 5 === 0 ? ['customerName'] : [],
      conflictFields: i % 4 === 0 ? ['birth'] : [],
    }
  }),
}

export const bills = Array.from({ length: 40 }, (_, i) => ({
  id: `bill${i + 1}`,
  amount: 82000 + i * 3100,
  currency: i % 4 === 0 ? 'USD' : 'KRW',
  date: `2026-05-${String((i % 24) + 1).padStart(2, '0')}`,
  priority: (i % 6) + 1,
  matchedRowId: i % 3 === 0 ? null : `d${i + 1}`,
  mode: MODES[i % MODES.length],
}))

export const dailyRows = Array.from({ length: 40 }, (_, i) => ({
  id: `d${i + 1}`,
  workspaceKey: i % 9 === 0 ? 'demo-2026-05' : '2026-05',
  passportId: `p${(i % 30) + 1}`,
  mode: MODES[i % MODES.length],
  grossKrw: 124300 + i * 900,
  deductKrw: i % 6 === 0 ? 1000 : 0,
  netKrw: 123300 + i * 900,
  netUsd: Number((101.24 + i * 0.9).toFixed(2)),
  purchaseDate: `2026-05-${String((i % 24) + 1).padStart(2, '0')}`,
  billId: i % 3 === 0 ? null : `bill${i + 1}`,
  lockedFields: i % 5 === 0 ? ['customerName'] : [],
  history: [],
}))

export const activities = Array.from({ length: 50 }, (_, i) => ({
  rowId: `d${(i % 40) + 1}`,
  ts: `${String(14 - Math.floor(i / 6)).padStart(2, '0')}:${String(22 - (i % 6) * 4).padStart(2, '0')}`,
  actor: i % 3 === 0 ? 'system' : 'user',
  actorLabel: i % 3 === 0 ? '系' : '韩',
  verb: ['改', 'bridge', '锁', '匹配', '健康'][i % 5],
  subject: i % 5 === 1 ? `daily.row_${88 + i} → 2026-05 / 跨月分摊到 2026-06` : `护照#KR${1234 + i} 出生日期`,
  before: i % 5 === 0 ? '1985-03-04' : null,
  after: i % 5 === 0 ? '1985-04-04' : null,
}))

SEED.bills = bills
SEED.dailyRows = dailyRows
SEED.activities = activities
