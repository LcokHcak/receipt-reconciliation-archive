import { expect, test } from '@playwright/test'

const baseUrl = process.env.E2E_BASE_URL || 'http://127.0.0.1:5177/app/dist'

test('E2 conflicts resolve removes the pending item', async ({ page }) => {
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
  await page.route('**/api/monthly/workspaces/demo-2026-05/pending-reviews/101/resolve', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, applied: ['resolved'], warnings: [] }),
  }))

  await page.goto(`${baseUrl}/monthly/v2/demo-2026-05/conflicts`)

  await expect(page.getByTestId('conflict-row')).toHaveCount(1)
  await page.getByTestId('field-use-daily').first().click()
  await page.getByTestId('apply-conflict-resolution').click()
  await expect(page.getByTestId('conflict-row')).toHaveCount(0)
})
