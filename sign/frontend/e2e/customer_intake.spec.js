import { expect, test } from '@playwright/test'

// 客户建档页(A1 重构:顶部条 + 收图条 + 200+ 看板)的 E2E smoke。
// 用 page.route mock /api/auth/me 成 admin 绕过登录(纯前端 mock,不碰真实密码/DB)。
// 喂 3 个不同状态客户,验证:看板渲染、状态筛选、搜索、单客户「重识别」触发正确 API。

const baseUrl = process.env.E2E_BASE_URL || 'http://127.0.0.1:5177/app/dist'

const WORKSPACE = 'demo-2026-06-18'

// 3 个客户:就绪 / 处理中 / 异常,覆盖三档 filterKey
const customers = [
  {
    customerId: 'CL20260618-001',
    agentName: '六六大顺',
    status: 'ready_for_review',
    images: [{}, {}, {}],
    preprocess: { status: 'processed', totalImages: 3, outputImages: 3, splitImages: 2, failedImages: 0 },
    createdAt: '2026-06-18T10:00:00Z',
  },
  {
    customerId: 'CL20260618-002',
    agentName: 'ABBY',
    status: 'processed',
    images: [{}, {}, {}],
    preprocess: { status: 'processing', totalImages: 3, currentImage: 2, failedImages: 0 },
    createdAt: '2026-06-18T10:01:00Z',
  },
  {
    customerId: 'CL20260618-003',
    agentName: 'BAI YILAN',
    status: 'in_review',
    images: [{}, {}, {}, {}],
    preprocess: { status: 'needs_review', totalImages: 4, outputImages: 4, splitImages: 1, failedImages: 1 },
    createdAt: '2026-06-18T10:02:00Z',
  },
]

function json(body) {
  return { contentType: 'application/json', body: JSON.stringify(body) }
}

async function mockApi(page) {
  // 兜底先注册(后注册的具体路由优先匹配)。
  // 只匹配「端口后紧跟 /api/」的后端请求,避免误伤 dev 模式下 src/api/*.js 模块脚本(其路径也含 /api/)。
  await page.route(/:\d+\/api\//, (route) => route.fulfill(json({})))
  await page.route('**/api/auth/me', (route) => route.fulfill(json({ user: { username: 'admin', role: 'admin' } })))
  await page.route('**/api/customer-library/state', (route) => route.fulfill(json({ workspaces: [WORKSPACE], workspaceKey: WORKSPACE })))
  await page.route('**/api/customer-library/workspaces', (route) => route.fulfill(json({ workspaces: [WORKSPACE], workspaceKey: WORKSPACE })))
  await page.route('**/api/customer-library/workspaces/*/customers', (route) => route.fulfill(json({ customers })))
  await page.route('**/api/batches**', (route) => route.fulfill(json({ batches: [] })))
}

test('客户建档:看板渲染 + 筛选 + 搜索', async ({ page }) => {
  await mockApi(page)
  await page.goto(`${baseUrl}/intake`)

  // 看板渲染出 3 个客户行
  await expect(page.locator('.cl-row')).toHaveCount(3)
  // ⚠️ 2026-08-01 按既有拍板改写:原来断言 .cl-topbar 含「可同步」——
  // 那条横条已随页面融合删掉(CustomerLibraryView.vue:1203 注释写明),
  // 而「可同步/就绪」这套**管道说法**本身也是 2026-07-27 用户拍板去掉的:
  // 三桶只讲业务(异常 / 处理中 / 已完成),因为同步是全自动的,操作员看了也没法动手。
  // 所以这里不是"换个选择器套旧词",是断言要跟上新口径。
  const buckets = page.locator('.cl-filters')
  await expect(buckets).toBeVisible()
  await expect(buckets).toContainText('异常')
  await expect(buckets).toContainText('处理中')
  await expect(buckets).toContainText('已完成')
  await expect(buckets).not.toContainText('可同步')
  // 收图区「建档」按钮 + 自动识别开关
  await expect(page.getByRole('button', { name: '建档' })).toBeVisible()
  await expect(page.getByText('上传后自动识别')).toBeVisible()

  const filters = page.locator('.cl-filters')
  // 筛选「异常」→ 只剩 BAI YILAN(failedImages 1 → danger)
  await filters.getByRole('button', { name: /异常/ }).click()
  await expect(page.locator('.cl-row')).toHaveCount(1)
  await expect(page.locator('.cl-row')).toContainText('BAI YILAN')

  // 回「全部」,搜索 ABBY → 只剩 1 行
  await filters.getByRole('button', { name: /全部/ }).click()
  await page.locator('.cl-search').fill('ABBY')
  await expect(page.locator('.cl-row')).toHaveCount(1)
  await expect(page.locator('.cl-row')).toContainText('ABBY')
})

test('客户建档:单客户「重识别」触发 preprocess API', async ({ page }) => {
  await mockApi(page)
  let reprocessUrl = ''
  await page.route('**/api/customer-library/workspaces/*/customers/*/preprocess', (route) => {
    reprocessUrl = route.request().url()
    return route.fulfill(json({ ok: true }))
  })
  await page.goto(`${baseUrl}/intake`)

  await expect(page.locator('.cl-row')).toHaveCount(3)
  await page.locator('.cl-row', { hasText: '六六大顺' }).getByRole('button', { name: '重识别' }).click()

  await expect.poll(() => reprocessUrl).toContain('/customers/CL20260618-001/preprocess')
})
