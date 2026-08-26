import type { HumanReviewPriority } from './handoff-priority.js'
import { isHumanReviewReasonCode, type HumanReviewReasonCode } from './reason-codes.js'

export const HUMAN_REVIEW_CASE_PACKET_VERSION = 'human-review-case-packet-v1' as const

const CODE = /^[A-Z][A-Z0-9_]*$/
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9:._/-]*$/
const RAW_KOREAN_MOBILE = /(?:\+?82|0)[\s-]*10(?:[\s-]*\d){8}/

export type HumanReviewEvidence = Readonly<{
  evidenceCode: string
  reference: string
  observedAt: string
}>

export type HumanReviewRuleResult = Readonly<{
  ruleCode: string
  resultCode: string
  version: string
}>

/**
 * The default operator payload for FR-HUM-003.
 *
 * References are opaque or pseudonymous. Participant names and phones must already be masked; raw
 * messages, addresses, attachment bytes, and provider payloads are deliberately not representable.
 */
export type HumanReviewCasePacket = Readonly<{
  schemaVersion: typeof HUMAN_REVIEW_CASE_PACKET_VERSION
  workflowReference: string
  workflowStateCode: string
  maskedIdentity: Readonly<{
    participantReference: string
    displayName: string
    phone: string | null
  }>
  application: Readonly<{
    reference: string
    lifecycleStatusCode: string
  }>
  campaign: Readonly<{
    reference: string
    typeCode: string
  }>
  summaryCode: HumanReviewReasonCode
  evidence: readonly HumanReviewEvidence[]
  rules: readonly HumanReviewRuleResult[]
  allowedActionCodes: readonly string[]
  priority: HumanReviewPriority
  recommendationCode: string
  automationPaused: true
  createdAt: string
}>

export type BuildHumanReviewCasePacketInput = Omit<
  HumanReviewCasePacket,
  'schemaVersion' | 'automationPaused' | 'createdAt'
> &
  Readonly<{ createdAt: Date }>

const assertCode = (value: string, field: string): void => {
  if (!CODE.test(value)) throw new Error(`${field} must be an uppercase reason code`)
}

const assertReference = (value: string, field: string): void => {
  if (value.length > 200 || !REFERENCE.test(value)) throw new Error(`${field} must be an opaque reference`)
}

const assertMaskedDisplay = (value: string, field: string): void => {
  if (value.length === 0 || value.length > 100 || RAW_KOREAN_MOBILE.test(value)) {
    throw new Error(`${field} must contain masked display data only`)
  }
  if (value !== '[masked]' && !value.includes('*')) {
    throw new Error(`${field} must visibly indicate masking`)
  }
}

const assertIsoTimestamp = (value: string, field: string): void => {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${field} must be a canonical ISO timestamp`)
  }
}

const assertUnique = (values: readonly string[], field: string): void => {
  if (new Set(values).size !== values.length) throw new Error(`${field} must not contain duplicates`)
}

export const buildHumanReviewCasePacket = (input: BuildHumanReviewCasePacketInput): HumanReviewCasePacket => {
  if (Number.isNaN(input.createdAt.getTime())) throw new Error('createdAt must be a valid date')
  assertReference(input.workflowReference, 'workflowReference')
  assertCode(input.workflowStateCode, 'workflowStateCode')
  assertReference(input.maskedIdentity.participantReference, 'maskedIdentity.participantReference')
  assertMaskedDisplay(input.maskedIdentity.displayName, 'maskedIdentity.displayName')
  if (input.maskedIdentity.phone !== null) assertMaskedDisplay(input.maskedIdentity.phone, 'maskedIdentity.phone')
  assertReference(input.application.reference, 'application.reference')
  assertCode(input.application.lifecycleStatusCode, 'application.lifecycleStatusCode')
  assertReference(input.campaign.reference, 'campaign.reference')
  assertCode(input.campaign.typeCode, 'campaign.typeCode')
  assertCode(input.summaryCode, 'summaryCode')
  assertCode(input.recommendationCode, 'recommendationCode')

  if (input.allowedActionCodes.length === 0) throw new Error('allowedActionCodes must not be empty')
  if (input.evidence.length === 0) throw new Error('evidence must not be empty')
  if (input.rules.length === 0) throw new Error('rules must not be empty')
  input.allowedActionCodes.forEach((code) => {
    assertCode(code, 'allowedActionCodes')
  })
  assertUnique(input.allowedActionCodes, 'allowedActionCodes')

  input.evidence.forEach((item) => {
    assertCode(item.evidenceCode, 'evidence.evidenceCode')
    assertReference(item.reference, 'evidence.reference')
    assertIsoTimestamp(item.observedAt, 'evidence.observedAt')
  })
  assertUnique(
    input.evidence.map((item) => `${item.evidenceCode}:${item.reference}`),
    'evidence',
  )

  input.rules.forEach((item) => {
    assertCode(item.ruleCode, 'rules.ruleCode')
    assertCode(item.resultCode, 'rules.resultCode')
    assertReference(item.version, 'rules.version')
  })
  assertUnique(
    input.rules.map((item) => `${item.ruleCode}:${item.version}`),
    'rules',
  )

  return {
    schemaVersion: HUMAN_REVIEW_CASE_PACKET_VERSION,
    workflowReference: input.workflowReference,
    workflowStateCode: input.workflowStateCode,
    maskedIdentity: { ...input.maskedIdentity },
    application: { ...input.application },
    campaign: { ...input.campaign },
    summaryCode: input.summaryCode,
    evidence: input.evidence.map((item) => ({ ...item })),
    rules: input.rules.map((item) => ({ ...item })),
    allowedActionCodes: [...input.allowedActionCodes],
    priority: input.priority,
    recommendationCode: input.recommendationCode,
    automationPaused: true,
    createdAt: input.createdAt.toISOString(),
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null

const isPriority = (value: unknown): value is HumanReviewPriority =>
  value === 'normal' || value === 'high' || value === 'critical'

export const isHumanReviewCasePacket = (value: unknown): value is HumanReviewCasePacket => {
  if (!isRecord(value) || value.schemaVersion !== HUMAN_REVIEW_CASE_PACKET_VERSION) return false
  const identity = value.maskedIdentity
  const application = value.application
  const campaign = value.campaign
  if (!isRecord(identity) || !isRecord(application) || !isRecord(campaign)) return false
  if (
    typeof value.workflowReference !== 'string' ||
    typeof value.workflowStateCode !== 'string' ||
    typeof identity.participantReference !== 'string' ||
    typeof identity.displayName !== 'string' ||
    (identity.phone !== null && typeof identity.phone !== 'string') ||
    typeof application.reference !== 'string' ||
    typeof application.lifecycleStatusCode !== 'string' ||
    typeof campaign.reference !== 'string' ||
    typeof campaign.typeCode !== 'string' ||
    typeof value.summaryCode !== 'string' ||
    !isHumanReviewReasonCode(value.summaryCode) ||
    !isPriority(value.priority) ||
    typeof value.recommendationCode !== 'string' ||
    value.automationPaused !== true ||
    typeof value.createdAt !== 'string' ||
    !Array.isArray(value.evidence) ||
    value.evidence.length === 0 ||
    !Array.isArray(value.rules) ||
    value.rules.length === 0 ||
    !Array.isArray(value.allowedActionCodes) ||
    value.allowedActionCodes.length === 0 ||
    !value.allowedActionCodes.every((item) => typeof item === 'string')
  ) {
    return false
  }
  if (
    !value.evidence.every(
      (item) =>
        isRecord(item) &&
        typeof item.evidenceCode === 'string' &&
        typeof item.reference === 'string' &&
        typeof item.observedAt === 'string',
    ) ||
    !value.rules.every(
      (item) =>
        isRecord(item) &&
        typeof item.ruleCode === 'string' &&
        typeof item.resultCode === 'string' &&
        typeof item.version === 'string',
    )
  ) {
    return false
  }
  const evidence = value.evidence as readonly HumanReviewEvidence[]
  const rules = value.rules as readonly HumanReviewRuleResult[]
  const allowedActionCodes = value.allowedActionCodes as readonly string[]

  try {
    assertReference(value.workflowReference, 'workflowReference')
    assertCode(value.workflowStateCode, 'workflowStateCode')
    assertReference(identity.participantReference, 'maskedIdentity.participantReference')
    assertMaskedDisplay(identity.displayName, 'maskedIdentity.displayName')
    if (identity.phone !== null) assertMaskedDisplay(identity.phone, 'maskedIdentity.phone')
    assertReference(application.reference, 'application.reference')
    assertCode(application.lifecycleStatusCode, 'application.lifecycleStatusCode')
    assertReference(campaign.reference, 'campaign.reference')
    assertCode(campaign.typeCode, 'campaign.typeCode')
    assertCode(value.summaryCode, 'summaryCode')
    assertCode(value.recommendationCode, 'recommendationCode')
    assertIsoTimestamp(value.createdAt, 'createdAt')
    allowedActionCodes.forEach((code) => {
      assertCode(code, 'allowedActionCodes')
    })
    assertUnique(allowedActionCodes, 'allowedActionCodes')
    evidence.forEach((item) => {
      assertCode(item.evidenceCode, 'evidence.evidenceCode')
      assertReference(item.reference, 'evidence.reference')
      assertIsoTimestamp(item.observedAt, 'evidence.observedAt')
    })
    assertUnique(
      evidence.map((item) => `${item.evidenceCode}:${item.reference}`),
      'evidence',
    )
    rules.forEach((item) => {
      assertCode(item.ruleCode, 'rules.ruleCode')
      assertCode(item.resultCode, 'rules.resultCode')
      assertReference(item.version, 'rules.version')
    })
    assertUnique(
      rules.map((item) => `${item.ruleCode}:${item.version}`),
      'rules',
    )
    return true
  } catch {
    return false
  }
}
