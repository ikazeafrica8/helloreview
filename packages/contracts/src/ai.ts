import { z } from 'zod'
import { identifier, isoTimestamp, reasonCode } from './events/primitives.js'

export const AI_TASKS = ['intent_classification', 'date_time_extraction', 'advisory_recommendation'] as const
export type AiTask = (typeof AI_TASKS)[number]

export const AI_INTENT_CODES = [
  'SECRET_COMMENT_CLAIM',
  'APPLICATION_REQUEST',
  'APPLICATION_COMPLETED_CLAIM',
  'APPLICATION_STATUS_QUERY',
  'IDENTITY_INFORMATION',
  'SCREENSHOT_SUBMISSION',
  'CONSENT_AGREE',
  'CONSENT_DECLINE',
  'CONSENT_WITHDRAW',
  'CONSENT_AMBIGUOUS',
  'RESERVATION_DATETIME',
  'RESERVATION_RESCHEDULE',
  'RESERVATION_CANCEL',
  'GUIDELINE_REQUEST',
  'HUMAN_REQUEST',
  'COMPLAINT',
  'PRIVACY_REQUEST',
  'UNKNOWN',
] as const

const contractVersion = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/)
const confidence = z.number().min(0).max(1)
const nullableText = z.string().min(1).max(500).nullable()

export const aiRequestSchema = z.strictObject({
  requestId: z.uuid(),
  task: z.enum(AI_TASKS),
  schemaVersion: contractVersion,
  promptVersion: contractVersion,
  inputVersion: contractVersion,
  input: z.strictObject({
    text: z.string().min(1).max(8_000),
    locale: z.literal('ko-KR'),
    timezone: z.literal('Asia/Seoul'),
  }),
})

export type AiRequest = z.infer<typeof aiRequestSchema>

export const aiIntentEvidenceSchema = z.strictObject({
  task: z.literal('intent_classification'),
  intentCode: z.enum(AI_INTENT_CODES),
  confidence,
  entities: z.strictObject({
    participantName: nullableText,
    phoneNumber: nullableText,
    campaignName: nullableText,
    reservationDateText: nullableText,
    reservationTimeText: nullableText,
    businessName: nullableText,
  }),
  ambiguities: z.array(reasonCode).max(20),
  requiresClarification: z.boolean(),
  requiresHumanReview: z.boolean(),
})

export const aiDateTimeEvidenceSchema = z.strictObject({
  task: z.literal('date_time_extraction'),
  candidates: z
    .array(
      z.strictObject({
        dateText: nullableText,
        timeText: nullableText,
        normalizedDate: z.iso.date().nullable(),
        normalizedTime: z
          .string()
          .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
          .nullable(),
        timezone: z.literal('Asia/Seoul'),
        confidence,
      }),
    )
    .max(10),
  ambiguities: z.array(reasonCode).max(20),
  requiresClarification: z.boolean(),
  requiresHumanReview: z.boolean(),
})

/** Advisory only. There is deliberately no selected/not-selected or workflow-state field. */
export const aiAdvisoryEvidenceSchema = z.strictObject({
  task: z.literal('advisory_recommendation'),
  advisoryCode: reasonCode,
  factReferences: z.array(identifier).max(50),
  confidence,
  requiresHumanReview: z.literal(true),
})

export const aiEvidenceSchema = z.discriminatedUnion('task', [
  aiIntentEvidenceSchema,
  aiDateTimeEvidenceSchema,
  aiAdvisoryEvidenceSchema,
])

export type AiIntentEvidence = z.infer<typeof aiIntentEvidenceSchema>
export type AiDateTimeEvidence = z.infer<typeof aiDateTimeEvidenceSchema>
export type AiAdvisoryEvidence = z.infer<typeof aiAdvisoryEvidenceSchema>
export type AiEvidence = z.infer<typeof aiEvidenceSchema>

const resultMetadata = {
  requestId: z.uuid(),
  task: z.enum(AI_TASKS),
  provider: identifier,
  model: identifier,
  schemaVersion: contractVersion,
  promptVersion: contractVersion,
  inputVersion: contractVersion,
  provenance: z.strictObject({
    source: z.literal('ai_provider'),
    providerRequestId: identifier,
    producedAt: isoTimestamp,
  }),
}

export const aiResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ ...resultMetadata, outcome: z.literal('evidence'), evidence: aiEvidenceSchema }),
  z.strictObject({
    ...resultMetadata,
    outcome: z.literal('refused'),
    reasonCode,
    requiresHumanReview: z.literal(true),
  }),
  z.strictObject({
    ...resultMetadata,
    outcome: z.literal('failure'),
    reasonCode,
    retryable: z.boolean(),
    requiresHumanReview: z.literal(true),
  }),
])

export type AiResult = z.infer<typeof aiResultSchema>

type ProtectedStateKey =
  'selectionState' | 'consentState' | 'reservationState' | 'businessApprovalState' | 'guidelineState'
type EvidenceKeys = keyof AiIntentEvidence | keyof AiDateTimeEvidence | keyof AiAdvisoryEvidence
export type AiProtectedStateBoundary = Extract<EvidenceKeys, ProtectedStateKey> extends never ? true : never
export const AI_PROTECTED_STATE_BOUNDARY: AiProtectedStateBoundary = true
