import { expect, test } from '@playwright/test'

const baseUrl = process.env.E2E_BASE_URL || 'http://127.0.0.1:5177/app/dist'

test('E1 monthly overview renders the control-center shell and core workbench links', async ({ page }) => {
  await page.route('**/api/auth/me', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ user: { username: 'admin', role: 'admin' } }),
  }))
  await page.route('**/api/monthly/workspaces?mode=all', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ workspaces: [{ workspaceKey: 'demo-2026-05', isTestMode: true }] }),
  }))
  await page.route('**/api/monthly/workspaces/demo-2026-05/overview', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      workspace: { workspaceKey: 'demo-2026-05', status: 'open' },
      isTestMode: true,
      counts: {
        dailyReceipts: 42,
        dailyByMatchStatus: [{ status: 'pending', n: 7 }],
        ledgerByStatus: [{ status: 'in_review', n: 12 }, { status: 'posted', n: 5 }],
        billMatchByStatus: [{ status: 'matched', n: 21 }],
        pendingByReason: [{ reason: 'field_conflict', n: 3 }],
        errorsByType: [],
        stageJobsRecent: [{ id: 1, stage: 'bill_match', status: 'succeeded', startedAt: '2026-05-23T09:00:00Z' }],
      },
    }),
  }))

  await page.goto(`${baseUrl}/monthly/v2/demo-2026-05`)

  await expect(page.getByTestId('monthly-header')).toBeVisible()
  await expect(page.locator('a[href$="/monthly/v2/demo-2026-05/ledger"]').first()).toBeVisible()
  await expect(page.locator('a[href$="/monthly/v2/demo-2026-05/bill-match"]').first()).toBeVisible()
  await expect(page.locator('a[href$="/monthly/v2/demo-2026-05/bill-review"]').first()).toBeVisible()
  await expect(page.locator('a[href$="/monthly/v2/demo-2026-05/unreceived"]').first()).toBeVisible()
  await expect(page.getByText('mock 回退')).toHaveCount(0)
})
