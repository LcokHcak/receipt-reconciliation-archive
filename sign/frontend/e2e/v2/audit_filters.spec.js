import { expect, test } from '@playwright/test'

const baseUrl = process.env.E2E_BASE_URL || 'http://127.0.0.1:5177/app/dist'

test('E6 audit filter dropdowns load distinct values from api', async ({ page }) => {
  await page.route('**/api/auth/me', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ user: { username: 'admin', role: 'admin' } }),
  }))
  await page.route('**/api/audit/distinct/users', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ values: ['admin', 'system'] }),
  }))
  await page.route('**/api/audit/distinct/actions', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ values: ['run_merge', 'update_ledger_fields'] }),
  }))
  await page.route('**/api/audit/distinct/workspaces', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ values: ['demo-2026-05'] }),
  }))
  await page.route('**/api/audit/distinct/resource-types', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ values: ['daily_receipt', 'stage_job'] }),
  }))
  await page.route('**/api/audit/logs?*', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      logs: [{
        id: 1,
        workspaceKey: 'demo-2026-05',
        userId: 'admin',
        action: 'run_merge',
        resourceType: 'stage_job',
        resourceId: '88',
        details: {},
        createdAt: '2026-05-23T14:22:00.000Z',
      }],
      total: 1,
    }),
  }))

  await page.goto(`${baseUrl}/audit/v2/logs`)

  await expect(page.getByTestId('audit-action-filter').locator('option')).toHaveCount(3)
  await expect(page.getByTestId('audit-user-filter').locator('option')).toHaveCount(3)
  await expect(page.getByTestId('audit-workspace-filter').locator('option')).toHaveCount(2)
  await expect(page.getByTestId('audit-resource-filter').locator('option')).toHaveCount(3)
})
