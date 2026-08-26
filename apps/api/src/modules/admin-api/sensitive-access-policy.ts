import type { AdminEnvironment } from './operator-principal.js'

export const SENSITIVE_ACCESS_POLICY_SCHEMA_VERSION = 'sensitive-access-policy-v1' as const
export const SENSITIVE_ACCESS_OPERATIONS = ['shipping_address.reveal', 'participant_data.export'] as const
export type SensitiveAccessOperation = (typeof SENSITIVE_ACCESS_OPERATIONS)[number]

export type SensitiveAccessPolicyEntry = Readonly<{
  operation: SensitiveAccessOperation
  allowedReasonCodes: readonly string[]
  maximumRecords: number
}>

export type SensitiveAccessPolicy = Readonly<{
  schemaVersion: typeof SENSITIVE_ACCESS_POLICY_SCHEMA_VERSION
  policyVersion: string
  status: 'test_fixture' | 'approved'
  environment: AdminEnvironment
  companyApprovalReference: string | null
  securityApprovalReference: string | null
  entries: readonly SensitiveAccessPolicyEntry[]
}>

export class SensitiveAccessPolicyError extends Error {
  override readonly name = 'SensitiveAccessPolicyError'
  constructor(readonly reasonCode: string) {
    super(`sensitive access policy rejected: ${reasonCode}`)
  }
}

const POLICY_VERSION = /^[a-z][a-z0-9-]*-v[0-9]+$/
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9:._/-]*$/
const REASON_CODE = /^[A-Z][A-Z0-9_]*$/
const RAW_KOREAN_MOBILE = /(?:\+?82|0)[\s-]*10(?:[\s-]*\d){8}/
const RAW_EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
const RAW_URL = /(?:https?:\/\/|^www\.)/i
const MAX_EXPORT_RECORDS = 10_000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isReasonCodeList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((reason: unknown) => typeof reason === 'string' && REASON_CODE.test(reason))

const exactKeys = (value: Record<string, unknown>, expected: readonly string[], reasonCode: string): void => {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
    throw new SensitiveAccessPolicyError(reasonCode)
}

const reference = (value: unknown, reasonCode: string): string => {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 200 ||
    !REFERENCE.test(value) ||
    RAW_KOREAN_MOBILE.test(value) ||
    RAW_EMAIL.test(value) ||
    RAW_URL.test(value)
  )
    throw new SensitiveAccessPolicyError(reasonCode)
  return value
}

const member = <Values extends readonly string[]>(
  values: Values,
  value: unknown,
  reasonCode: string,
): Values[number] => {
  const found = values.find((candidate) => candidate === value)
  if (found === undefined) throw new SensitiveAccessPolicyError(reasonCode)
  return found
}

export const parseSensitiveAccessPolicy = (value: unknown): SensitiveAccessPolicy => {
  if (!isRecord(value)) throw new SensitiveAccessPolicyError('SENSITIVE_ACCESS_POLICY_INVALID')
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
    'SENSITIVE_ACCESS_POLICY_UNKNOWN_FIELD',
  )
  if (value.schemaVersion !== SENSITIVE_ACCESS_POLICY_SCHEMA_VERSION)
    throw new SensitiveAccessPolicyError('SENSITIVE_ACCESS_POLICY_VERSION_UNSUPPORTED')
  if (typeof value.policyVersion !== 'string' || !POLICY_VERSION.test(value.policyVersion))
    throw new SensitiveAccessPolicyError('SENSITIVE_ACCESS_POLICY_VERSION_INVALID')
  const status = member(['test_fixture', 'approved'] as const, value.status, 'SENSITIVE_ACCESS_POLICY_STATUS_INVALID')
  const environment = member(
    ['test', 'production'] as const,
    value.environment,
    'SENSITIVE_ACCESS_POLICY_ENVIRONMENT_INVALID',
  )
  let companyApprovalReference: string | null = null
  let securityApprovalReference: string | null = null
  if (status === 'approved') {
    companyApprovalReference = reference(value.companyApprovalReference, 'SENSITIVE_ACCESS_COMPANY_APPROVAL_INVALID')
    securityApprovalReference = reference(value.securityApprovalReference, 'SENSITIVE_ACCESS_SECURITY_APPROVAL_INVALID')
  } else if (
    environment !== 'test' ||
    value.companyApprovalReference !== null ||
    value.securityApprovalReference !== null
  ) {
    throw new SensitiveAccessPolicyError('SENSITIVE_ACCESS_TEST_FIXTURE_BOUNDARY_INVALID')
  }
  if (!Array.isArray(value.entries) || value.entries.length !== SENSITIVE_ACCESS_OPERATIONS.length)
    throw new SensitiveAccessPolicyError('SENSITIVE_ACCESS_POLICY_ENTRIES_INCOMPLETE')
  const entries = value.entries.map((candidate): SensitiveAccessPolicyEntry => {
    if (!isRecord(candidate)) throw new SensitiveAccessPolicyError('SENSITIVE_ACCESS_POLICY_ENTRY_INVALID')
    exactKeys(
      candidate,
      ['operation', 'allowedReasonCodes', 'maximumRecords'],
      'SENSITIVE_ACCESS_POLICY_ENTRY_UNKNOWN_FIELD',
    )
    const operation = member(
      SENSITIVE_ACCESS_OPERATIONS,
      candidate.operation,
      'SENSITIVE_ACCESS_POLICY_OPERATION_INVALID',
    )
    if (
      !isReasonCodeList(candidate.allowedReasonCodes) ||
      candidate.allowedReasonCodes.length < 1 ||
      candidate.allowedReasonCodes.length > 50
    )
      throw new SensitiveAccessPolicyError('SENSITIVE_ACCESS_POLICY_REASONS_INVALID')
    const allowedReasonCodes = candidate.allowedReasonCodes
    if (new Set(allowedReasonCodes).size !== allowedReasonCodes.length)
      throw new SensitiveAccessPolicyError('SENSITIVE_ACCESS_POLICY_REASONS_INVALID')
    if (
      typeof candidate.maximumRecords !== 'number' ||
      !Number.isSafeInteger(candidate.maximumRecords) ||
      candidate.maximumRecords < 1 ||
      candidate.maximumRecords > MAX_EXPORT_RECORDS ||
      (operation === 'shipping_address.reveal' && candidate.maximumRecords !== 1)
    )
      throw new SensitiveAccessPolicyError('SENSITIVE_ACCESS_POLICY_LIMIT_INVALID')
    return { operation, allowedReasonCodes: [...allowedReasonCodes].sort(), maximumRecords: candidate.maximumRecords }
  })
  if (new Set(entries.map((entry) => entry.operation)).size !== SENSITIVE_ACCESS_OPERATIONS.length)
    throw new SensitiveAccessPolicyError('SENSITIVE_ACCESS_POLICY_ENTRIES_INCOMPLETE')
  const byOperation = new Map(entries.map((entry) => [entry.operation, entry]))
  return {
    schemaVersion: SENSITIVE_ACCESS_POLICY_SCHEMA_VERSION,
    policyVersion: value.policyVersion,
    status,
    environment,
    companyApprovalReference,
    securityApprovalReference,
    entries: SENSITIVE_ACCESS_OPERATIONS.map((operation) => {
      const entry = byOperation.get(operation)
      if (entry === undefined) throw new SensitiveAccessPolicyError('SENSITIVE_ACCESS_POLICY_ENTRIES_INCOMPLETE')
      return entry
    }),
  }
}

export const assertSensitiveAccessAllowed = (
  input: Readonly<{
    policy: unknown
    environment: AdminEnvironment
    operation: SensitiveAccessOperation
    reasonCode: string
    requestedRecords: number
  }>,
): SensitiveAccessPolicy => {
  const policy = parseSensitiveAccessPolicy(input.policy)
  if (policy.environment !== input.environment)
    throw new SensitiveAccessPolicyError('SENSITIVE_ACCESS_POLICY_ENVIRONMENT_MISMATCH')
  if (input.environment === 'production' && policy.status !== 'approved')
    throw new SensitiveAccessPolicyError('SENSITIVE_ACCESS_POLICY_NOT_APPROVED')
  const entry = policy.entries.find((candidate) => candidate.operation === input.operation)
  if (entry === undefined) throw new SensitiveAccessPolicyError('SENSITIVE_ACCESS_OPERATION_NOT_ALLOWED')
  if (!REASON_CODE.test(input.reasonCode) || !entry.allowedReasonCodes.includes(input.reasonCode))
    throw new SensitiveAccessPolicyError('SENSITIVE_ACCESS_REASON_NOT_ALLOWED')
  if (
    !Number.isSafeInteger(input.requestedRecords) ||
    input.requestedRecords < 1 ||
    input.requestedRecords > entry.maximumRecords
  )
    throw new SensitiveAccessPolicyError('SENSITIVE_ACCESS_RECORD_LIMIT_EXCEEDED')
  return policy
}

/** Deterministic tests only. It is structurally impossible to parse this fixture for production. */
export const SENSITIVE_ACCESS_TEST_FIXTURE_POLICY: SensitiveAccessPolicy = {
  schemaVersion: SENSITIVE_ACCESS_POLICY_SCHEMA_VERSION,
  policyVersion: 'sensitive-access-test-fixture-v1',
  status: 'test_fixture',
  environment: 'test',
  companyApprovalReference: null,
  securityApprovalReference: null,
  entries: [
    {
      operation: 'shipping_address.reveal',
      allowedReasonCodes: ['ADDRESS_CHANGE_REVIEW', 'FULFILLMENT'],
      maximumRecords: 1,
    },
    {
      operation: 'participant_data.export',
      allowedReasonCodes: ['LEGAL_RESPONSE', 'PRIVACY_REQUEST_FULFILLMENT'],
      maximumRecords: 25,
    },
  ],
}
