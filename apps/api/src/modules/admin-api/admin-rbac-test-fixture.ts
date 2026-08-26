import {
  ADMIN_ACTIONS,
  ADMIN_AUTHORIZATION_POLICY_SCHEMA_VERSION,
  type AdminAction,
  type AdminAuthorizationPolicy,
  type AdminAuthorizationPolicyEntry,
  type AdminScopeRequirement,
} from './admin-authorization.js'
import type { AdminAssuranceLevel, AdminRole } from './operator-principal.js'

type Rule = Readonly<{
  actions: readonly AdminAction[]
  roles: readonly AdminRole[]
  scope: AdminScopeRequirement
  assurance: AdminAssuranceLevel
}>

const rules: readonly Rule[] = [
  {
    actions: [
      'operations.overview.read',
      'participants.search',
      'participants.timeline.read',
      'human_tasks.queue.read',
      'human_tasks.assign',
      'human_tasks.resolve',
      'human_tasks.resume_automation',
      'notifications.history.read',
      'deduplication.history.read',
    ],
    roles: ['cs_operator', 'senior_operator'],
    scope: 'campaign_required',
    assurance: 'single_factor',
  },
  {
    actions: ['overrides.approve'],
    roles: ['senior_operator'],
    scope: 'campaign_required',
    assurance: 'mfa',
  },
  {
    actions: [
      'campaigns.read',
      'campaigns.configure',
      'selection_rules.publish',
      'reservation_rules.publish',
      'message_templates.read',
      'message_templates.publish',
      'guidelines.read',
      'guidelines.publish',
    ],
    roles: ['campaign_manager'],
    scope: 'campaign_required',
    assurance: 'mfa',
  },
  {
    actions: ['business_approvals.queue.read', 'business_approvals.record'],
    roles: ['approval_coordinator'],
    scope: 'campaign_required',
    assurance: 'mfa',
  },
  {
    actions: ['privacy_requests.read', 'retention_schedules.publish', 'legal_holds.manage'],
    roles: ['privacy_reviewer'],
    scope: 'global_required',
    assurance: 'mfa',
  },
  {
    actions: [
      'failed_jobs.retry',
      'users_roles.read',
      'users_roles.manage',
      'automation_pauses.read',
      'automation_pauses.activate',
      'automation_pauses.resume',
      'ai_cost.read',
    ],
    roles: ['system_administrator'],
    scope: 'global_required',
    assurance: 'mfa',
  },
  {
    actions: ['failed_jobs.read', 'integrations.health.read'],
    roles: ['system_administrator', 'support_engineer'],
    scope: 'global_required',
    assurance: 'mfa',
  },
  {
    actions: ['audit_logs.read'],
    roles: ['auditor'],
    scope: 'global_required',
    assurance: 'mfa',
  },
  {
    actions: ['sensitive_values.reveal'],
    roles: ['privacy_reviewer'],
    scope: 'global_required',
    assurance: 'phishing_resistant',
  },
  {
    actions: ['sensitive_data.export'],
    roles: ['privacy_reviewer'],
    scope: 'global_required',
    assurance: 'phishing_resistant',
  },
]

const entries: readonly AdminAuthorizationPolicyEntry[] = ADMIN_ACTIONS.map((action) => {
  const rule = rules.find((candidate) => candidate.actions.includes(action))
  if (rule === undefined) throw new Error(`admin RBAC test fixture is missing ${action}`)
  return {
    action,
    allowedRoles: rule.roles,
    scopeRequirement: rule.scope,
    minimumAssurance: rule.assurance,
  }
})

/** Deterministic tests only. The parser refuses this fixture in production. */
export const ADMIN_RBAC_TEST_FIXTURE_POLICY: AdminAuthorizationPolicy = {
  schemaVersion: ADMIN_AUTHORIZATION_POLICY_SCHEMA_VERSION,
  policyVersion: 'admin-rbac-test-fixture-v1',
  status: 'test_fixture',
  environment: 'test',
  companyApprovalReference: null,
  securityApprovalReference: null,
  entries,
}
