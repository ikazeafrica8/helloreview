import {
  PRIVACY_DATA_CLASSES,
  PrivacyRequestContractError,
  assertPseudonymousPrivacyReference,
  type PrivacyDataClass,
} from './privacy-request-contract.js'

export const PRIVACY_RETENTION_SCHEDULE_SCHEMA_VERSION = 'privacy-retention-schedule-v1' as const
export const PRIVACY_LEGAL_HOLD_SCOPE_SCHEMA_VERSION = 'privacy-legal-hold-scope-v1' as const
export const PRIVACY_RETENTION_SUBJECT_SCHEMA_VERSION = 'privacy-retention-subject-v1' as const

export const PRIVACY_RETENTION_DISPOSITIONS = ['delete', 'irreversible_mask'] as const
export type PrivacyRetentionDisposition = (typeof PRIVACY_RETENTION_DISPOSITIONS)[number]

export type PrivacyRetentionScheduleEntry = Readonly<{
  dataClass: PrivacyDataClass
  retentionDays: number
  disposition: PrivacyRetentionDisposition
}>

export type PrivacyRetentionSchedule = Readonly<{
  schemaVersion: typeof PRIVACY_RETENTION_SCHEDULE_SCHEMA_VERSION
  policyVersion: string
  supersedesPolicyVersion: string | null
  approved: true
  companyApprovalReference: string
  legalApprovalReference: string
  approvedAt: Date
  effectiveFrom: Date
  entries: readonly PrivacyRetentionScheduleEntry[]
}>

export type PrivacyLegalHoldScope =
  | Readonly<{
      schemaVersion: typeof PRIVACY_LEGAL_HOLD_SCOPE_SCHEMA_VERSION
      scope: 'participant'
      participantId: string
    }>
  | Readonly<{
      schemaVersion: typeof PRIVACY_LEGAL_HOLD_SCOPE_SCHEMA_VERSION
      scope: 'participant_data_class'
      participantId: string
      dataClass: PrivacyDataClass
    }>
  | Readonly<{
      schemaVersion: typeof PRIVACY_LEGAL_HOLD_SCOPE_SCHEMA_VERSION
      scope: 'record'
      participantId: string
      dataClass: PrivacyDataClass
      recordReference: string
    }>

export type PrivacyRetentionSubject = Readonly<{
  schemaVersion: typeof PRIVACY_RETENTION_SUBJECT_SCHEMA_VERSION
  participantId: string
  dataClass: PrivacyDataClass
  recordReference: string
  retentionAnchorAt: Date
}>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const POLICY_VERSION = /^[a-z][a-z0-9-]*-v[0-9]+$/
const MAX_RETENTION_DAYS = 36_500

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const exactKeys = (input: Record<string, unknown>, expected: readonly string[], reasonCode: string): void => {
  const actual = Object.keys(input).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
    throw new PrivacyRequestContractError(reasonCode)
}

const date = (value: unknown, reasonCode: string): Date => {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new PrivacyRequestContractError(reasonCode)
  return new Date(value)
}

const uuid = (value: unknown, reasonCode: string): string => {
  if (typeof value !== 'string' || !UUID.test(value)) throw new PrivacyRequestContractError(reasonCode)
  return value.toLowerCase()
}

const dataClass = (value: unknown, reasonCode: string): PrivacyDataClass => {
  const found = PRIVACY_DATA_CLASSES.find((candidate) => candidate === value)
  if (found === undefined) throw new PrivacyRequestContractError(reasonCode)
  return found
}

export const parsePrivacyRetentionSchedule = (value: unknown): PrivacyRetentionSchedule => {
  if (!isRecord(value)) throw new PrivacyRequestContractError('PRIVACY_RETENTION_SCHEDULE_INVALID')
  exactKeys(
    value,
    [
      'schemaVersion',
      'policyVersion',
      'supersedesPolicyVersion',
      'approved',
      'companyApprovalReference',
      'legalApprovalReference',
      'approvedAt',
      'effectiveFrom',
      'entries',
    ],
    'PRIVACY_RETENTION_SCHEDULE_UNKNOWN_FIELD',
  )
  if (value.schemaVersion !== PRIVACY_RETENTION_SCHEDULE_SCHEMA_VERSION)
    throw new PrivacyRequestContractError('PRIVACY_RETENTION_SCHEDULE_VERSION_UNSUPPORTED')
  if (typeof value.policyVersion !== 'string' || !POLICY_VERSION.test(value.policyVersion))
    throw new PrivacyRequestContractError('PRIVACY_RETENTION_POLICY_VERSION_INVALID')
  if (
    value.supersedesPolicyVersion !== null &&
    (typeof value.supersedesPolicyVersion !== 'string' || !POLICY_VERSION.test(value.supersedesPolicyVersion))
  )
    throw new PrivacyRequestContractError('PRIVACY_RETENTION_SUPERSEDES_VERSION_INVALID')
  if (value.approved !== true) throw new PrivacyRequestContractError('PRIVACY_RETENTION_POLICY_NOT_APPROVED')
  if (typeof value.companyApprovalReference !== 'string')
    throw new PrivacyRequestContractError('PRIVACY_RETENTION_COMPANY_APPROVAL_INVALID')
  if (typeof value.legalApprovalReference !== 'string')
    throw new PrivacyRequestContractError('PRIVACY_RETENTION_LEGAL_APPROVAL_INVALID')
  assertPseudonymousPrivacyReference(value.companyApprovalReference, 'PRIVACY_RETENTION_COMPANY_APPROVAL_INVALID')
  assertPseudonymousPrivacyReference(value.legalApprovalReference, 'PRIVACY_RETENTION_LEGAL_APPROVAL_INVALID')
  const approvedAt = date(value.approvedAt, 'PRIVACY_RETENTION_APPROVED_AT_INVALID')
  const effectiveFrom = date(value.effectiveFrom, 'PRIVACY_RETENTION_EFFECTIVE_FROM_INVALID')
  if (effectiveFrom.getTime() < approvedAt.getTime())
    throw new PrivacyRequestContractError('PRIVACY_RETENTION_EFFECTIVE_BEFORE_APPROVAL')
  if (!Array.isArray(value.entries) || value.entries.length !== PRIVACY_DATA_CLASSES.length)
    throw new PrivacyRequestContractError('PRIVACY_RETENTION_ENTRIES_INCOMPLETE')
  const entries = value.entries.map((candidate): PrivacyRetentionScheduleEntry => {
    if (!isRecord(candidate)) throw new PrivacyRequestContractError('PRIVACY_RETENTION_ENTRY_INVALID')
    exactKeys(candidate, ['dataClass', 'retentionDays', 'disposition'], 'PRIVACY_RETENTION_ENTRY_UNKNOWN_FIELD')
    const disposition = PRIVACY_RETENTION_DISPOSITIONS.find((allowed) => allowed === candidate.disposition)
    if (disposition === undefined) throw new PrivacyRequestContractError('PRIVACY_RETENTION_DISPOSITION_INVALID')
    if (
      typeof candidate.retentionDays !== 'number' ||
      !Number.isInteger(candidate.retentionDays) ||
      candidate.retentionDays < 1 ||
      candidate.retentionDays > MAX_RETENTION_DAYS
    )
      throw new PrivacyRequestContractError('PRIVACY_RETENTION_DAYS_INVALID')
    return {
      dataClass: dataClass(candidate.dataClass, 'PRIVACY_RETENTION_DATA_CLASS_INVALID'),
      retentionDays: candidate.retentionDays,
      disposition,
    }
  })
  if (new Set(entries.map((entry) => entry.dataClass)).size !== PRIVACY_DATA_CLASSES.length)
    throw new PrivacyRequestContractError('PRIVACY_RETENTION_ENTRIES_INCOMPLETE')
  const byDataClass = new Map(entries.map((entry) => [entry.dataClass, entry]))
  const canonicalEntries = PRIVACY_DATA_CLASSES.map((entryDataClass) => {
    const entry = byDataClass.get(entryDataClass)
    if (entry === undefined) throw new PrivacyRequestContractError('PRIVACY_RETENTION_ENTRIES_INCOMPLETE')
    return entry
  })
  return {
    schemaVersion: PRIVACY_RETENTION_SCHEDULE_SCHEMA_VERSION,
    policyVersion: value.policyVersion,
    supersedesPolicyVersion: value.supersedesPolicyVersion,
    approved: true,
    companyApprovalReference: value.companyApprovalReference,
    legalApprovalReference: value.legalApprovalReference,
    approvedAt,
    effectiveFrom,
    entries: canonicalEntries,
  }
}

export const parsePrivacyLegalHoldScope = (value: unknown): PrivacyLegalHoldScope => {
  if (!isRecord(value)) throw new PrivacyRequestContractError('PRIVACY_LEGAL_HOLD_SCOPE_INVALID')
  if (value.schemaVersion !== PRIVACY_LEGAL_HOLD_SCOPE_SCHEMA_VERSION)
    throw new PrivacyRequestContractError('PRIVACY_LEGAL_HOLD_SCOPE_VERSION_UNSUPPORTED')
  const participantId = uuid(value.participantId, 'PRIVACY_LEGAL_HOLD_PARTICIPANT_INVALID')
  if (value.scope === 'participant') {
    exactKeys(value, ['schemaVersion', 'scope', 'participantId'], 'PRIVACY_LEGAL_HOLD_SCOPE_UNKNOWN_FIELD')
    return { schemaVersion: PRIVACY_LEGAL_HOLD_SCOPE_SCHEMA_VERSION, scope: 'participant', participantId }
  }
  if (value.scope === 'participant_data_class') {
    exactKeys(value, ['schemaVersion', 'scope', 'participantId', 'dataClass'], 'PRIVACY_LEGAL_HOLD_SCOPE_UNKNOWN_FIELD')
    return {
      schemaVersion: PRIVACY_LEGAL_HOLD_SCOPE_SCHEMA_VERSION,
      scope: 'participant_data_class',
      participantId,
      dataClass: dataClass(value.dataClass, 'PRIVACY_LEGAL_HOLD_DATA_CLASS_INVALID'),
    }
  }
  if (value.scope === 'record') {
    exactKeys(
      value,
      ['schemaVersion', 'scope', 'participantId', 'dataClass', 'recordReference'],
      'PRIVACY_LEGAL_HOLD_SCOPE_UNKNOWN_FIELD',
    )
    if (typeof value.recordReference !== 'string')
      throw new PrivacyRequestContractError('PRIVACY_LEGAL_HOLD_RECORD_REFERENCE_INVALID')
    assertPseudonymousPrivacyReference(value.recordReference, 'PRIVACY_LEGAL_HOLD_RECORD_REFERENCE_INVALID')
    return {
      schemaVersion: PRIVACY_LEGAL_HOLD_SCOPE_SCHEMA_VERSION,
      scope: 'record',
      participantId,
      dataClass: dataClass(value.dataClass, 'PRIVACY_LEGAL_HOLD_DATA_CLASS_INVALID'),
      recordReference: value.recordReference,
    }
  }
  throw new PrivacyRequestContractError('PRIVACY_LEGAL_HOLD_SCOPE_INVALID')
}

export const parsePrivacyRetentionSubject = (value: unknown): PrivacyRetentionSubject => {
  if (!isRecord(value)) throw new PrivacyRequestContractError('PRIVACY_RETENTION_SUBJECT_INVALID')
  exactKeys(
    value,
    ['schemaVersion', 'participantId', 'dataClass', 'recordReference', 'retentionAnchorAt'],
    'PRIVACY_RETENTION_SUBJECT_UNKNOWN_FIELD',
  )
  if (value.schemaVersion !== PRIVACY_RETENTION_SUBJECT_SCHEMA_VERSION)
    throw new PrivacyRequestContractError('PRIVACY_RETENTION_SUBJECT_VERSION_UNSUPPORTED')
  if (typeof value.recordReference !== 'string')
    throw new PrivacyRequestContractError('PRIVACY_RETENTION_RECORD_REFERENCE_INVALID')
  assertPseudonymousPrivacyReference(value.recordReference, 'PRIVACY_RETENTION_RECORD_REFERENCE_INVALID')
  return {
    schemaVersion: PRIVACY_RETENTION_SUBJECT_SCHEMA_VERSION,
    participantId: uuid(value.participantId, 'PRIVACY_RETENTION_PARTICIPANT_INVALID'),
    dataClass: dataClass(value.dataClass, 'PRIVACY_RETENTION_DATA_CLASS_INVALID'),
    recordReference: value.recordReference,
    retentionAnchorAt: date(value.retentionAnchorAt, 'PRIVACY_RETENTION_ANCHOR_INVALID'),
  }
}
