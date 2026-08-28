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

/**
 * The command actions the fixture console is allowed to SIMULATE, listed one by one rather than
 * derived from the screens, so adding a screen action cannot silently grant itself permission.
 *
 * Deliberately absent, and therefore denied by `isOperatorConsoleAuthorized`: `sensitive_values.reveal`,
 * `sensitive_data.export`, `overrides.approve`, `users_roles.manage`, `retention_schedules.publish`,
 * and `legal_holds.manage`. Those need the approved policies and the authenticated principal that
 * T151 introduces, and no fixture receipt may stand in for them.
 */
export const OPERATOR_CONSOLE_FIXTURE_COMMAND_ACTIONS = [
  'human_tasks.assign',
  'human_tasks.resume_automation',
  'business_approvals.record',
  'failed_jobs.retry',
  'campaigns.configure',
  'selection_rules.publish',
  'reservation_rules.publish',
  'message_templates.publish',
  'guidelines.publish',
  'automation_pauses.activate',
  'automation_pauses.resume',
] as const satisfies readonly AdminAction[]

export const OPERATOR_CONSOLE_TEST_FIXTURE_SESSION: OperatorConsoleSession = {
  principalReference: 'operator:test-fixture:console',
  roleLabel: '테스트 운영자',
  assuranceLabel: '피싱 방지 인증 테스트',
  environmentLabel: '테스트 환경',
  authorizedActions: [...OPERATOR_CONSOLE_FIXTURE_READ_ACTIONS, ...OPERATOR_CONSOLE_FIXTURE_COMMAND_ACTIONS],
  campaignIds: [FIXTURE_CAMPAIGN_ID],
}

export const isOperatorConsoleAuthorized = (
  session: OperatorConsoleSession,
  action: AdminAction,
  campaignId: string,
): boolean => session.authorizedActions.includes(action) && session.campaignIds.includes(campaignId)
