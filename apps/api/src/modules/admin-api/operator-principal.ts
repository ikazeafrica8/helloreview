export const OPERATOR_PRINCIPAL_SCHEMA_VERSION = 'operator-principal-v1' as const

export const ADMIN_ROLES = [
  'cs_operator',
  'senior_operator',
  'campaign_manager',
  'approval_coordinator',
  'privacy_reviewer',
  'system_administrator',
  'auditor',
  'support_engineer',
] as const
export type AdminRole = (typeof ADMIN_ROLES)[number]

export const ADMIN_ASSURANCE_LEVELS = ['single_factor', 'mfa', 'phishing_resistant'] as const
export type AdminAssuranceLevel = (typeof ADMIN_ASSURANCE_LEVELS)[number]
export type AdminEnvironment = 'test' | 'production'

export type OperatorCampaignScope =
  Readonly<{ kind: 'global' }> | Readonly<{ kind: 'campaigns'; campaignIds: readonly string[] }>

export type OperatorPrincipal = Readonly<{
  schemaVersion: typeof OPERATOR_PRINCIPAL_SCHEMA_VERSION
  principalReference: string
  verified: true
  roles: readonly AdminRole[]
  campaignScope: OperatorCampaignScope
  assuranceLevel: AdminAssuranceLevel
  sessionReference: string
  authenticationContextReference: string
  authorizationPolicyVersion: string
  authorizationVersion: number
  environment: AdminEnvironment
  issuedAt: Date
  expiresAt: Date
}>

export class OperatorPrincipalContractError extends Error {
  override readonly name = 'OperatorPrincipalContractError'
  constructor(readonly reasonCode: string) {
    super(`operator principal contract rejected: ${reasonCode}`)
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9:._/-]*$/
const POLICY_VERSION = /^[a-z][a-z0-9-]*-v[0-9]+$/
const RAW_KOREAN_MOBILE = /(?:\+?82|0)[\s-]*10(?:[\s-]*\d){8}/
const RAW_PHONE = /^\+?[\d\s().-]{8,}$/
const RAW_EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
const RAW_URL = /(?:https?:\/\/|^www\.)/i
const MAX_CAMPAIGN_SCOPES = 500

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const exactKeys = (value: Record<string, unknown>, expected: readonly string[], reasonCode: string): void => {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
    throw new OperatorPrincipalContractError(reasonCode)
}

const reference = (value: unknown, reasonCode: string): string => {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 200 ||
    !REFERENCE.test(value) ||
    RAW_KOREAN_MOBILE.test(value) ||
    RAW_PHONE.test(value) ||
    RAW_EMAIL.test(value) ||
    RAW_URL.test(value)
  )
    throw new OperatorPrincipalContractError(reasonCode)
  return value
}

const date = (value: unknown, reasonCode: string): Date => {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new OperatorPrincipalContractError(reasonCode)
  return new Date(value)
}

const member = <Values extends readonly string[]>(
  values: Values,
  value: unknown,
  reasonCode: string,
): Values[number] => {
  const found = values.find((candidate) => candidate === value)
  if (found === undefined) throw new OperatorPrincipalContractError(reasonCode)
  return found
}

const parseCampaignScope = (value: unknown): OperatorCampaignScope => {
  if (!isRecord(value)) throw new OperatorPrincipalContractError('ADMIN_PRINCIPAL_SCOPE_INVALID')
  if (value.kind === 'global') {
    exactKeys(value, ['kind'], 'ADMIN_PRINCIPAL_SCOPE_UNKNOWN_FIELD')
    return { kind: 'global' }
  }
  if (value.kind !== 'campaigns') throw new OperatorPrincipalContractError('ADMIN_PRINCIPAL_SCOPE_INVALID')
  exactKeys(value, ['kind', 'campaignIds'], 'ADMIN_PRINCIPAL_SCOPE_UNKNOWN_FIELD')
  if (
    !Array.isArray(value.campaignIds) ||
    value.campaignIds.length < 1 ||
    value.campaignIds.length > MAX_CAMPAIGN_SCOPES
  )
    throw new OperatorPrincipalContractError('ADMIN_PRINCIPAL_CAMPAIGN_SCOPE_INVALID')
  const campaignIds = value.campaignIds.map((candidate) => {
    if (typeof candidate !== 'string' || !UUID.test(candidate))
      throw new OperatorPrincipalContractError('ADMIN_PRINCIPAL_CAMPAIGN_SCOPE_INVALID')
    return candidate.toLowerCase()
  })
  if (new Set(campaignIds).size !== campaignIds.length)
    throw new OperatorPrincipalContractError('ADMIN_PRINCIPAL_CAMPAIGN_SCOPE_INVALID')
  return { kind: 'campaigns', campaignIds: [...campaignIds].sort() }
}

export const parseOperatorPrincipal = (value: unknown): OperatorPrincipal => {
  if (!isRecord(value)) throw new OperatorPrincipalContractError('ADMIN_PRINCIPAL_INVALID')
  exactKeys(
    value,
    [
      'schemaVersion',
      'principalReference',
      'verified',
      'roles',
      'campaignScope',
      'assuranceLevel',
      'sessionReference',
      'authenticationContextReference',
      'authorizationPolicyVersion',
      'authorizationVersion',
      'environment',
      'issuedAt',
      'expiresAt',
    ],
    'ADMIN_PRINCIPAL_UNKNOWN_FIELD',
  )
  if (value.schemaVersion !== OPERATOR_PRINCIPAL_SCHEMA_VERSION)
    throw new OperatorPrincipalContractError('ADMIN_PRINCIPAL_VERSION_UNSUPPORTED')
  if (value.verified !== true) throw new OperatorPrincipalContractError('ADMIN_PRINCIPAL_NOT_VERIFIED')
  if (!Array.isArray(value.roles) || value.roles.length < 1 || value.roles.length > ADMIN_ROLES.length)
    throw new OperatorPrincipalContractError('ADMIN_PRINCIPAL_ROLES_INVALID')
  const roles = value.roles.map((role) => member(ADMIN_ROLES, role, 'ADMIN_PRINCIPAL_ROLES_INVALID'))
  if (new Set(roles).size !== roles.length) throw new OperatorPrincipalContractError('ADMIN_PRINCIPAL_ROLES_INVALID')
  if (typeof value.authorizationPolicyVersion !== 'string' || !POLICY_VERSION.test(value.authorizationPolicyVersion))
    throw new OperatorPrincipalContractError('ADMIN_PRINCIPAL_POLICY_VERSION_INVALID')
  if (
    typeof value.authorizationVersion !== 'number' ||
    !Number.isSafeInteger(value.authorizationVersion) ||
    value.authorizationVersion < 1
  )
    throw new OperatorPrincipalContractError('ADMIN_PRINCIPAL_AUTHORIZATION_VERSION_INVALID')
  const issuedAt = date(value.issuedAt, 'ADMIN_PRINCIPAL_ISSUED_AT_INVALID')
  const expiresAt = date(value.expiresAt, 'ADMIN_PRINCIPAL_EXPIRES_AT_INVALID')
  if (expiresAt.getTime() <= issuedAt.getTime())
    throw new OperatorPrincipalContractError('ADMIN_PRINCIPAL_TIME_WINDOW_INVALID')
  return {
    schemaVersion: OPERATOR_PRINCIPAL_SCHEMA_VERSION,
    principalReference: reference(value.principalReference, 'ADMIN_PRINCIPAL_REFERENCE_INVALID'),
    verified: true,
    roles: ADMIN_ROLES.filter((role) => roles.includes(role)),
    campaignScope: parseCampaignScope(value.campaignScope),
    assuranceLevel: member(ADMIN_ASSURANCE_LEVELS, value.assuranceLevel, 'ADMIN_PRINCIPAL_ASSURANCE_INVALID'),
    sessionReference: reference(value.sessionReference, 'ADMIN_PRINCIPAL_SESSION_REFERENCE_INVALID'),
    authenticationContextReference: reference(
      value.authenticationContextReference,
      'ADMIN_PRINCIPAL_AUTH_CONTEXT_REFERENCE_INVALID',
    ),
    authorizationPolicyVersion: value.authorizationPolicyVersion,
    authorizationVersion: value.authorizationVersion,
    environment: member(['test', 'production'] as const, value.environment, 'ADMIN_PRINCIPAL_ENVIRONMENT_INVALID'),
    issuedAt,
    expiresAt,
  }
}
