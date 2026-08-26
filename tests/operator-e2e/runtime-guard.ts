import { expect, test, type Page } from '@playwright/test'

const runtimeErrors = new WeakMap<Page, string[]>()

export const installRuntimeGuards = () => {
  test.beforeEach(({ page }) => {
    const errors: string[] = []
    runtimeErrors.set(page, errors)
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console.error: ${message.text()}`)
    })
  })

  test.afterEach(({ page }) => {
    expect(runtimeErrors.get(page) ?? [], 'unexpected browser runtime errors').toEqual([])
  })
}
