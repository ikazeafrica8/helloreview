export const PRIVACY_REQUEST_SCOPE_VERSION = 'privacy-request-scope-v1' as const
export const PRIVACY_REQUEST_INTAKE_EVIDENCE_VERSION = 'privacy-request-intake-evidence-v1' as const

export const PRIVACY_REQUEST_TYPES = ['unspecified', 'access', 'correction', 'deletion', 'export'] as const
export type PrivacyRequestType = (typeof PRIVACY_REQUEST_TYPES)[number]

export const PRIVACY_DATA_CLASSES = [
  'application_sync',
  'conversation_content',
  'attachments',
  'shipping_addresses',
  'consent_records',
  'selection_decisions',
  'audit_logs',
  'delivery_records',
  'failed_integration_payloads',
  'ai_ocr_results',
  'privacy_requests',
] as const
export type PrivacyDataClass = (typeof PRIVACY_DATA_CLASSES)[number]

export type PrivacyRequestScopeState = 'unconfirmed' | 'declared'
export type PrivacyRequestScope = Readonly<{
  schemaVersion: typeof PRIVACY_REQUEST_SCOPE_VERSION
  state: PrivacyRequestScopeState
  subjectReference: string
  dataClasses: readonly PrivacyDataClass[]
  campaignReferences: readonly string[]
  workflowReferences: readonly string[]
}>

export type PrivacyRequestIntakeEvidence = Readonly<{
  schemaVersion: typeof PRIVACY_REQUEST_INTAKE_EVIDENCE_VERSION
  channel: 'kakao' | 'website' | 'email' | 'operator' | 'phone' | 'other'
  reference: string
}>

const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9:._/-]*$/
const RAW_KOREAN_MOBILE = /(?:\+?82|0)[\s-]*10(?:[\s-]*\d){8}/
const RAW_PHONE_LIKE = /^\+?[\d\s().-]{8,}$/
const RAW_EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
const RAW_URL = /(?:https?:\/\/|^www\.)/i
const CHANNELS = ['kakao', 'website', 'email', 'operator', 'phone', 'other'] as const
const MAX_SCOPE_REFERENCES = 50

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export class PrivacyRequestContractError extends Error {
  override readonly name = 'PrivacyRequestContractError'
  constructor(readonly reasonCode: string) {
    super(`privacy request contract rejected: ${reasonCode}`)
  }
}

export const assertPseudonymousPrivacyReference = (value: string, reasonCode: string): void => {
  if (
    value.length < 1 ||
    value.length > 200 ||
    !REFERENCE.test(value) ||
    RAW_KOREAN_MOBILE.test(value) ||
    RAW_PHONE_LIKE.test(value) ||
    RAW_EMAIL.test(value) ||
    RAW_URL.test(value)
  )
    throw new PrivacyRequestContractError(reasonCode)
}

const referenceList = (value: unknown, reasonCode: string): readonly string[] => {
  if (!Array.isArray(value) || value.length > MAX_SCOPE_REFERENCES) throw new PrivacyRequestContractError(reasonCode)
  const references = value.map((candidate) => {
    if (typeof candidate !== 'string') throw new PrivacyRequestContractError(reasonCode)
    assertPseudonymousPrivacyReference(candidate, reasonCode)
    return candidate
  })
  if (new Set(references).size !== references.length) throw new PrivacyRequestContractError(reasonCode)
  return [...references].sort()
}

export const parsePrivacyRequestScope = (value: unknown): PrivacyRequestScope => {
  if (!isRecord(value)) throw new PrivacyRequestContractError('PRIVACY_REQUEST_SCOPE_INVALID')
  const input = value
  const keys = Object.keys(input).sort()
  const expected = [
    'campaignReferences',
    'dataClasses',
    'schemaVersion',
    'state',
    'subjectReference',
    'workflowReferences',
  ]
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]))
    throw new PrivacyRequestContractError('PRIVACY_REQUEST_SCOPE_UNKNOWN_FIELD')
  if (input.schemaVersion !== PRIVACY_REQUEST_SCOPE_VERSION)
    throw new PrivacyRequestContractError('PRIVACY_REQUEST_SCOPE_VERSION_UNSUPPORTED')
  if (input.state !== 'unconfirmed' && input.state !== 'declared')
    throw new PrivacyRequestContractError('PRIVACY_REQUEST_SCOPE_STATE_INVALID')
  if (typeof input.subjectReference !== 'string')
    throw new PrivacyRequestContractError('PRIVACY_REQUEST_SUBJECT_REFERENCE_INVALID')
  assertPseudonymousPrivacyReference(input.subjectReference, 'PRIVACY_REQUEST_SUBJECT_REFERENCE_INVALID')
  if (!Array.isArray(input.dataClasses) || input.dataClasses.length > PRIVACY_DATA_CLASSES.length)
    throw new PrivacyRequestContractError('PRIVACY_REQUEST_DATA_CLASSES_INVALID')
  const dataClasses = input.dataClasses.map((candidate) => {
    const dataClass = PRIVACY_DATA_CLASSES.find((allowed) => allowed === candidate)
    if (dataClass === undefined) throw new PrivacyRequestContractError('PRIVACY_REQUEST_DATA_CLASSES_INVALID')
    return dataClass
  })
  if (new Set(dataClasses).size !== dataClasses.length)
    throw new PrivacyRequestContractError('PRIVACY_REQUEST_DATA_CLASSES_INVALID')
  const campaignReferences = referenceList(input.campaignReferences, 'PRIVACY_REQUEST_CAMPAIGN_REFERENCES_INVALID')
  const workflowReferences = referenceList(input.workflowReferences, 'PRIVACY_REQUEST_WORKFLOW_REFERENCES_INVALID')
  if (
    input.state === 'unconfirmed' &&
    (dataClasses.length > 0 || campaignReferences.length > 0 || workflowReferences.length > 0)
  )
    throw new PrivacyRequestContractError('PRIVACY_REQUEST_UNCONFIRMED_SCOPE_MUST_BE_EMPTY')
  if (
    input.state === 'declared' &&
    dataClasses.length === 0 &&
    campaignReferences.length === 0 &&
    workflowReferences.length === 0
  )
    throw new PrivacyRequestContractError('PRIVACY_REQUEST_DECLARED_SCOPE_REQUIRED')
  return {
    schemaVersion: PRIVACY_REQUEST_SCOPE_VERSION,
    state: input.state,
    subjectReference: input.subjectReference,
    dataClasses: [...dataClasses].sort(),
    campaignReferences,
    workflowReferences,
  }
}

export const parsePrivacyRequestIntakeEvidence = (value: unknown): PrivacyRequestIntakeEvidence => {
  if (!isRecord(value)) throw new PrivacyRequestContractError('PRIVACY_REQUEST_EVIDENCE_INVALID')
  const input = value
  const keys = Object.keys(input).sort()
  const expected = ['channel', 'reference', 'schemaVersion']
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]))
    throw new PrivacyRequestContractError('PRIVACY_REQUEST_EVIDENCE_UNKNOWN_FIELD')
  if (input.schemaVersion !== PRIVACY_REQUEST_INTAKE_EVIDENCE_VERSION)
    throw new PrivacyRequestContractError('PRIVACY_REQUEST_EVIDENCE_VERSION_UNSUPPORTED')
  const channel = CHANNELS.find((allowed) => allowed === input.channel)
  if (channel === undefined) throw new PrivacyRequestContractError('PRIVACY_REQUEST_EVIDENCE_CHANNEL_INVALID')
  if (typeof input.reference !== 'string')
    throw new PrivacyRequestContractError('PRIVACY_REQUEST_EVIDENCE_REFERENCE_INVALID')
  assertPseudonymousPrivacyReference(input.reference, 'PRIVACY_REQUEST_EVIDENCE_REFERENCE_INVALID')
  return {
    schemaVersion: PRIVACY_REQUEST_INTAKE_EVIDENCE_VERSION,
    channel,
    reference: input.reference,
  }
}
