import { randomUUID } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import {
  OCR_EXTRACTION_EVIDENCE_KEYS,
  OCR_PROTECTED_STATE_BOUNDARY,
  OCR_SCHEMA_VERSION,
  OCR_TASK,
  ocrExtractionEvidenceSchema,
  ocrRequestSchema,
  ocrResultSchema,
} from './ocr.js'

const contentHash = 'a'.repeat(64)

const request = () => ({
  requestId: randomUUID(),
  task: OCR_TASK,
  schemaVersion: OCR_SCHEMA_VERSION,
  promptVersion: 'reservation-image-prompt-v1',
  inputVersion: 'safe-attachment-v1',
  input: {
    secureAttachmentReference: 'attachment-ref:synthetic-1',
    contentHash,
    mediaType: 'image/png',
    locale: 'ko-KR',
    timezone: 'Asia/Seoul',
  },
})

const evidence = () => ({
  businessName: { value: '예시 매장 강남점', confidence: 0.96 },
  reservationDate: { value: '2026-08-28', confidence: 0.94 },
  reservationTime: { value: '15:00', confidence: 0.91 },
  reservationStatus: { value: 'confirmed', confidence: 0.88 },
  reservationHolder: { value: null, confidence: null },
  visibleBookingMethod: { value: 'naver_booking', confidence: 0.87 },
  missingFields: ['reservationHolder'],
  conflictingFields: [],
  imageQualityStatus: 'acceptable',
  requiresHumanReview: false,
})

const metadata = () => ({
  requestId: randomUUID(),
  task: OCR_TASK,
  provider: 'deterministic-fake',
  model: 'fake-ocr-v1',
  schemaVersion: OCR_SCHEMA_VERSION,
  promptVersion: 'reservation-image-prompt-v1',
  inputVersion: 'safe-attachment-v1',
  provenance: {
    source: 'ocr_provider',
    providerRequestId: 'fake-request-1',
    producedAt: '2026-08-27T00:00:00.000Z',
  },
})

describe('T119 strict OCR contracts', () => {
  test('accepts only the approved request identity, version, and secure image reference', () => {
    const input = request()
    expect(ocrRequestSchema.parse(input)).toEqual(input)

    expect(() => ocrRequestSchema.parse({ ...request(), schemaVersion: 'reservation-image-v2' })).toThrow()
    expect(() => ocrRequestSchema.parse({ ...request(), rawImage: 'base64-private-image' })).toThrow()
    expect(() =>
      ocrRequestSchema.parse({
        ...request(),
        input: { ...request().input, attachmentId: 'internal-attachment-id' },
      }),
    ).toThrow()
    expect(() =>
      ocrRequestSchema.parse({
        ...request(),
        input: { ...request().input, secureAttachmentReference: 'https://storage.example/signed?token=secret' },
      }),
    ).toThrow()
    expect(() => ocrRequestSchema.parse({ ...request(), input: { ...request().input, contentHash: 'ABC' } })).toThrow()
    expect(() =>
      ocrRequestSchema.parse({ ...request(), input: { ...request().input, mediaType: 'application/pdf' } }),
    ).toThrow()
  })

  test('accepts exactly the PRD §19.4 allowlisted evidence fields', () => {
    const parsed = ocrExtractionEvidenceSchema.parse(evidence())
    expect(parsed).toEqual(evidence())
    expect(Object.keys(parsed).sort()).toEqual([...OCR_EXTRACTION_EVIDENCE_KEYS].sort())
    expect(OCR_PROTECTED_STATE_BOUNDARY).toBe(true)

    for (const forbidden of [
      'rawPayload',
      'rawModelOutput',
      'tools',
      'authorization',
      'selectionState',
      'consentState',
      'reservationState',
      'businessApprovalState',
      'guidelineState',
    ]) {
      expect(() => ocrExtractionEvidenceSchema.parse({ ...evidence(), [forbidden]: 'forbidden' })).toThrow()
    }
  })

  test('rejects inconsistent null/confidence and missing/conflict evidence', () => {
    expect(() =>
      ocrExtractionEvidenceSchema.parse({
        ...evidence(),
        reservationHolder: { value: null, confidence: 0.3 },
      }),
    ).toThrow()
    expect(() =>
      ocrExtractionEvidenceSchema.parse({
        ...evidence(),
        reservationHolder: { value: '홍길동', confidence: null },
        missingFields: [],
      }),
    ).toThrow()
    expect(() => ocrExtractionEvidenceSchema.parse({ ...evidence(), missingFields: [] })).toThrow()
    expect(() =>
      ocrExtractionEvidenceSchema.parse({ ...evidence(), conflictingFields: ['reservationHolder'] }),
    ).toThrow()
    expect(() =>
      ocrExtractionEvidenceSchema.parse({ ...evidence(), missingFields: ['reservationHolder', 'reservationHolder'] }),
    ).toThrow()
    expect(() =>
      ocrExtractionEvidenceSchema.parse({ ...evidence(), businessName: { value: '   ', confidence: 0.9 } }),
    ).toThrow()
    expect(() =>
      ocrExtractionEvidenceSchema.parse({ ...evidence(), businessName: { value: '매장\n명령', confidence: 0.9 } }),
    ).toThrow()
  })

  test('accepts evidence, refusal, and failure outcomes while rejecting raw provider material', () => {
    expect(ocrResultSchema.parse({ ...metadata(), outcome: 'evidence', evidence: evidence() })).toMatchObject({
      outcome: 'evidence',
      evidence: { imageQualityStatus: 'acceptable' },
    })
    expect(
      ocrResultSchema.parse({
        ...metadata(),
        outcome: 'refused',
        reasonCode: 'OCR_CONTENT_REFUSED',
        requiresHumanReview: true,
      }),
    ).toMatchObject({ outcome: 'refused', requiresHumanReview: true })
    expect(
      ocrResultSchema.parse({
        ...metadata(),
        outcome: 'failure',
        reasonCode: 'OCR_PROVIDER_UNAVAILABLE',
        retryable: true,
        requiresHumanReview: true,
      }),
    ).toMatchObject({ outcome: 'failure', retryable: true, requiresHumanReview: true })

    expect(() =>
      ocrResultSchema.parse({
        ...metadata(),
        outcome: 'evidence',
        evidence: evidence(),
        rawProviderPayload: { text: 'private screenshot text' },
      }),
    ).toThrow()
    expect(() =>
      ocrResultSchema.parse({
        ...metadata(),
        provider: 'p'.repeat(201),
        outcome: 'failure',
        reasonCode: 'OCR_PROVIDER_UNAVAILABLE',
        retryable: false,
        requiresHumanReview: true,
      }),
    ).toThrow()
    expect(() =>
      ocrResultSchema.parse({
        ...metadata(),
        outcome: 'failure',
        reasonCode: 'RESERVATION_VERIFIED',
        retryable: false,
        requiresHumanReview: true,
      }),
    ).toThrow()
    expect(() =>
      ocrResultSchema.parse({
        ...metadata(),
        outcome: 'refused',
        reasonCode: 'OCR_CONTENT_REFUSED',
        requiresHumanReview: false,
      }),
    ).toThrow()
  })
})
