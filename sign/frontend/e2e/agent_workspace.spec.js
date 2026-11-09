import { expect, test } from '@playwright/test'

// 代理工作台 V2 端到端验收(Task 12)。
// 与 customer_intake.spec.js 同法:page.route mock 后端(不碰真实密码/DB);
// 服务端权限矩阵已由 tests/agent_workspace_routes.test.js 用真 JWT 验过,
// 这里验的是 UI 行为:选月/搜代理/模式筛选/翻页/深链/返回/完成任务/跨月遗留/布局。

const PAGE = '/app/dist/agents'

const AGENTS = Array.from({ length: 12 }, (_, i) => ({
  agentKey: `代理${i}`, agentName: `代理${i}`, agentUnlabeled: false,
  customerCount: 40 - i, openCount: i % 4, abnormalCount: 0, abnormalImageCount: 0,
}))

function makeCustomers(offset, n, { agent = '代理0' } = {}) {
  return Array.from({ length: n }, (_, i) => {
    const idx = offset + i
    return {
      customerPk: `ws::CL-${idx}`,
      customerId: `CL-${idx}`,
      customerName: `客户${idx}`,
      agentKey: agent, agentName: agent,
      reviewStatus: idx % 3 === 0 ? 'tour_pending' : 'review_pending',
      receivedAt: '2026-07-10T03:00:00.000Z',
      originalImageCount: 4, abnormalImageCount: 0,
      batchId: 'b1', groupKey: `CL-${idx}`,
      confirmedModes: idx % 2 === 0 ? ['发17号'] : [],
      candidateModes: idx % 2 === 0 ? [] : ['乐天正常'],
    }
  })
}

const TASKS = [
  {
    id: 'wt_1', taskKey: 'k1', calendarMonth: '2026-07', workspaceKey: 'ws', customerId: 'CL-1',
    batchId: 'b1', groupKey: 'CL-1', agentKey: '代理0', taskType: 'send_upstream', subtype: 'send_17',
    status: 'pending', dueAt: '2026-07-12T02:00:00.000Z', overdue: true, mode: '发17号', tourNo: '2600041',
    createdAt: '2026-07-11T22:00:00.000Z', sourceVersion: 1,
  },
  {
    id: 'wt_2', taskKey: 'k2', calendarMonth: '2026-06', workspaceKey: 'ws', customerId: 'CL-june',
    batchId: 'b0', groupKey: 'CL-june', agentKey: '代理1', taskType: 'send_upstream', subtype: 's_activity',
    status: 'pending', dueAt: '2026-07-13T08:00:00.000Z', overdue: false, mode: 'S活动', tourNo: '',
    createdAt: '2026-06-30T08:00:00.000Z', sourceVersion: 1,
  },
]

function json(body) {
  return { contentType: 'application/json', body: JSON.stringify(body) }
}

async function mockWorkspace(page, { role = 'admin' } = {}) {
  const calls = { completed: [], customers: [] }
  await page.route('**/api/auth/me', (route) => route.fulfill(json({
    ok: true, user: { id: 1, userId: 1, username: 'e2e', role },
  })))
  await page.route('**/api/agent-workspace/v1/months', (route) => route.fulfill(json({
    ok: true, months: [{ month: '2026-07', customers: 80 }, { month: '2026-06', customers: 50 }],
  })))
  await page.route('**/api/agent-workspace/v1/summary**', (route) => route.fulfill(json({
    ok: true, month: '2026-07',
    visibleAll: { totalCustomers: 20000, byStatus: { tour_pending: 40, review_pending: 25 } },
    selectedAgent: null, projectionLagMs: 1000, warnings: { unknownMonthCustomers: 0, unlabeledAgentCustomers: 0 },
  })))
  await page.route('**/api/agent-workspace/v1/agents**', (route) => route.fulfill(json({
    ok: true, month: '2026-07', agents: AGENTS,
  })))
  await page.route('**/api/agent-workspace/v1/customers**', (route) => {
    const url = new URL(route.request().url())
    calls.customers.push(Object.fromEntries(url.searchParams.entries()))
    const cursor = url.searchParams.get('cursor') || ''
    const mode = url.searchParams.get('mode') || ''
    if (mode) {
      return route.fulfill(json({ ok: true, month: '2026-07', customers: makeCustomers(500, 3), nextCursor: '' }))
    }
    if (cursor === 'page2') {
      return route.fulfill(json({ ok: true, month: '2026-07', customers: makeCustomers(50, 20), nextCursor: '' }))
    }
    return route.fulfill(json({ ok: true, month: '2026-07', customers: makeCustomers(0, 50), nextCursor: 'page2' }))
  })
  await page.route('**/api/agent-workspace/v1/tasks**', (route) => route.fulfill(json({
    ok: true, month: '2026-07', tasks: TASKS,
  })))
  await page.route('**/api/agent-workspace/v1/tasks/*/complete', (route) => {
    const id = route.request().url().match(/tasks\/([^/]+)\/complete/)[1]
    calls.completed.push(id)
    return route.fulfill(json({
      ok: true, task: { ...TASKS.find((t) => t.id === id), status: 'done', completedBy: 'e2e' }, idempotent: false,
    }))
  })
  return calls
}

// ⚠️ 2026-08-01 按既有拍板改写(见 docs/e2e-失败七条-定性_2026-08-01.md):
//   · 标题「代理工作台」→「客户中心」(0728 波3 全站重命名);
//   · 右栏任务列已于 2026-07-18 拍板下线(commit 85cf7c0),.task-rail/.tr-* 全部不存在,
//     三栏也随之变两栏 —— 相关断言不是"修选择器"能救的,是**该测的东西没了**,故删。
// 这些用例从 07-18 起就该红,只是套件当时跑不起来(见 commit 17b164f),没人看见。
test('两栏渲染+选月+搜代理+模式筛选+翻页;DOM 不含全量客户', async ({ page }) => {
  const calls = await mockWorkspace(page)
  await page.goto(PAGE)

  // 两栏就位;默认月=最近有数据月
  await expect(page.locator('.aw-col-agents')).toBeVisible()
  await expect(page.getByRole('heading', { name: '客户中心' })).toBeVisible()
  await expect(page.locator('.aw-select select').first()).toHaveValue('2026-07')

  // 20k 总量只渲染第一页 50 行(DOM 不含全量客户)
  await expect(page.locator('.cust-table tbody tr')).toHaveCount(50)
  // getByText('20000') 现在会命中两处(总数标签 + 别处),strict mode 直接报错。
  // 这条要证的是「总数显示出来了、但 DOM 里没有两万行」——用 first() 取其一即可,
  // 真正的证据是上面那句 toHaveCount(50)。(2026-08-01:断言太宽,不是产品问题。)
  await expect(page.getByText('20000').first()).toBeVisible()

  // 搜索代理:本地过滤
  await page.getByLabel('搜索代理').fill('代理3')
  await expect(page.locator('.al-item')).toHaveCount(1)
  await page.getByLabel('搜索代理').fill('')

  // 选代理 → 请求带 agentKey 且 URL 同步
  await page.locator('.al-item', { hasText: '代理2' }).click()
  await expect(page).toHaveURL(/agentKey=/)

  // 翻页:加载更多 append 到 70 行,不清列表
  await page.getByRole('button', { name: '加载更多' }).click()
  await expect(page.locator('.cust-table tbody tr')).toHaveCount(70)

  // 模式筛选(2026-08-01 按既有拍板改写):
  // 原来断言"点行内模式 chip → 顶栏出现可清除的 .aw-mode-filter 标签"。
  // 2026-07-13「按 GPT V1.0 规格对齐」那次已明确把**模式筛选改成中栏持久下拉**
  // (commit ba733f6 的说明原话:「模式筛选改中栏持久下拉(选项来自模式矩阵)」),
  // 顶栏那个临时标签随之取消。所以这里跟上新交互:用下拉筛、清空即取消。
  const modeSelect = page.getByLabel('按模式筛选')
  await expect(modeSelect).toBeVisible()
  await modeSelect.selectOption({ index: 1 })
  await expect(page).toHaveURL(/mode=/)
  await expect(page.locator('.cust-table tbody tr')).toHaveCount(3)
  await modeSelect.selectOption('')
  await expect(page).not.toHaveURL(/mode=/)

  // (原「跨月遗留任务:右栏显示来源月标记」已删 —— 右栏任务列 0718 拍板下线,
  //  .tr-group/.tr-month 不再存在。这不是选择器换了名字,是这块 UI 整个没了。)

  // 客户翻页请求确实带 cursor(服务端分页而非前端切片)
  expect(calls.customers.some((q) => q.cursor === 'page2')).toBeTruthy()
})

// 原名「深链跳审核带 returnTo;完成任务打到 complete 接口」。
// 「完成任务」那半测的是右栏任务列的 .tr-done —— 右栏 0718 拍板下线,那个按钮不存在了,
// 删掉;深链 returnTo 这半仍然有效(而且 0801 刚给 /library 也接了 returnTo),留着。
test('深链跳审核带 returnTo', async ({ page }) => {
  await mockWorkspace(page)
  await page.goto(PAGE)
  await expect(page.locator('.cust-table tbody tr')).toHaveCount(50)

  // 行内「审核」深链:URL = /review/b1?view=queue&group=...&returnTo=/agents...
  await page.locator('.ct-open').first().click()
  await expect(page).toHaveURL(/\/review\/b1\?/)
  await expect(page).toHaveURL(/view=queue/)
  await expect(page).toHaveURL(/returnTo=(%2F|\/)agents/) // 编码与否取决于 router 版本,两种都算带上了
})

// (原「finance 只读:任务完成按钮不渲染」整条删除 —— 它测的对象是右栏任务列
//  的只读态,而右栏 2026-07-18 拍板下线(commit 85cf7c0),.task-rail/.tr-done 都不存在。
//  这条不是"改选择器就能救",是被测的功能整个没了。finance 的只读边界另有覆盖:
//  路由 meta 权限 + 后端 requireAdmin,见 tests/config_console_routes.test.js。)

// 右栏下线后是**两栏**;≤1100 的"右栏转抽屉"随右栏一起没了,故删该段。
test('1366 与 1920 布局:两栏不重叠', async ({ page }) => {
  await mockWorkspace(page)

  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto(PAGE)
  await expect(page.locator('.cust-table tbody tr')).toHaveCount(50)
  const cols = page.locator('.aw-col')
  await expect(cols).toHaveCount(2)
  const boxes = []
  for (let i = 0; i < 2; i += 1) boxes.push(await cols.nth(i).boundingBox())
  // 从左到右不重叠
  expect(boxes[0].x + boxes[0].width).toBeLessThanOrEqual(boxes[1].x + 1)
  await page.screenshot({ path: 'tmp/e2e-agent-workspace-1920.png' })

  await page.setViewportSize({ width: 1366, height: 768 })
  await expect(cols.nth(0)).toBeVisible()
  await page.screenshot({ path: 'tmp/e2e-agent-workspace-1366.png' })
})
