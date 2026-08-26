import { defineConfig } from '@playwright/test'

const lane = process.env.OPERATOR_E2E_LANE ?? 'manual'

export default defineConfig({
  testDir: '../../tests/operator-e2e',
  outputDir: `../../test-results/operator-console-${lane}`,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: `../../playwright-report/operator-console-${lane}`, open: 'never' }]],
  timeout: 90_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: 'http://localhost:3001',
    browserName: 'chromium',
    channel: 'chrome',
    headless: true,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
})
