import type { AdminAction } from '@helloreview/contracts'
import { FIXTURE_CAMPAIGN_ID } from './fixture-identifiers'

export type OperatorConsoleSession = Readonly<{
  principalReference: string
  roleLabel: string
  assuranceLabel: string
  environmentLabel: string
  authorizedActions: readonly AdminAction[]
  campaignIds: readonly string[]
}>

export const OPERATOR_CONSOLE_FIXTURE_READ_ACTIONS = [
  'operations.overview.read',
  'participants.search',
  'participants.timeline.read',
  'human_tasks.queue.read',
  'campaigns.read',
  'business_approvals.queue.read',
  'message_templates.read',
  'guidelines.read',
  'notifications.history.read',
  'deduplication.history.read',
  'failed_jobs.read',
  'integrations.health.read',
  'audit_logs.read',
  'privacy_requests.read',
  'users_roles.read',
  'automation_pauses.read',
  'ai_cost.read',
] as const satisfies readonly AdminAction[]

export const OPERATOR_CONSOLE_TEST_FIXTURE_SESSION: OperatorConsoleSession = {
  principalReference: 'operator:test-fixture:console',
  roleLabel: '테스트 운영자',
  assuranceLabel: '피싱 방지 인증 테스트',
  environmentLabel: '테스트 환경',
  authorizedActions: OPERATOR_CONSOLE_FIXTURE_READ_ACTIONS,
  campaignIds: [FIXTURE_CAMPAIGN_ID],
}

export const isOperatorConsoleAuthorized = (
  session: OperatorConsoleSession,
  action: AdminAction,
  campaignId: string,
): boolean => session.authorizedActions.includes(action) && session.campaignIds.includes(campaignId)
