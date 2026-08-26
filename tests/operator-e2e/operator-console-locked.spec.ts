import { expect, test } from '@playwright/test'
import { canonicalPages } from './operator-console-routes.js'
import { installRuntimeGuards } from './runtime-guard.js'

installRuntimeGuards()

test('production build keeps representative console routes locked without fixture content', async ({ page }) => {
  const smokeRoutes = canonicalPages.filter(({ pattern }) =>
    ['/overview', '/participants/[participantId]', '/campaigns/[campaignId]', '/privacy'].includes(pattern),
  )
  for (const { route } of smokeRoutes) {
    const response = await page.goto(route)
    expect(response?.status(), route).toBe(200)
    await expect(page.getByRole('heading', { level: 1, name: '승인된 운영자 세션이 필요합니다' })).toBeVisible()
    await expect(page.getByText('프로덕션 변경 차단', { exact: true })).toHaveCount(0)
    await expect(page.getByText('***-****-0042')).toHaveCount(0)
    await expect(page.locator('[data-nextjs-dialog]')).toHaveCount(0)
  }
})
