import { PrivacyRequestContractError, assertPseudonymousPrivacyReference } from './privacy-request-contract.js'

export const PRIVACY_IDENTITY_VERIFICATION_POLICY_SCHEMA_VERSION = 'privacy-identity-verification-policy-v1' as const
export const PRIVACY_IDENTITY_VERIFICATION_EVIDENCE_SCHEMA_VERSION =
  'privacy-identity-verification-evidence-v1' as const

export type PrivacyIdentityVerificationPolicy = Readonly<{
  schemaVersion: typeof PRIVACY_IDENTITY_VERIFICATION_POLICY_SCHEMA_VERSION
  policyVersion: string
  approved: true
  approvedByReference: string
  approvedAt: Date
  method: 'verified_channel_identity'
}>

export type PrivacyIdentityVerificationEvidence = Readonly<{
  schemaVersion: typeof PRIVACY_IDENTITY_VERIFICATION_EVIDENCE_SCHEMA_VERSION
  method: 'verified_channel_identity'
  channelIdentityId: string
  reference: string
}>

export type PrivacyAffectedProcessingScope =
  | Readonly<{ scope: 'participant'; participantId: string }>
  | Readonly<{ scope: 'participant_campaign'; participantId: string; campaignId: string }>
  | Readonly<{ scope: 'workflow'; workflowId: string }>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const POLICY_VERSION = /^[a-z][a-z0-9-]*-v[0-9]+$/
const MAX_AFFECTED_SCOPES = 50

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const exactKeys = (input: Record<string, unknown>, expected: readonly string[], reasonCode: string): void => {
  const actual = Object.keys(input).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
    throw new PrivacyRequestContractError(reasonCode)
}

const uuid = (value: unknown, reasonCode: string): string => {
  if (typeof value !== 'string' || !UUID.test(value)) throw new PrivacyRequestContractError(reasonCode)
  return value.toLowerCase()
}

export const parsePrivacyIdentityVerificationPolicy = (value: unknown): PrivacyIdentityVerificationPolicy => {
  if (!isRecord(value)) throw new PrivacyRequestContractError('PRIVACY_IDENTITY_POLICY_INVALID')
  exactKeys(
    value,
    ['schemaVersion', 'policyVersion', 'approved', 'approvedByReference', 'approvedAt', 'method'],
    'PRIVACY_IDENTITY_POLICY_UNKNOWN_FIELD',
  )
  if (value.schemaVersion !== PRIVACY_IDENTITY_VERIFICATION_POLICY_SCHEMA_VERSION)
    throw new PrivacyRequestContractError('PRIVACY_IDENTITY_POLICY_SCHEMA_VERSION_UNSUPPORTED')
  if (typeof value.policyVersion !== 'string' || !POLICY_VERSION.test(value.policyVersion))
    throw new PrivacyRequestContractError('PRIVACY_IDENTITY_POLICY_VERSION_INVALID')
  if (value.approved !== true) throw new PrivacyRequestContractError('PRIVACY_IDENTITY_POLICY_NOT_APPROVED')
  if (typeof value.approvedByReference !== 'string')
    throw new PrivacyRequestContractError('PRIVACY_IDENTITY_POLICY_APPROVER_INVALID')
  assertPseudonymousPrivacyReference(value.approvedByReference, 'PRIVACY_IDENTITY_POLICY_APPROVER_INVALID')
  if (!(value.approvedAt instanceof Date) || Number.isNaN(value.approvedAt.getTime()))
    throw new PrivacyRequestContractError('PRIVACY_IDENTITY_POLICY_APPROVED_AT_INVALID')
  if (value.method !== 'verified_channel_identity')
    throw new PrivacyRequestContractError('PRIVACY_IDENTITY_POLICY_METHOD_UNSUPPORTED')
  return {
    schemaVersion: PRIVACY_IDENTITY_VERIFICATION_POLICY_SCHEMA_VERSION,
    policyVersion: value.policyVersion,
    approved: true,
    approvedByReference: value.approvedByReference,
    approvedAt: new Date(value.approvedAt),
    method: 'verified_channel_identity',
  }
}

export const parsePrivacyIdentityVerificationEvidence = (value: unknown): PrivacyIdentityVerificationEvidence => {
  if (!isRecord(value)) throw new PrivacyRequestContractError('PRIVACY_IDENTITY_EVIDENCE_INVALID')
  exactKeys(
    value,
    ['schemaVersion', 'method', 'channelIdentityId', 'reference'],
    'PRIVACY_IDENTITY_EVIDENCE_UNKNOWN_FIELD',
  )
  if (value.schemaVersion !== PRIVACY_IDENTITY_VERIFICATION_EVIDENCE_SCHEMA_VERSION)
    throw new PrivacyRequestContractError('PRIVACY_IDENTITY_EVIDENCE_SCHEMA_VERSION_UNSUPPORTED')
  if (value.method !== 'verified_channel_identity')
    throw new PrivacyRequestContractError('PRIVACY_IDENTITY_EVIDENCE_METHOD_UNSUPPORTED')
  if (typeof value.reference !== 'string')
    throw new PrivacyRequestContractError('PRIVACY_IDENTITY_EVIDENCE_REFERENCE_INVALID')
  assertPseudonymousPrivacyReference(value.reference, 'PRIVACY_IDENTITY_EVIDENCE_REFERENCE_INVALID')
  return {
    schemaVersion: PRIVACY_IDENTITY_VERIFICATION_EVIDENCE_SCHEMA_VERSION,
    method: 'verified_channel_identity',
    channelIdentityId: uuid(value.channelIdentityId, 'PRIVACY_IDENTITY_EVIDENCE_ID_INVALID'),
    reference: value.reference,
  }
}

export const parsePrivacyAffectedProcessingScopes = (value: unknown): readonly PrivacyAffectedProcessingScope[] => {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_AFFECTED_SCOPES)
    throw new PrivacyRequestContractError('PRIVACY_REQUEST_AFFECTED_SCOPE_INVALID')
  const scopes = value.map((candidate): PrivacyAffectedProcessingScope => {
    if (!isRecord(candidate)) throw new PrivacyRequestContractError('PRIVACY_REQUEST_AFFECTED_SCOPE_INVALID')
    if (candidate.scope === 'participant') {
      exactKeys(candidate, ['scope', 'participantId'], 'PRIVACY_REQUEST_AFFECTED_SCOPE_INVALID')
      return {
        scope: 'participant',
        participantId: uuid(candidate.participantId, 'PRIVACY_REQUEST_AFFECTED_SCOPE_INVALID'),
      }
    }
    if (candidate.scope === 'participant_campaign') {
      exactKeys(candidate, ['scope', 'participantId', 'campaignId'], 'PRIVACY_REQUEST_AFFECTED_SCOPE_INVALID')
      return {
        scope: 'participant_campaign',
        participantId: uuid(candidate.participantId, 'PRIVACY_REQUEST_AFFECTED_SCOPE_INVALID'),
        campaignId: uuid(candidate.campaignId, 'PRIVACY_REQUEST_AFFECTED_SCOPE_INVALID'),
      }
    }
    if (candidate.scope === 'workflow') {
      exactKeys(candidate, ['scope', 'workflowId'], 'PRIVACY_REQUEST_AFFECTED_SCOPE_INVALID')
      return {
        scope: 'workflow',
        workflowId: uuid(candidate.workflowId, 'PRIVACY_REQUEST_AFFECTED_SCOPE_INVALID'),
      }
    }
    throw new PrivacyRequestContractError('PRIVACY_REQUEST_AFFECTED_SCOPE_INVALID')
  })
  const canonical = scopes
    .map((scope) => ({ scope, key: JSON.stringify(scope) }))
    .sort((left, right) => left.key.localeCompare(right.key))
  if (new Set(canonical.map(({ key }) => key)).size !== canonical.length)
    throw new PrivacyRequestContractError('PRIVACY_REQUEST_AFFECTED_SCOPE_INVALID')
  return canonical.map(({ scope }) => scope)
}
