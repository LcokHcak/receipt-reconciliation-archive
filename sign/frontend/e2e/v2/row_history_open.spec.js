import { expect, test } from '@playwright/test'

/**
 * 行历史抽屉:从**冲突详情**打开,拉真接口、渲染事件、不回落 mock。
 *
 * ⚠️ 2026-08-01 重写。原来这条走的是「未收页 → 展开行 → 点候选的历史按钮」,
 * 而那条路已经不存在了,连着三处都变了:
 *   ① 未收列表的数据源换成 /bill-match/unreceived(commit e365209「未收补录取代手动录入页」),
 *      spec 还在 stub 早就不喂这个页面的 /orphans/bills 和 /missing(后者还返回空)——
 *      于是 unreceived-row 永远等不到,30s 超时;
 *   ② 修好①之后卡在下一步:候选(LinkSuggestion)在未收页被**有意**砍掉了 ——
 *      UnreceivedView.normalizeUnreceived 把 candidates 硬置成 [],
 *      源码注释原话「行级未收 (账单有台账无) — 无候选/优先级」。
 *      而 data-testid="candidate-history" 只存在于 LinkSuggestion 里,
 *      所以这个入口在未收页**结构上就不可能出现**;
 *   ③ 抽屉本身还在,现在的活入口是冲突页 ConflictDetail 的「历史」按钮。
 * 所以这条改成从冲突页进 —— 测的还是同一件事(抽屉拉真接口、渲染事件、不回落 mock),
 * 只是走它现在真实存在的那条路。
 *
 * 另修:原文件里 `getByText('mock 鍥為€€')` 是乱码(应为 'mock 回退',兄弟 spec 里都是对的)。
 * 乱码的后果不是报错,是**这条断言永远成立** —— 页面上不可能出现那串乱码,
 * 于是"没有回落到 mock 数据"这件事其实一直没被验证过。恒真的断言比写错更糟。
 */

const baseUrl = process.env.E2E_BASE_URL || 'http://127.0.0.1:5177/app/dist'

// ⚠️ 抽屉默认按「近 30 天」筛(RowHistoryDrawer 的 filters.range='30')。
// 事件时间写死的话,过了 30 天就被默认筛选滤掉 —— 原 spec 钉的 2026-05-23 到今天已 70 天,
// 于是接口明明返回了 1 条、页面却渲染 0 条。今天已经是第三枚同族的跨时间炸弹了。
const recentIso = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString()

test('E5 行历史抽屉:从冲突详情打开,拉真接口渲染事件,不回落 mock', async ({ page }) => {
  await page.route('**/api/auth/me', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ user: { username: 'admin', role: 'admin' } }),
  }))
  await page.route('**/api/monthly/workspaces?mode=all', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ workspaces: [{ workspaceKey: 'demo-2026-05', isTestMode: true }] }),
  }))
  await page.route('**/api/monthly/workspaces/demo-2026-05/pending-reviews?status=open&limit=200', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      rows: [{
        id: 101,
        sourceTable: 'store_bill',
        sourceId: 201,
        reasonType: 'field_conflict',
        status: 'open',
        createdAt: '2026-05-23T09:00:00Z',
        detail: {
          dailyReceiptId: 301,
          passportNo: 'M12345678',
          customerName: '韩雪',
          modeFolder: '乐天首尔',
          purchaseDate: '2026-05-12',
          conflicts: [{ field: 'tourNo', dailyValue: 'T001', billValue: 'T002' }],
        },
      }],
      total: 1,
      byReason: [{ reason: 'field_conflict', n: 1 }],
    }),
  }))
  await page.route('**/api/monthly/workspaces/demo-2026-05/pending-reviews?status=resolved&limit=200', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ rows: [], total: 0, byReason: [] }),
  }))
  // 抽屉真正要拉的接口:行历史
  await page.route('**/api/monthly/v2/demo-2026-05/daily/301/history*', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      items: [{
        id: 1,
        dailyRowId: 301,
        field: 'purchase_date',
        before_value: '"2026-05-11"',
        after_value: '"2026-05-12"',
        change_source: 'manual_edit',
        actor: 'admin',
        ts: recentIso,
        conflictId: null,
      }],
      total: 1,
    }),
  }))

  await page.goto(`${baseUrl}/monthly/v2/demo-2026-05/conflicts`)
  await page.getByRole('button', { name: '历史' }).first().click()

  await expect(page.getByTestId('row-history-drawer')).toBeVisible()
  await expect(page.getByTestId('history-event')).toHaveCount(1)
  // 断言"没有回落到 mock 数据" —— 这句原来是乱码,等于没在验
  await expect(page.getByText('mock 回退')).toHaveCount(0)
})
