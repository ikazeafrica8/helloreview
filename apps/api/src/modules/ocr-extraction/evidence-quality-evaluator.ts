import {
  OCR_EVIDENCE_FIELDS,
  OCR_IMAGE_QUALITY_STATUSES,
  OCR_SCHEMA_VERSION,
  ocrExtractionEvidenceSchema,
  type OcrEvidenceFieldName,
  type OcrExtractionEvidence,
  type OcrImageQualityStatus,
  type OcrReservationStatus,
  type OcrVisibleBookingMethod,
} from '@helloreview/contracts'

export const OCR_EVIDENCE_REASON = {
  POLICY_MISSING: 'OCR_EVIDENCE_POLICY_MISSING',
  POLICY_INVALID: 'OCR_EVIDENCE_POLICY_INVALID',
  INPUT_INVALID: 'OCR_EVIDENCE_INPUT_INVALID',
  PROVIDER_POLICY_MISMATCH: 'OCR_EVIDENCE_PROVIDER_POLICY_MISMATCH',
  SCHEMA_POLICY_MISMATCH: 'OCR_EVIDENCE_SCHEMA_POLICY_MISMATCH',
  SUSPICIOUS_CONTENT: 'OCR_EVIDENCE_SUSPICIOUS_CONTENT',
  PROVIDER_REVIEW_REQUIRED: 'OCR_EVIDENCE_PROVIDER_REVIEW_REQUIRED',
  UNSAFE_IMAGE_QUALITY: 'OCR_EVIDENCE_UNSAFE_IMAGE_QUALITY',
  REQUIRED_FIELD_MISSING: 'OCR_EVIDENCE_REQUIRED_FIELD_MISSING',
  REQUIRED_FIELD_UNRESOLVED: 'OCR_EVIDENCE_REQUIRED_FIELD_UNRESOLVED',
  FIELD_CONFLICT: 'OCR_EVIDENCE_FIELD_CONFLICT',
  PROVIDER_DISAGREEMENT: 'OCR_EVIDENCE_PROVIDER_DISAGREEMENT',
  SHADOW_EVIDENCE_RECORDED: 'OCR_SHADOW_EVIDENCE_RECORDED',
} as const

export type OcrEvidenceReasonCode = (typeof OCR_EVIDENCE_REASON)[keyof typeof OCR_EVIDENCE_REASON]

/**
 * The two evidence fields whose contract enum carries an explicit `unknown` member. A provider that
 * returns the sentinel HAS produced a syntactically valid value, so the schema's
 * value/missingFields consistency rule is satisfied and the field never reaches `missingFields`.
 * Treating that as resolved evidence would let "the provider could not read the reservation status"
 * be recorded as clean shadow evidence, so it is routed to review instead.
 */
const UNRESOLVED_SENTINEL_FIELDS: readonly OcrEvidenceFieldName[] = ['reservationStatus', 'visibleBookingMethod']

/**
 * The intersection collapses to `never` if either contract enum ever drops its `unknown` member,
 * which fails this file's compilation rather than silently disabling the rule above.
 */
const UNRESOLVED_SENTINEL: OcrReservationStatus & OcrVisibleBookingMethod = 'unknown'

const MAX_SUSPICIOUS_TEXT_CHARACTERS = 4_000
const SUSPICIOUS_TEXT_PATTERNS: readonly RegExp[] = [
  /(ignore|disregard).{0,24}(previous|prior|system|policy)|(이전|기존|시스템).{0,16}(지시|정책|규칙).{0,12}(무시|우회|삭제)/iu,
  /(you are now|act as).{0,24}(admin|system)|너는.{0,20}(관리자|시스템)|역할.{0,8}(변경|바꿔)/iu,
  /(system prompt|developer message|hidden policy|시스템 프롬프트|개발자 메시지|숨겨진 지침)/iu,
  /(execute|run).{0,16}(tool|sql|database)|(도구|데이터베이스|sql).{0,16}(실행|조회|수정|삭제)/iu,
  /(selectionState|consentState|reservationState|businessApprovalState|guidelineState)/u,
  /<\/?(?:system|assistant|developer|script|tool)\b/iu,
]

/** Returns only a boolean signal; malformed input fails closed and normalized text is never returned or logged. */
export const detectSuspiciousOcrText = (text: unknown): boolean => {
  if (typeof text !== 'string') return true
  if (text.length > MAX_SUSPICIOUS_TEXT_CHARACTERS) return true
  const normalized = text
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .replace(/\p{Cc}/gu, ' ')
  if (normalized.length > MAX_SUSPICIOUS_TEXT_CHARACTERS) return true
  return SUSPICIOUS_TEXT_PATTERNS.some((pattern) => pattern.test(normalized))
}

/**
 * Structural policy only. Provider confidence is deliberately absent: production thresholds remain
 * uncalibrated and a provider score cannot authorize validation or progression.
 */
export type OcrEvidenceQualityPolicy = Readonly<{
  version: string
  provider: string
  model: string
  schemaVersion: typeof OCR_SCHEMA_VERSION
  requiredFields: readonly OcrEvidenceFieldName[]
  acceptableImageQualityStatuses: readonly OcrImageQualityStatus[]
}>

export type OcrEvidenceQualityInput = Readonly<{
  evidence: OcrExtractionEvidence
  provider: string
  model: string
  schemaVersion: string
  providerDisagreementFields: readonly OcrEvidenceFieldName[]
}>

export type OcrEvidenceQualityDecision = Readonly<{
  outcome: 'shadow_evidence' | 'retry_required' | 'human_review'
  reasonCode: OcrEvidenceReasonCode
  reasonCodes: readonly OcrEvidenceReasonCode[]
  affectedFields: readonly OcrEvidenceFieldName[]
  policyVersion: string | null
  /** Every OCR outcome stays operator-owned until a separately approved later phase. */
  requiresHumanReview: true
  deterministicValidationAllowed: false
  workflowProgressionAllowed: false
}>

const POLICY_KEYS = new Set([
  'version',
  'provider',
  'model',
  'schemaVersion',
  'requiredFields',
  'acceptableImageQualityStatuses',
])
const INPUT_KEYS = new Set(['evidence', 'provider', 'model', 'schemaVersion', 'providerDisagreementFields'])
const POLICY_VERSION_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/u
const PROVIDER_IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isUnknownArray = (value: unknown): value is readonly unknown[] => Array.isArray(value)

const isEvidenceFieldName = (value: unknown): value is OcrEvidenceFieldName =>
  typeof value === 'string' && OCR_EVIDENCE_FIELDS.some((field) => field === value)

const isImageQualityStatus = (value: unknown): value is OcrImageQualityStatus =>
  typeof value === 'string' && OCR_IMAGE_QUALITY_STATUSES.some((status) => status === value)

const parseFieldNames = (value: unknown): readonly OcrEvidenceFieldName[] | null => {
  if (!isUnknownArray(value) || value.length > OCR_EVIDENCE_FIELDS.length) return null
  const fields: OcrEvidenceFieldName[] = []
  for (const item of value) {
    if (!isEvidenceFieldName(item) || fields.includes(item)) return null
    fields.push(item)
  }
  return fields
}

const parseImageQualityStatuses = (value: unknown): readonly OcrImageQualityStatus[] | null => {
  if (!isUnknownArray(value)) return null
  const statuses: OcrImageQualityStatus[] = []
  for (const item of value) {
    if (!isImageQualityStatus(item)) return null
    statuses.push(item)
  }
  return statuses
}

const safePolicyVersion = (value: unknown): string | null =>
  typeof value === 'string' && POLICY_VERSION_PATTERN.test(value) ? value : null

const parsePolicy = (value: unknown): OcrEvidenceQualityPolicy | null => {
  if (!isRecord(value) || Object.keys(value).some((key) => !POLICY_KEYS.has(key))) return null
  const requiredFields = parseFieldNames(value.requiredFields)
  const acceptableImageQualityStatuses = parseImageQualityStatuses(value.acceptableImageQualityStatuses)
  const policyVersion = safePolicyVersion(value.version)
  if (
    policyVersion === null ||
    typeof value.provider !== 'string' ||
    !PROVIDER_IDENTITY_PATTERN.test(value.provider) ||
    typeof value.model !== 'string' ||
    !PROVIDER_IDENTITY_PATTERN.test(value.model) ||
    value.schemaVersion !== OCR_SCHEMA_VERSION ||
    requiredFields === null ||
    acceptableImageQualityStatuses === null ||
    requiredFields.length === 0 ||
    acceptableImageQualityStatuses.length !== 1 ||
    acceptableImageQualityStatuses[0] !== 'acceptable'
  ) {
    return null
  }
  if (
    new Set(requiredFields).size !== requiredFields.length ||
    new Set(acceptableImageQualityStatuses).size !== acceptableImageQualityStatuses.length
  ) {
    return null
  }
  return {
    version: policyVersion,
    provider: value.provider,
    model: value.model,
    schemaVersion: value.schemaVersion,
    requiredFields,
    acceptableImageQualityStatuses,
  }
}

const parseInput = (value: unknown): OcrEvidenceQualityInput | null => {
  if (!isRecord(value) || Object.keys(value).some((key) => !INPUT_KEYS.has(key))) return null
  const evidence = ocrExtractionEvidenceSchema.safeParse(value.evidence)
  const providerDisagreementFields = parseFieldNames(value.providerDisagreementFields)
  const schemaVersion = safePolicyVersion(value.schemaVersion)
  if (
    !evidence.success ||
    typeof value.provider !== 'string' ||
    !PROVIDER_IDENTITY_PATTERN.test(value.provider) ||
    typeof value.model !== 'string' ||
    !PROVIDER_IDENTITY_PATTERN.test(value.model) ||
    schemaVersion === null ||
    providerDisagreementFields === null
  ) {
    return null
  }
  return {
    evidence: evidence.data,
    provider: value.provider,
    model: value.model,
    schemaVersion,
    providerDisagreementFields,
  }
}

/**
 * Derives the prompt-injection signal from the only two free-text evidence fields. Callers cannot
 * supply or suppress this classification. Malformed evidence fails closed without returning text.
 */
export const detectSuspiciousOcrEvidence = (value: unknown): boolean => {
  const parsed = ocrExtractionEvidenceSchema.safeParse(value)
  if (!parsed.success) return true
  const visibleText = [parsed.data.businessName.value, parsed.data.reservationHolder.value]
  return visibleText.some((text) => text !== null && detectSuspiciousOcrText(text))
}

const fieldOrder = (fields: ReadonlySet<OcrEvidenceFieldName>): readonly OcrEvidenceFieldName[] =>
  OCR_EVIDENCE_FIELDS.filter((field) => fields.has(field))

/**
 * Every decision leaves this module deeply frozen. A quality decision is evidence that a later
 * reviewer reads, so a caller must not be able to widen `reasonCodes`, add an affected field, or
 * flip an outcome after the fact.
 */
const frozenDecision = (
  outcome: OcrEvidenceQualityDecision['outcome'],
  reasonCode: OcrEvidenceReasonCode,
  reasonCodes: readonly OcrEvidenceReasonCode[],
  affectedFields: readonly OcrEvidenceFieldName[],
  policyVersion: string | null,
): OcrEvidenceQualityDecision =>
  Object.freeze({
    outcome,
    reasonCode,
    reasonCodes: Object.freeze([...reasonCodes]),
    affectedFields: Object.freeze([...affectedFields]),
    policyVersion,
    requiresHumanReview: true,
    deterministicValidationAllowed: false,
    workflowProgressionAllowed: false,
  })

const stopped = (
  reasonCode: OcrEvidenceReasonCode,
  policyVersion: string | null,
  affectedFields: readonly OcrEvidenceFieldName[] = [],
): OcrEvidenceQualityDecision => frozenDecision('human_review', reasonCode, [reasonCode], affectedFields, policyVersion)

/** Pure structural assessment. It cannot approve a reservation or any other protected state. */
export const evaluateOcrEvidenceQuality = (
  input: OcrEvidenceQualityInput,
  policy: OcrEvidenceQualityPolicy | null,
): OcrEvidenceQualityDecision => {
  if (policy === null) return stopped(OCR_EVIDENCE_REASON.POLICY_MISSING, null)
  const parsedPolicy = parsePolicy(policy)
  if (parsedPolicy === null) {
    const policyVersion = isRecord(policy) ? safePolicyVersion(policy.version) : null
    return stopped(OCR_EVIDENCE_REASON.POLICY_INVALID, policyVersion)
  }
  const parsedInput = parseInput(input)
  if (parsedInput === null) return stopped(OCR_EVIDENCE_REASON.INPUT_INVALID, parsedPolicy.version)
  if (parsedInput.provider !== parsedPolicy.provider || parsedInput.model !== parsedPolicy.model) {
    return stopped(OCR_EVIDENCE_REASON.PROVIDER_POLICY_MISMATCH, parsedPolicy.version)
  }
  if (parsedInput.schemaVersion !== parsedPolicy.schemaVersion) {
    return stopped(OCR_EVIDENCE_REASON.SCHEMA_POLICY_MISMATCH, parsedPolicy.version)
  }

  const reasonCodes: OcrEvidenceReasonCode[] = []
  const affectedFields = new Set<OcrEvidenceFieldName>()

  if (detectSuspiciousOcrEvidence(parsedInput.evidence)) {
    reasonCodes.push(OCR_EVIDENCE_REASON.SUSPICIOUS_CONTENT)
  }
  if (parsedInput.evidence.requiresHumanReview) reasonCodes.push(OCR_EVIDENCE_REASON.PROVIDER_REVIEW_REQUIRED)

  for (const field of parsedPolicy.requiredFields) {
    const extracted = parsedInput.evidence[field]
    if (extracted.value === null || parsedInput.evidence.missingFields.includes(field)) {
      if (!reasonCodes.includes(OCR_EVIDENCE_REASON.REQUIRED_FIELD_MISSING)) {
        reasonCodes.push(OCR_EVIDENCE_REASON.REQUIRED_FIELD_MISSING)
      }
      affectedFields.add(field)
      continue
    }
    if (UNRESOLVED_SENTINEL_FIELDS.includes(field) && extracted.value === UNRESOLVED_SENTINEL) {
      if (!reasonCodes.includes(OCR_EVIDENCE_REASON.REQUIRED_FIELD_UNRESOLVED)) {
        reasonCodes.push(OCR_EVIDENCE_REASON.REQUIRED_FIELD_UNRESOLVED)
      }
      affectedFields.add(field)
    }
  }
  for (const field of parsedInput.evidence.conflictingFields) affectedFields.add(field)
  if (parsedInput.evidence.conflictingFields.length > 0) reasonCodes.push(OCR_EVIDENCE_REASON.FIELD_CONFLICT)
  for (const field of parsedInput.providerDisagreementFields) affectedFields.add(field)
  if (parsedInput.providerDisagreementFields.length > 0) {
    reasonCodes.push(OCR_EVIDENCE_REASON.PROVIDER_DISAGREEMENT)
  }

  const imageUnsafe = parsedInput.evidence.imageQualityStatus !== 'acceptable'
  if (imageUnsafe) reasonCodes.push(OCR_EVIDENCE_REASON.UNSAFE_IMAGE_QUALITY)

  const primaryReviewReason = reasonCodes.find((reason) => reason !== OCR_EVIDENCE_REASON.UNSAFE_IMAGE_QUALITY)
  if (primaryReviewReason !== undefined) {
    return frozenDecision(
      'human_review',
      primaryReviewReason,
      reasonCodes,
      fieldOrder(affectedFields),
      parsedPolicy.version,
    )
  }
  if (imageUnsafe) {
    return frozenDecision(
      'retry_required',
      OCR_EVIDENCE_REASON.UNSAFE_IMAGE_QUALITY,
      reasonCodes,
      [],
      parsedPolicy.version,
    )
  }
  return frozenDecision(
    'shadow_evidence',
    OCR_EVIDENCE_REASON.SHADOW_EVIDENCE_RECORDED,
    [OCR_EVIDENCE_REASON.SHADOW_EVIDENCE_RECORDED],
    [],
    parsedPolicy.version,
  )
}
