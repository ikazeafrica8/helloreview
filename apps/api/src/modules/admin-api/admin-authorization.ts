import {
  ADMIN_ASSURANCE_LEVELS,
  ADMIN_ROLES,
  parseOperatorPrincipal,
  type AdminAssuranceLevel,
  type AdminEnvironment,
  type AdminRole,
  type OperatorPrincipal,
} from './operator-principal.js'
import { ADMIN_ACTIONS, type AdminAction } from '@helloreview/contracts'

export { ADMIN_ACTIONS }
export type { AdminAction }

export const ADMIN_AUTHORIZATION_POLICY_SCHEMA_VERSION = 'admin-authorization-policy-v1' as const
export const ADMIN_AUTHORIZATION_REQUEST_SCHEMA_VERSION = 'admin-authorization-request-v1' as const

export const ADMIN_SCOPE_REQUIREMENTS = ['campaign_required', 'global_required', 'unscoped'] as const
export type AdminScopeRequirement = (typeof ADMIN_SCOPE_REQUIREMENTS)[number]

export type AdminAuthorizationPolicyEntry = Readonly<{
  action: AdminAction
  allowedRoles: readonly AdminRole[]
  scopeRequirement: AdminScopeRequirement
  minimumAssurance: AdminAssuranceLevel
}>

export type AdminAuthorizationPolicy = Readonly<{
  schemaVersion: typeof ADMIN_AUTHORIZATION_POLICY_SCHEMA_VERSION
  policyVersion: string
  status: 'test_fixture' | 'approved'
  environment: AdminEnvironment
  companyApprovalReference: string | null
  securityApprovalReference: string | null
  entries: readonly AdminAuthorizationPolicyEntry[]
}>

export type AdminAuthorizationRequest = Readonly<{
  schemaVersion: typeof ADMIN_AUTHORIZATION_REQUEST_SCHEMA_VERSION
  requestReference: string
  correlationId: string
  action: AdminAction
  targetCampaignId: string | null
}>

export type AdminAuthorizationContext = Readonly<{
  environment: AdminEnvironment
  evaluatedAt: Date
  currentAuthorizationVersion: number
}>

export type AdminAuthorizationDecision = Readonly<{
  allowed: boolean
  reasonCode:
    | 'ADMIN_AUTHORIZED'
    | 'ADMIN_POLICY_NOT_APPROVED'
    | 'ADMIN_POLICY_ENVIRONMENT_MISMATCH'
    | 'ADMIN_POLICY_VERSION_STALE'
    | 'ADMIN_PRINCIPAL_ENVIRONMENT_MISMATCH'
    | 'ADMIN_PRINCIPAL_NOT_YET_VALID'
    | 'ADMIN_PRINCIPAL_EXPIRED'
    | 'ADMIN_AUTHORIZATION_VERSION_STALE'
    | 'ADMIN_ROLE_NOT_ALLOWED'
    | 'ADMIN_ASSURANCE_INSUFFICIENT'
    | 'ADMIN_GLOBAL_SCOPE_REQUIRED'
    | 'ADMIN_CAMPAIGN_SCOPE_REQUIRED'
    | 'ADMIN_CAMPAIGN_SCOPE_DENIED'
    | 'ADMIN_UNSCOPED_ACTION_HAS_CAMPAIGN'
  action: AdminAction
  policyVersion: string
  matchedRole: AdminRole | null
  principalReference: string
  sessionReference: string
  correlationId: string
  authorizationVersion: number
  evaluatedAt: Date
}>

export class AdminAuthorizationContractError extends Error {
  override readonly name = 'AdminAuthorizationContractError'
  constructor(readonly reasonCode: string) {
    super(`admin authorization contract rejected: ${reasonCode}`)
  }
}

export class AdminAuthorizationDeniedError extends Error {
  override readonly name = 'AdminAuthorizationDeniedError'
  constructor(readonly decision: AdminAuthorizationDecision) {
    super(`admin authorization denied: ${decision.reasonCode}`)
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const POLICY_VERSION = /^[a-z][a-z0-9-]*-v[0-9]+$/
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9:._/-]*$/
const RAW_KOREAN_MOBILE = /(?:\+?82|0)[\s-]*10(?:[\s-]*\d){8}/
const RAW_EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
const RAW_URL = /(?:https?:\/\/|^www\.)/i

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const exactKeys = (value: Record<string, unknown>, expected: readonly string[], reasonCode: string): void => {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
    throw new AdminAuthorizationContractError(reasonCode)
}

const member = <Values extends readonly string[]>(
  values: Values,
  value: unknown,
  reasonCode: string,
): Values[number] => {
  const found = values.find((candidate) => candidate === value)
  if (found === undefined) throw new AdminAuthorizationContractError(reasonCode)
  return found
}

const approvalReference = (value: unknown, reasonCode: string): string => {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 200 ||
    !REFERENCE.test(value) ||
    RAW_KOREAN_MOBILE.test(value) ||
    RAW_EMAIL.test(value) ||
    RAW_URL.test(value)
  )
    throw new AdminAuthorizationContractError(reasonCode)
  return value
}

export const parseAdminAuthorizationRequest = (value: unknown): AdminAuthorizationRequest => {
  if (!isRecord(value)) throw new AdminAuthorizationContractError('ADMIN_AUTHORIZATION_REQUEST_INVALID')
  exactKeys(
    value,
    ['schemaVersion', 'requestReference', 'correlationId', 'action', 'targetCampaignId'],
    'ADMIN_AUTHORIZATION_REQUEST_UNKNOWN_FIELD',
  )
  if (value.schemaVersion !== ADMIN_AUTHORIZATION_REQUEST_SCHEMA_VERSION)
    throw new AdminAuthorizationContractError('ADMIN_AUTHORIZATION_REQUEST_VERSION_UNSUPPORTED')
  if (
    value.targetCampaignId !== null &&
    (typeof value.targetCampaignId !== 'string' || !UUID.test(value.targetCampaignId))
  )
    throw new AdminAuthorizationContractError('ADMIN_AUTHORIZATION_CAMPAIGN_INVALID')
  return {
    schemaVersion: ADMIN_AUTHORIZATION_REQUEST_SCHEMA_VERSION,
    requestReference: approvalReference(value.requestReference, 'ADMIN_AUTHORIZATION_REQUEST_REFERENCE_INVALID'),
    correlationId: approvalReference(value.correlationId, 'ADMIN_AUTHORIZATION_CORRELATION_INVALID'),
    action: member(ADMIN_ACTIONS, value.action, 'ADMIN_AUTHORIZATION_ACTION_UNKNOWN'),
    targetCampaignId: value.targetCampaignId === null ? null : value.targetCampaignId.toLowerCase(),
  }
}

export const parseAdminAuthorizationPolicy = (value: unknown): AdminAuthorizationPolicy => {
  if (!isRecord(value)) throw new AdminAuthorizationContractError('ADMIN_AUTHORIZATION_POLICY_INVALID')
  exactKeys(
    value,
    [
      'schemaVersion',
      'policyVersion',
      'status',
      'environment',
      'companyApprovalReference',
      'securityApprovalReference',
      'entries',
    ],
    'ADMIN_AUTHORIZATION_POLICY_UNKNOWN_FIELD',
  )
  if (value.schemaVersion !== ADMIN_AUTHORIZATION_POLICY_SCHEMA_VERSION)
    throw new AdminAuthorizationContractError('ADMIN_AUTHORIZATION_POLICY_VERSION_UNSUPPORTED')
  if (typeof value.policyVersion !== 'string' || !POLICY_VERSION.test(value.policyVersion))
    throw new AdminAuthorizationContractError('ADMIN_AUTHORIZATION_POLICY_VERSION_INVALID')
  const status = member(
    ['test_fixture', 'approved'] as const,
    value.status,
    'ADMIN_AUTHORIZATION_POLICY_STATUS_INVALID',
  )
  const environment = member(
    ['test', 'production'] as const,
    value.environment,
    'ADMIN_AUTHORIZATION_POLICY_ENVIRONMENT_INVALID',
  )
  let companyApprovalReference: string | null = null
  let securityApprovalReference: string | null = null
  if (status === 'approved') {
    companyApprovalReference = approvalReference(
      value.companyApprovalReference,
      'ADMIN_AUTHORIZATION_COMPANY_APPROVAL_INVALID',
    )
    securityApprovalReference = approvalReference(
      value.securityApprovalReference,
      'ADMIN_AUTHORIZATION_SECURITY_APPROVAL_INVALID',
    )
  } else if (
    environment !== 'test' ||
    value.companyApprovalReference !== null ||
    value.securityApprovalReference !== null
  ) {
    throw new AdminAuthorizationContractError('ADMIN_AUTHORIZATION_TEST_FIXTURE_BOUNDARY_INVALID')
  }
  if (!Array.isArray(value.entries) || value.entries.length !== ADMIN_ACTIONS.length)
    throw new AdminAuthorizationContractError('ADMIN_AUTHORIZATION_POLICY_ENTRIES_INCOMPLETE')
  const entries = value.entries.map((candidate): AdminAuthorizationPolicyEntry => {
    if (!isRecord(candidate)) throw new AdminAuthorizationContractError('ADMIN_AUTHORIZATION_POLICY_ENTRY_INVALID')
    exactKeys(
      candidate,
      ['action', 'allowedRoles', 'scopeRequirement', 'minimumAssurance'],
      'ADMIN_AUTHORIZATION_POLICY_ENTRY_UNKNOWN_FIELD',
    )
    if (
      !Array.isArray(candidate.allowedRoles) ||
      candidate.allowedRoles.length < 1 ||
      candidate.allowedRoles.length > ADMIN_ROLES.length
    )
      throw new AdminAuthorizationContractError('ADMIN_AUTHORIZATION_POLICY_ROLES_INVALID')
    const allowedRoles = candidate.allowedRoles.map((role) =>
      member(ADMIN_ROLES, role, 'ADMIN_AUTHORIZATION_POLICY_ROLES_INVALID'),
    )
    if (new Set(allowedRoles).size !== allowedRoles.length)
      throw new AdminAuthorizationContractError('ADMIN_AUTHORIZATION_POLICY_ROLES_INVALID')
    return {
      action: member(ADMIN_ACTIONS, candidate.action, 'ADMIN_AUTHORIZATION_POLICY_ACTION_INVALID'),
      allowedRoles: ADMIN_ROLES.filter((role) => allowedRoles.includes(role)),
      scopeRequirement: member(
        ADMIN_SCOPE_REQUIREMENTS,
        candidate.scopeRequirement,
        'ADMIN_AUTHORIZATION_POLICY_SCOPE_INVALID',
      ),
      minimumAssurance: member(
        ADMIN_ASSURANCE_LEVELS,
        candidate.minimumAssurance,
        'ADMIN_AUTHORIZATION_POLICY_ASSURANCE_INVALID',
      ),
    }
  })
  if (new Set(entries.map((entry) => entry.action)).size !== ADMIN_ACTIONS.length)
    throw new AdminAuthorizationContractError('ADMIN_AUTHORIZATION_POLICY_ENTRIES_INCOMPLETE')
  const byAction = new Map(entries.map((entry) => [entry.action, entry]))
  return {
    schemaVersion: ADMIN_AUTHORIZATION_POLICY_SCHEMA_VERSION,
    policyVersion: value.policyVersion,
    status,
    environment,
    companyApprovalReference,
    securityApprovalReference,
    entries: ADMIN_ACTIONS.map((action) => {
      const entry = byAction.get(action)
      if (entry === undefined)
        throw new AdminAuthorizationContractError('ADMIN_AUTHORIZATION_POLICY_ENTRIES_INCOMPLETE')
      return entry
    }),
  }
}

const assuranceRank = (level: AdminAssuranceLevel): number => ADMIN_ASSURANCE_LEVELS.indexOf(level)

const denied = (
  request: AdminAuthorizationRequest,
  policy: AdminAuthorizationPolicy,
  principal: OperatorPrincipal,
  context: AdminAuthorizationContext,
  reasonCode: Exclude<AdminAuthorizationDecision['reasonCode'], 'ADMIN_AUTHORIZED'>,
  matchedRole: AdminRole | null = null,
): AdminAuthorizationDecision => ({
  allowed: false,
  reasonCode,
  action: request.action,
  policyVersion: policy.policyVersion,
  matchedRole,
  principalReference: principal.principalReference,
  sessionReference: principal.sessionReference,
  correlationId: request.correlationId,
  authorizationVersion: principal.authorizationVersion,
  evaluatedAt: new Date(context.evaluatedAt),
})

export const evaluateAdminAuthorization = (
  input: Readonly<{
    principal: unknown
    request: unknown
    policy: unknown
    context: unknown
  }>,
): AdminAuthorizationDecision => {
  const principal: OperatorPrincipal = parseOperatorPrincipal(input.principal)
  const request = parseAdminAuthorizationRequest(input.request)
  const policy = parseAdminAuthorizationPolicy(input.policy)
  if (!isRecord(input.context)) throw new AdminAuthorizationContractError('ADMIN_AUTHORIZATION_CONTEXT_INVALID')
  exactKeys(
    input.context,
    ['environment', 'evaluatedAt', 'currentAuthorizationVersion'],
    'ADMIN_AUTHORIZATION_CONTEXT_UNKNOWN_FIELD',
  )
  if (
    !(input.context.evaluatedAt instanceof Date) ||
    Number.isNaN(input.context.evaluatedAt.getTime()) ||
    typeof input.context.currentAuthorizationVersion !== 'number' ||
    !Number.isSafeInteger(input.context.currentAuthorizationVersion) ||
    input.context.currentAuthorizationVersion < 1
  )
    throw new AdminAuthorizationContractError('ADMIN_AUTHORIZATION_CONTEXT_INVALID')
  const context: AdminAuthorizationContext = {
    environment: member(
      ['test', 'production'] as const,
      input.context.environment,
      'ADMIN_AUTHORIZATION_CONTEXT_INVALID',
    ),
    evaluatedAt: new Date(input.context.evaluatedAt),
    currentAuthorizationVersion: input.context.currentAuthorizationVersion,
  }
  if (context.environment !== principal.environment)
    return denied(request, policy, principal, context, 'ADMIN_PRINCIPAL_ENVIRONMENT_MISMATCH')
  if (context.environment === 'production' && policy.status !== 'approved')
    return denied(request, policy, principal, context, 'ADMIN_POLICY_NOT_APPROVED')
  if (policy.environment !== context.environment)
    return denied(request, policy, principal, context, 'ADMIN_POLICY_ENVIRONMENT_MISMATCH')
  if (principal.authorizationPolicyVersion !== policy.policyVersion)
    return denied(request, policy, principal, context, 'ADMIN_POLICY_VERSION_STALE')
  if (principal.authorizationVersion !== context.currentAuthorizationVersion)
    return denied(request, policy, principal, context, 'ADMIN_AUTHORIZATION_VERSION_STALE')
  if (context.evaluatedAt.getTime() < principal.issuedAt.getTime())
    return denied(request, policy, principal, context, 'ADMIN_PRINCIPAL_NOT_YET_VALID')
  if (context.evaluatedAt.getTime() >= principal.expiresAt.getTime())
    return denied(request, policy, principal, context, 'ADMIN_PRINCIPAL_EXPIRED')
  const entry = policy.entries.find((candidate) => candidate.action === request.action)
  if (entry === undefined) throw new Error('complete authorization policy lost an action')
  const matchedRole = principal.roles.find((role) => entry.allowedRoles.includes(role)) ?? null
  if (matchedRole === null) return denied(request, policy, principal, context, 'ADMIN_ROLE_NOT_ALLOWED')
  if (assuranceRank(principal.assuranceLevel) < assuranceRank(entry.minimumAssurance))
    return denied(request, policy, principal, context, 'ADMIN_ASSURANCE_INSUFFICIENT', matchedRole)
  if (entry.scopeRequirement === 'global_required') {
    if (principal.campaignScope.kind !== 'global')
      return denied(request, policy, principal, context, 'ADMIN_GLOBAL_SCOPE_REQUIRED', matchedRole)
  } else if (entry.scopeRequirement === 'campaign_required') {
    if (request.targetCampaignId === null)
      return denied(request, policy, principal, context, 'ADMIN_CAMPAIGN_SCOPE_REQUIRED', matchedRole)
    if (
      principal.campaignScope.kind === 'campaigns' &&
      !principal.campaignScope.campaignIds.includes(request.targetCampaignId)
    )
      return denied(request, policy, principal, context, 'ADMIN_CAMPAIGN_SCOPE_DENIED', matchedRole)
  } else if (request.targetCampaignId !== null) {
    return denied(request, policy, principal, context, 'ADMIN_UNSCOPED_ACTION_HAS_CAMPAIGN', matchedRole)
  }
  return {
    allowed: true,
    reasonCode: 'ADMIN_AUTHORIZED',
    action: request.action,
    policyVersion: policy.policyVersion,
    matchedRole,
    principalReference: principal.principalReference,
    sessionReference: principal.sessionReference,
    correlationId: request.correlationId,
    authorizationVersion: principal.authorizationVersion,
    evaluatedAt: new Date(context.evaluatedAt),
  }
}

export const assertAdminAuthorized = (
  input: Parameters<typeof evaluateAdminAuthorization>[0],
): AdminAuthorizationDecision => {
  const decision = evaluateAdminAuthorization(input)
  if (!decision.allowed) throw new AdminAuthorizationDeniedError(decision)
  return decision
}
