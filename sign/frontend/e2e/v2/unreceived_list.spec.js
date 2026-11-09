import { expect, test } from '@playwright/test'

const baseUrl = process.env.E2E_BASE_URL || 'http://127.0.0.1:5177/app/dist'

test('E3 unreceived renders 台账有账单无 rows from the unified bill-match/unreceived api', async ({ page }) => {
  await page.route('**/api/auth/me', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ user: { username: 'admin', role: 'admin' } }),
  }))
  await page.route('**/api/monthly/workspaces?mode=all', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ workspaces: [{ workspaceKey: 'demo-2026-05', isTestMode: true }] }),
  }))
  await page.route('**/api/monthly/workspaces/demo-2026-05/bill-match/unreceived*', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      rows: [{
        mode_raw: 'LOTTE',
        tour_no: 'T001',
        purchase_date: '2026-05-12',
        name: '韩雪',
        passport_no: 'M12345678',
        receipt_no: 'RX-2026-8801',
        brand: 'BRAND',
        net_usd: 124.3,
        agent: 'A1',
        mode_folder: '乐天首尔',
      }],
      total: 1,
    }),
  }))

  await page.goto(`${baseUrl}/monthly/v2/demo-2026-05/unreceived`)

  await expect(page.getByTestId('unreceived-table')).toBeVisible()
  await expect(page.getByTestId('unreceived-row')).toHaveCount(1)
  await expect(page.getByTestId('unreceived-known-tab')).toBeVisible()
  await expect(page.getByText('mock 回退')).toHaveCount(0)
})
