import { z } from 'zod'
import { isoTimestamp } from './events/primitives.js'

/** The only OCR operation authorized by the PRD §19.4 contract. */
export const OCR_TASK = 'reservation_image_extraction' as const

/** PRD §19.4 names this version explicitly. Unknown versions fail closed. */
export const OCR_SCHEMA_VERSION = 'reservation-image-v1' as const

/** Fields that may be named by `missingFields` and `conflictingFields`. */
export const OCR_EVIDENCE_FIELDS = [
  'businessName',
  'reservationDate',
  'reservationTime',
  'reservationStatus',
  'reservationHolder',
  'visibleBookingMethod',
] as const
export type OcrEvidenceFieldName = (typeof OCR_EVIDENCE_FIELDS)[number]

/** Exact top-level evidence result allowlist, including structural metadata. */
export const OCR_EXTRACTION_EVIDENCE_KEYS = [
  ...OCR_EVIDENCE_FIELDS,
  'missingFields',
  'conflictingFields',
  'imageQualityStatus',
  'requiresHumanReview',
] as const

export const OCR_RESERVATION_STATUSES = ['confirmed', 'pending', 'cancelled', 'unknown'] as const
export type OcrReservationStatus = (typeof OCR_RESERVATION_STATUSES)[number]

export const OCR_VISIBLE_BOOKING_METHODS = ['naver_booking', 'other', 'unknown'] as const
export type OcrVisibleBookingMethod = (typeof OCR_VISIBLE_BOOKING_METHODS)[number]

export const OCR_IMAGE_QUALITY_STATUSES = ['acceptable', 'cropped', 'blurred', 'incomplete', 'unusable'] as const
export type OcrImageQualityStatus = (typeof OCR_IMAGE_QUALITY_STATUSES)[number]

export const OCR_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const
export type OcrMediaType = (typeof OCR_MEDIA_TYPES)[number]

/** Exhaustive provider/orchestrator outcomes; untrusted providers cannot mint business semantics. */
export const OCR_RESULT_REASON_CODES = [
  'OCR_CONTENT_REFUSED',
  'OCR_PROVIDER_NOT_CONFIGURED',
  'OCR_FAKE_PLAN_EXHAUSTED',
  'OCR_PROVIDER_TIMEOUT',
  'OCR_PROVIDER_INVALID_RESULT',
  'OCR_PROVIDER_UNAVAILABLE',
  'OCR_PROVIDER_REFUSED',
  'OCR_PROVIDER_DISAGREEMENT',
  'OCR_PROVIDER_COMPARISON_UNAVAILABLE',
  'OCR_PROVIDER_CASCADE_EXHAUSTED',
] as const
export type OcrResultReasonCode = (typeof OCR_RESULT_REASON_CODES)[number]

const contractVersion = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/)
const confidence = z.number().min(0).max(1)
const providerIdentity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/)
const providerRequestIdentifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/)
const hasControlCharacter = (value: string): boolean => {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true
  }
  return false
}
const boundedText = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => value.trim().length > 0 && !hasControlCharacter(value), 'must be visible text')
const secureAttachmentReference = z
  .string()
  .regex(/^attachment-ref:[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/, 'must be an opaque attachment-ref token')
const sha256 = z.string().regex(/^[a-f0-9]{64}$/, 'must be a lowercase SHA-256 digest')

/**
 * A value and its confidence are one atomic observation: both are present or both are absent.
 * This union deliberately rejects `{ value: null, confidence: 0 }` and its inverse.
 */
const evidenceField = <T extends z.ZodType>(value: T) =>
  z.union([z.strictObject({ value, confidence }), z.strictObject({ value: z.null(), confidence: z.null() })])

export const ocrRequestSchema = z.strictObject({
  requestId: z.uuid(),
  task: z.literal(OCR_TASK),
  schemaVersion: z.literal(OCR_SCHEMA_VERSION),
  promptVersion: contractVersion,
  inputVersion: contractVersion,
  input: z.strictObject({
    secureAttachmentReference,
    contentHash: sha256,
    mediaType: z.enum(OCR_MEDIA_TYPES),
    locale: z.literal('ko-KR'),
    timezone: z.literal('Asia/Seoul'),
  }),
})

export type OcrRequest = z.infer<typeof ocrRequestSchema>

const namedEvidenceFields = z
  .array(z.enum(OCR_EVIDENCE_FIELDS))
  .max(OCR_EVIDENCE_FIELDS.length)
  .refine((fields) => new Set(fields).size === fields.length, 'field names must be unique')

export const ocrExtractionEvidenceSchema = z
  .strictObject({
    businessName: evidenceField(boundedText),
    reservationDate: evidenceField(z.iso.date()),
    reservationTime: evidenceField(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)),
    reservationStatus: evidenceField(z.enum(OCR_RESERVATION_STATUSES)),
    reservationHolder: evidenceField(boundedText),
    visibleBookingMethod: evidenceField(z.enum(OCR_VISIBLE_BOOKING_METHODS)),
    missingFields: namedEvidenceFields,
    conflictingFields: namedEvidenceFields,
    imageQualityStatus: z.enum(OCR_IMAGE_QUALITY_STATUSES),
    requiresHumanReview: z.boolean(),
  })
  .superRefine((evidence, context) => {
    const missing = new Set(evidence.missingFields)

    for (const field of OCR_EVIDENCE_FIELDS) {
      const hasValue = evidence[field].value !== null
      if (hasValue === missing.has(field)) {
        context.addIssue({
          code: 'custom',
          path: ['missingFields'],
          message: `${field} must be named exactly when its value is null`,
        })
      }
    }

    for (const field of evidence.conflictingFields) {
      if (missing.has(field)) {
        context.addIssue({
          code: 'custom',
          path: ['conflictingFields'],
          message: `${field} cannot be both missing and conflicting`,
        })
      }
    }
  })

export type OcrExtractionEvidence = z.infer<typeof ocrExtractionEvidenceSchema>

const resultMetadata = {
  requestId: z.uuid(),
  task: z.literal(OCR_TASK),
  provider: providerIdentity,
  model: providerIdentity,
  schemaVersion: z.literal(OCR_SCHEMA_VERSION),
  promptVersion: contractVersion,
  inputVersion: contractVersion,
  provenance: z.strictObject({
    source: z.enum(['ocr_provider', 'ocr_orchestrator']),
    providerRequestId: providerRequestIdentifier,
    producedAt: isoTimestamp,
  }),
}

export const ocrResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    ...resultMetadata,
    outcome: z.literal('evidence'),
    evidence: ocrExtractionEvidenceSchema,
  }),
  z.strictObject({
    ...resultMetadata,
    outcome: z.literal('refused'),
    reasonCode: z.enum(OCR_RESULT_REASON_CODES),
    requiresHumanReview: z.literal(true),
  }),
  z.strictObject({
    ...resultMetadata,
    outcome: z.literal('failure'),
    reasonCode: z.enum(OCR_RESULT_REASON_CODES),
    retryable: z.boolean(),
    requiresHumanReview: z.literal(true),
  }),
])

export type OcrResult = z.infer<typeof ocrResultSchema>

type OcrEvidenceKeys = keyof OcrExtractionEvidence
type ApprovedOcrEvidenceKey = (typeof OCR_EXTRACTION_EVIDENCE_KEYS)[number]
export type OcrProtectedStateBoundary =
  Exclude<OcrEvidenceKeys, ApprovedOcrEvidenceKey> extends never
    ? Exclude<ApprovedOcrEvidenceKey, OcrEvidenceKeys> extends never
      ? true
      : never
    : never
export const OCR_PROTECTED_STATE_BOUNDARY: OcrProtectedStateBoundary = true
