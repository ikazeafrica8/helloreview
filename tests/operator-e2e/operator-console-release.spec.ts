import { AxeBuilder } from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { CAMPAIGN_ID, canonicalPages, PARTICIPANT_ID } from './operator-console-routes.js'
import { installRuntimeGuards } from './runtime-guard.js'

installRuntimeGuards()

const submitAction = async (page: Page, actionId: string, reason = '운영 근거 확인 완료') => {
  const card = page.locator(`[data-action-id="${actionId}"]`)
  await card.getByRole('button', { name: '작업 검토' }).click()
  const reasonField = card.getByLabel(/작업 사유/)
  if (await reasonField.count()) await reasonField.fill(reason)
  const confirmation = card.getByLabel(/확인을 위해/)
  if (await confirmation.count()) await confirmation.fill('실행 확인')
  await card.getByRole('button', { name: 'fixture 명령 검증' }).click()
  return card.getByRole('status')
}

test('T117 serves every canonical PRD page with the production boundary visible', async ({ page }) => {
  for (const { route, heading } of canonicalPages) {
    const response = await page.goto(route)
    expect(response?.status(), route).toBe(200)
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
    await expect(page.getByText('프로덕션 변경 차단', { exact: true })).toBeVisible()
    await expect(page.getByLabel('긴급 자동화 중지 상태')).toBeVisible()
    await expect(page.locator('[data-nextjs-dialog]')).toHaveCount(0)
  }
})

test('masked search keeps lifecycle status and blogger evidence separate, then scopes the timeline', async ({
  page,
}) => {
  await page.goto('/participants')
  await page.getByLabel('검색어').fill('블로거')
  await page.getByRole('button', { name: '마스킹 검색' }).click()
  await expect(page).toHaveURL('http://localhost:3001/participants')
  await expect(page.getByText('***-****-0042')).toBeVisible()
  await expect(page.getByText('신청 상태', { exact: true })).toBeVisible()
  await expect(page.getByText('블로거 등급', { exact: true })).toBeVisible()
  await expect(page.getByText('등급 2')).toBeVisible()
  await expect(page.getByText('사람 소유', { exact: true })).toBeVisible()
  await page.getByRole('link', { name: '전체 타임라인 보기' }).click()
  await expect(page).toHaveURL(new RegExp(`/participants/${PARTICIPANT_ID}\\?campaignId=${CAMPAIGN_ID}`))
  await expect(page.getByRole('heading', { level: 2, name: 'PRIVACY_REQUEST_RECEIVED' })).toBeVisible()
  await expect(page.getByText('AI/OCR 원문')).toBeVisible()
  await expect(page.getByText('ocr_ai · 제공', { exact: true })).toBeVisible()
  await page.getByRole('link', { name: '이전 이벤트 더 보기' }).click()
  await expect(page.getByRole('heading', { level: 2, name: 'AI_SAFE_FALLBACK_RECORDED' })).toBeVisible()
  expect(await page.locator('body').innerText()).not.toMatch(/01[016789]-?\d{3,4}-?\d{4}/)

  await page.goto(`/participants/${PARTICIPANT_ID}?campaignId=10000000-0000-4000-8000-000000000099`)
  await expect(page.getByRole('heading', { level: 1, name: '요청한 운영 범위에 대한 권한이 없습니다' })).toBeVisible()
  await expect(page.getByText('OPERATOR_CONSOLE_READ_DENIED')).toBeVisible()
  await expect(page.getByText('***-****-0042')).toHaveCount(0)

  await page.goto(`/participants/${PARTICIPANT_ID}?campaignId=${CAMPAIGN_ID}&cursor=not-issued`)
  await expect(page.getByRole('heading', { level: 2, name: '유효하지 않은 타임라인 커서입니다.' })).toBeVisible()
  await expect(page.getByText('ADMIN_CURSOR_INVALID')).toBeVisible()

  await page.goto(`/participants/${PARTICIPANT_ID}?campaignId=${CAMPAIGN_ID}&cursor=first&cursor=second`)
  await expect(page.getByRole('heading', { level: 2, name: '유효하지 않은 타임라인 커서입니다.' })).toBeVisible()
  await expect(page.getByText('ADMIN_CURSOR_INVALID')).toBeVisible()

  await page.goto('/participants')
  await page.getByLabel('검색어').fill('블로거')
  await page.getByRole('button', { name: '마스킹 검색' }).click()
  await page.getByRole('button', { name: '다음 결과' }).click()
  await expect(page.getByText('블로거 B**')).toBeVisible()
  await page.getByRole('link', { name: '전체 타임라인 보기' }).click()
  await expect(page.getByRole('heading', { level: 2, name: '블로거 B** · ***-****-1188' })).toBeVisible()

  await page.goto('/participants')
  await page.getByLabel('검색어').fill('블로거')
  await page.getByRole('button', { name: '마스킹 검색' }).click()
  await expect(page.getByRole('button', { name: '다음 결과' })).toBeVisible()
  await page.evaluate(`(() => {
    const form = document.querySelector('form[role="search"]')
    const button = document.querySelector('button[name="cursor"]')
    if (!(form instanceof HTMLFormElement) || !(button instanceof HTMLButtonElement))
      throw new Error('search pagination controls missing')
    const duplicate = document.createElement('input')
    duplicate.type = 'hidden'
    duplicate.name = 'cursor'
    duplicate.value = 'duplicate-cursor'
    form.append(duplicate)
    button.click()
  })()`)
  await expect(page.getByText('ADMIN_CURSOR_INVALID')).toBeVisible()
  await expect(page.getByText('블로거 B**')).toHaveCount(0)

  const repeatedQueryResponse = await page.goto('/participants?query=a&query=b')
  expect(repeatedQueryResponse?.status()).toBe(200)
  await expect(page.getByText('두 글자 이상의 검색어를 입력해 주세요.')).toBeVisible()
})

test('permitted, stale, preview, and policy-denied commands return explicit safe outcomes', async ({ page }) => {
  await page.goto('/failed-jobs')
  await expect(await submitAction(page, 'failed_jobs.retry')).toContainText('FIXTURE_COMMAND_ACCEPTED')
  await expect(await submitAction(page, 'failed_jobs.retry.stale')).toContainText('OPERATOR_EXPECTED_VERSION_STALE')

  await page.goto('/selection-rules')
  await expect(await submitAction(page, 'selection_rules.preview')).toContainText('FIXTURE_PREVIEW_READY')

  await page.goto('/sensitive-access')
  const revealCard = page.locator('[data-action-id="shipping_address.reveal"]')
  await expect(revealCard.getByText('정책 승인 전에는 대상 버전 정보를 표시하지 않습니다.')).toBeVisible()
  await expect(revealCard.getByText('sensitive_values.reveal')).toBeVisible()
  await expect(revealCard.getByText('v7')).toHaveCount(0)
  await expect(await submitAction(page, 'shipping_address.reveal')).toContainText(
    'SENSITIVE_ACCESS_POLICY_NOT_APPROVED',
  )
  await expect(page.getByText('실제 변경은 발생하지 않았습니다.')).toBeVisible()
})

test('T114 editors accept fixture payloads and return deterministic no-write previews', async ({ page }) => {
  await page.goto('/selection-rules')
  await expect(page.getByRole('heading', { level: 2, name: '선정 근거 규칙 초안' })).toBeVisible()
  await page.getByLabel('일반 일평균 방문자 최소값').fill('1200')
  await page.getByRole('button', { name: 'fixture 초안 검증' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'FIXTURE_EDITOR_PREVIEW_VALID' })).toContainText(
    '저장되거나 게시된 변경은 없습니다.',
  )
  await page.getByLabel('일반 일평균 방문자 최소값').fill('1300')
  await expect(page.getByRole('status').filter({ hasText: 'FIXTURE_EDITOR_PREVIEW_VALID' })).toHaveCount(0)

  await page.goto(`/campaigns/${CAMPAIGN_ID}`)
  await expect(page.getByLabel('요청 상태').locator('option')).toHaveText(['초안', '활성', '일시 중지', '종료'])
  await page.getByLabel('시작일').fill('2026-09-30')
  await page.getByLabel('종료일').fill('2026-09-30')
  await page.getByRole('button', { name: 'fixture 초안 검증' }).click()
  await expect(page.getByText('campaignPeriod:END_NOT_AFTER_START')).toBeVisible()
})

test('keyboard skip navigation and responsive navigation remain operable', async ({ page }) => {
  await page.goto('/overview')
  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: '본문으로 건너뛰기' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('#main-content')).toBeFocused()

  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload()
  const toggle = page.locator('.navigation-toggle')
  await expect(page.getByRole('link', { name: '개인정보 요청' })).not.toBeVisible()
  await expect(toggle).toHaveAccessibleName('운영 메뉴 열기')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  await expect(toggle).toHaveAccessibleName('운영 메뉴 닫기')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByRole('link', { name: '개인정보 요청' })).toBeVisible()
})

test('representative desktop and mobile pages have no WCAG A/AA axe violations', async ({ page }) => {
  for (const route of ['/overview', '/failed-jobs', `/participants/${PARTICIPANT_ID}?campaignId=${CAMPAIGN_ID}`]) {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto(route)
    const desktop = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
    expect(desktop.violations, `${route} desktop`).toEqual([])

    await page.setViewportSize({ width: 390, height: 844 })
    await page.reload()
    const mobile = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
    expect(mobile.violations, `${route} mobile`).toEqual([])
  }
})
