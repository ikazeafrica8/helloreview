import { describe, expect, test } from 'vitest'
import {
  AdminConsoleEnvironmentError,
  parseAdminConsoleEnvironment,
} from '../../apps/admin/src/lib/admin-console-environment.ts'
import {
  OPERATOR_EXTENSION_ROUTES,
  OPERATOR_NAVIGATION,
  OPERATOR_ROUTES,
  PRD_REQUIRED_ROUTE_PATTERNS,
} from '../../apps/admin/src/lib/navigation.ts'

describe('T111 operator console foundations', () => {
  test('keeps the Korean-first sidebar inventory unique and keyboard-native', () => {
    expect(OPERATOR_NAVIGATION.map((section) => section.label)).toEqual(['운영', '캠페인', '거버넌스'])
    expect(OPERATOR_ROUTES).toHaveLength(20)
    expect(new Set(OPERATOR_ROUTES).size).toBe(20)
    expect(OPERATOR_ROUTES.every((route) => route.startsWith('/'))).toBe(true)
  })

  test('tracks the exact 20-page PRD inventory separately from governance extensions', () => {
    expect(PRD_REQUIRED_ROUTE_PATTERNS).toEqual([
      '/overview',
      '/participants',
      '/participants/[participantId]',
      '/human-review',
      '/campaigns',
      '/campaigns/[campaignId]',
      '/selection-rules',
      '/reservation-rules',
      '/business-approvals',
      '/message-templates',
      '/guidelines',
      '/notifications',
      '/deduplication',
      '/failed-jobs',
      '/integrations',
      '/audit',
      '/privacy',
      '/users-roles',
      '/automation-pauses',
      '/ai-cost',
    ])
    expect(new Set(PRD_REQUIRED_ROUTE_PATTERNS).size).toBe(20)
    expect(OPERATOR_EXTENSION_ROUTES).toEqual(['/sensitive-access', '/system'])
    expect(PRD_REQUIRED_ROUTE_PATTERNS).not.toContain('/sensitive-access')
    expect(PRD_REQUIRED_ROUTE_PATTERNS).not.toContain('/system')
  })

  test('defaults to a locked session and makes the fixture structurally impossible in production', () => {
    expect(parseAdminConsoleEnvironment({})).toEqual({ sessionMode: 'disabled', nodeEnvironment: 'development' })
    expect(() =>
      parseAdminConsoleEnvironment({ NODE_ENV: 'production', ADMIN_CONSOLE_SESSION_MODE: 'test_fixture' }),
    ).toThrowError(expect.objectContaining({ reasonCode: 'ADMIN_CONSOLE_TEST_SESSION_PRODUCTION_FORBIDDEN' }))
    expect(() => parseAdminConsoleEnvironment({ ADMIN_CONSOLE_SESSION_MODE: 'trusted' })).toThrow(
      AdminConsoleEnvironmentError,
    )
  })
})
