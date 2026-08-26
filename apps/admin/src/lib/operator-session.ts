import 'server-only'
import type { AdminAction } from '@helloreview/contracts'
import { readAdminConsoleEnvironment } from './env-source'
import { FIXTURE_CAMPAIGN_ID } from './fixture-identifiers'

export type OperatorConsoleSession = Readonly<{
  principalReference: string
  roleLabel: string
  assuranceLabel: string
  environmentLabel: string
  authorizedActions: readonly AdminAction[]
  campaignIds: readonly string[]
}>

/**
 * Provider-neutral session boundary. Production stays locked until T103's principal is supplied by
 * an approved SSO or local-MFA adapter. The fixture cannot be enabled in production.
 */
export const getOperatorConsoleSession = (): OperatorConsoleSession | null => {
  const environment = readAdminConsoleEnvironment()
  if (environment.sessionMode !== 'test_fixture') return null
  return {
    principalReference: 'operator:test-fixture:console',
    roleLabel: '테스트 운영자',
    assuranceLabel: '피싱 방지 인증 테스트',
    environmentLabel: '테스트 환경',
    authorizedActions: ['participants.search'],
    campaignIds: [FIXTURE_CAMPAIGN_ID],
  }
}

export const isOperatorConsoleAuthorized = (
  session: OperatorConsoleSession,
  action: AdminAction,
  campaignId: string,
): boolean => session.authorizedActions.includes(action) && session.campaignIds.includes(campaignId)
