import { expect, test } from '@playwright/test'

/**
 * 0727#7「搜索处删除不好使,重复删删不掉」的浏览器级回归。
 *
 * 之前这条只有源码断言 + 纯函数验证 —— 接线通了,但从没在真浏览器里点过一次。
 * 2026-08-01 在本地实例手工跑通了 4 条,这里固化成用例,免得下次又退回"只在会话里验过"。
 *
 * 用户报的"删不掉"有三层,缺一层都还是删不掉:
 *   ① 点 × 要清**输入框草稿**;
 *   ② 同时要撤掉**已生效的筛选**(原生 type=search 的 × 只做①,所以字没了列表还是搜索结果);
 *   ③ URL 里的 search 参数也要抹掉 —— 否则刷新/后退会被读回来,看起来像"删了又回来"。
 *
 * ⚠️ 测法上的坑(第一次就栽在这):URL 同步是**异步**的,点完立刻读 location.search
 * 会读到更新前的值,得出"没生效"的错误结论。这里一律用 expect(...).toHaveURL 等待。
 */

const baseUrl = process.env.E2E_BASE_URL || 'http://127.0.0.1:5177/app/dist'

async function stubAgentWorkspace(page) {
  await page.route('**/api/auth/me', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ user: { username: 'admin', role: 'admin' } }),
  }))
  // 代理视图的数据源:给一份空但结构完整的响应,本用例只关心搜索框的行为
  await page.route('**/api/agent-workspace/**', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ agents: [], customers: [], months: ['2026-07'], total: 0 }),
  }))
}

test('搜索清除:× 同时清草稿和已生效筛选,且刷新不会读回来', async ({ page }) => {
  await stubAgentWorkspace(page)
  await page.goto(`${baseUrl}/agents?month=2026-07`)

  const input = page.locator('.aw-search-top-input')
  await expect(input).toBeVisible()
  // 必须是 type=text:原生 search 的 × 只清草稿,是"删不掉"的根因之一
  await expect(input).toHaveAttribute('type', 'text')

  await input.fill('ZHANG')
  await input.press('Enter')
  await expect(page).toHaveURL(/search=ZHANG/)          // ① 搜索确实生效
  const clearBtn = page.locator('.aw-search-top-clear')
  await expect(clearBtn).toBeVisible()

  await clearBtn.click()
  await expect(input).toHaveValue('')                    // ② 草稿清了
  await expect(page).not.toHaveURL(/search=/)            // ③ 已生效的筛选也撤了
  await expect(clearBtn).toBeHidden()

  await page.reload()                                    // ④ 刷新不会被读回来
  await expect(page).not.toHaveURL(/search=/)
  await expect(page.locator('.aw-search-top-input')).toHaveValue('')
})

test('搜索清除:Esc 与 × 等效(两处都清)', async ({ page }) => {
  await stubAgentWorkspace(page)
  await page.goto(`${baseUrl}/agents?month=2026-07`)

  const input = page.locator('.aw-search-top-input')
  await input.fill('LI SI')
  await input.press('Enter')
  await expect(page).toHaveURL(/search=LI(\+|%20)SI/)

  await input.press('Escape')
  await expect(input).toHaveValue('')
  await expect(page).not.toHaveURL(/search=/)
})
