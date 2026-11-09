import { expect, test } from '@playwright/test'

// 回归:账单匹配页选文件上传后,必须真的发出 POST /imports/store-bill。
// 这条就是之前真·UI 验收发现、但单元测试漏掉的盲区(上传链路没触发后端导入)。
const baseUrl = process.env.E2E_BASE_URL || 'http://127.0.0.1:5177/app/dist'
const WS = 'demo-2026-06'
const FOLDER = '爱宝客'

function bucket(overrides = {}) {
  return {
    folder: FOLDER,
    billCount: 0,
    dailyCount: 5,
    modeRaws: ['爱宝客SG-本司'],
    billFiles: [],
    deductValue: 0.05,
    deductConfirmedAt: null,
    matchStats: { matched: 0, unmatched: 0, pendingReview: 0 },
    isEmpty: false,
    ...overrides,
  }
}

test('账单匹配:选文件→确认替换 必须发出 POST /imports/store-bill', async ({ page }) => {
  let storeBillUploadCalled = 0
  let clearCalled = 0

  // 先注册兜底,再注册精确路由(Playwright 后注册的优先)。
  await page.route('**/api/monthly/**', (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ rows: [], items: [], unmapped: [], total: 0 }),
  }))
  await page.route('**/api/auth/me', (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ user: { username: 'admin', role: 'admin' } }),
  }))
  await page.route('**/api/monthly/workspaces?mode=all', (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ workspaces: [{ workspaceKey: WS, isTestMode: true }] }),
  }))
  await page.route(`**/api/monthly/workspaces/${WS}/bill-match/buckets`, (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ buckets: [bucket()], global: { totalBills: 0, totalDaily: 5, matched: 0, matchRate: 0 } }),
  }))
  await page.route(`**/api/monthly/workspaces/${WS}/mode-mapping`, (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ items: [], unmapped: [] }),
  }))
  // 清桶(replace 模式先删旧账单)
  await page.route(`**/api/monthly/workspaces/${WS}/bill-match/buckets/*`, (route) => {
    if (route.request().method() === 'DELETE') {
      clearCalled += 1
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ deletedBills: 0 }) })
    }
    return route.fallback()
  })
  // 关键:店铺账单导入端点
  await page.route(`**/api/monthly/workspaces/${WS}/imports/store-bill`, (route) => {
    storeBillUploadCalled += 1
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ job: { id: 1, status: 'done', rowsInserted: 127, rowsTotal: 127 } }) })
  })

  await page.goto(`${baseUrl}/monthly/v2/${WS}/bill-match`)

  // 桶卡片里的隐藏文件输入
  const fileInput = page.locator('input[type="file"]').first()
  await fileInput.setInputFiles({
    name: 'aibaoke_bill.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from('PK\u0003\u0004 fake-xlsx'),
  })

  // replace 模式:出现应用内二次确认,点确认才上传(不依赖 window.confirm)
  await expect(page.getByTestId('replace-confirm')).toBeVisible()
  await page.getByTestId('replace-confirm-ok').click()

  // 核心断言:上传请求真的发出去了(这正是之前漏掉、UI 验收才发现的盲区)。
  // replace 模式还应先清旧账单。成功 toast 因 import-completed 触发桶刷新会被卸载冲掉,
  // 属已知的瞬时反馈,这里不断言它(不稳定),靠"请求是否真的发出"兜底。
  await expect.poll(() => storeBillUploadCalled, { timeout: 10_000 }).toBeGreaterThan(0)
  expect(clearCalled).toBeGreaterThan(0)
})
