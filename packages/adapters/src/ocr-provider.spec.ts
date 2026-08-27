import { afterEach, describe, expect, test, vi } from 'vitest'
import { OCR_SCHEMA_VERSION, OCR_TASK, type OcrExtractionEvidence, type OcrRequest } from '@helloreview/contracts'
import { ocrProviderConformanceChecks } from './conformance/ocr-provider.suite.js'
import { createFakeOcrProvider, createUnavailableOcrProvider } from './fakes/ocr-provider-fake.js'
import { OcrProviderAbortedError } from './ports/ocr-provider.js'

const request: OcrRequest = {
  requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  task: OCR_TASK,
  schemaVersion: OCR_SCHEMA_VERSION,
  promptVersion: 'reservation-image-prompt-v1',
  inputVersion: 'secure-attachment-v1',
  input: {
    secureAttachmentReference: 'attachment-ref:synthetic-secret-123',
    contentHash: 'a'.repeat(64),
    mediaType: 'image/png',
    locale: 'ko-KR',
    timezone: 'Asia/Seoul',
  },
}

const evidence: OcrExtractionEvidence = {
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
}

const fake = () =>
  createFakeOcrProvider({
    provider: 'deterministic-ocr-fake',
    model: 'synthetic-v1',
    steps: [{ kind: 'evidence', evidence }],
  })

afterEach(() => {
  vi.useRealTimers()
})

describe('T120 OCR provider port and deterministic fake', () => {
  for (const check of ocrProviderConformanceChecks({
    createProvider: fake,
    createAbortableProvider: () =>
      createFakeOcrProvider({
        provider: 'abortable-fake',
        model: 'synthetic-v1',
        steps: [{ kind: 'delay', milliseconds: 1_000, then: { kind: 'evidence', evidence } }],
      }),
    request,
    assertPreAbortedState: (provider) => {
      expect('observations' in provider).toBe(true)
      if ('observations' in provider) expect(provider.observations).toEqual([])
    },
  })) {
    test(check.name, check.run)
  }

  test('produces identical output for an identical script and never observes attachment material', async () => {
    const first = fake()
    const second = fake()
    const firstResult = await first.extract(request)
    expect(firstResult).toEqual(await second.extract(request))
    expect(firstResult.provenance).toEqual({
      source: 'ocr_provider',
      providerRequestId: 'fake-ocr-1',
      producedAt: '2026-01-01T00:00:00.000Z',
    })

    expect(first.observations).toEqual([
      {
        requestId: request.requestId,
        task: request.task,
        schemaVersion: request.schemaVersion,
        promptVersion: request.promptVersion,
        inputVersion: request.inputVersion,
      },
    ])
    expect(Object.keys(first.observations[0] ?? {})).toEqual([
      'requestId',
      'task',
      'schemaVersion',
      'promptVersion',
      'inputVersion',
    ])
    const observations = JSON.stringify(first.observations)
    expect(observations).not.toContain(request.input.secureAttachmentReference)
    expect(observations).not.toContain(request.input.contentHash)
    expect(observations).not.toContain(request.input.mediaType)
  })

  test('snapshots scripted evidence so caller mutation cannot change a later fake result', async () => {
    const plannedEvidence: OcrExtractionEvidence = {
      ...evidence,
      businessName: { value: '원래 합성 매장', confidence: 0.9 },
    }
    const provider = createFakeOcrProvider({
      provider: 'snapshot-fake',
      model: 'synthetic-v1',
      steps: [{ kind: 'evidence', evidence: plannedEvidence }],
    })
    plannedEvidence.businessName = { value: '변경된 외부 값', confidence: 1 }

    await expect(provider.extract(request)).resolves.toMatchObject({
      outcome: 'evidence',
      evidence: { businessName: { value: '원래 합성 매장', confidence: 0.9 } },
    })
  })

  test('does not observe or consume a scripted step for a pre-aborted call', async () => {
    const provider = fake()
    const abortController = new AbortController()
    abortController.abort()

    await expect(provider.extract(request, { signal: abortController.signal })).rejects.toBeInstanceOf(
      OcrProviderAbortedError,
    )
    expect(provider.observations).toHaveLength(0)

    await expect(provider.extract(request)).resolves.toMatchObject({
      outcome: 'evidence',
      provenance: { providerRequestId: 'fake-ocr-1' },
      evidence,
    })
    expect(provider.observations).toHaveLength(1)
  })

  test('makes the scripted delay abort-aware so orchestration can enforce a time budget', async () => {
    vi.useFakeTimers()
    const provider = createFakeOcrProvider({
      provider: 'slow-fake',
      model: 'synthetic-v1',
      steps: [{ kind: 'delay', milliseconds: 1_000, then: { kind: 'evidence', evidence } }],
    })
    const abortController = new AbortController()
    const pending = provider.extract(request, { signal: abortController.signal })
    abortController.abort()

    await expect(pending).rejects.toBeInstanceOf(OcrProviderAbortedError)
    expect(vi.getTimerCount()).toBe(0)
    expect(provider.observations).toHaveLength(1)
  })

  test('resolves a delayed scripted result when its time budget remains open', async () => {
    vi.useFakeTimers()
    const provider = createFakeOcrProvider({
      provider: 'slow-fake',
      model: 'synthetic-v1',
      steps: [{ kind: 'delay', milliseconds: 1_000, then: { kind: 'evidence', evidence } }],
    })
    const pending = provider.extract(request)

    await vi.advanceTimersByTimeAsync(999)
    let settled = false
    void pending.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toMatchObject({ outcome: 'evidence', evidence })
  })

  test('follows refusal, failure, throw, and exhausted-script paths in order', async () => {
    const provider = createFakeOcrProvider({
      provider: 'scripted-fake',
      model: 'synthetic-v1',
      steps: [
        { kind: 'refused', reasonCode: 'OCR_CONTENT_REFUSED' },
        { kind: 'failure', reasonCode: 'OCR_PROVIDER_UNAVAILABLE', retryable: true },
        { kind: 'throw', message: 'synthetic transport fault' },
      ],
    })

    await expect(provider.extract(request)).resolves.toMatchObject({
      outcome: 'refused',
      reasonCode: 'OCR_CONTENT_REFUSED',
      requiresHumanReview: true,
    })
    await expect(provider.extract(request)).resolves.toMatchObject({
      outcome: 'failure',
      reasonCode: 'OCR_PROVIDER_UNAVAILABLE',
      retryable: true,
      requiresHumanReview: true,
    })
    await expect(provider.extract(request)).rejects.toThrow('synthetic transport fault')
    await expect(provider.extract(request)).resolves.toMatchObject({
      outcome: 'failure',
      reasonCode: 'OCR_FAKE_PLAN_EXHAUSTED',
      retryable: false,
      requiresHumanReview: true,
    })
  })

  test('returns the same safe fallback every time when no provider is configured', async () => {
    const provider = createUnavailableOcrProvider()
    await expect(provider.extract(request)).resolves.toMatchObject({
      outcome: 'failure',
      reasonCode: 'OCR_PROVIDER_NOT_CONFIGURED',
      retryable: false,
      requiresHumanReview: true,
    })
    await expect(provider.extract(request)).resolves.toMatchObject({
      outcome: 'failure',
      reasonCode: 'OCR_PROVIDER_NOT_CONFIGURED',
      retryable: false,
      requiresHumanReview: true,
    })
  })

  test('validates scripted output before it can cross the provider boundary', () => {
    const invalidEvidence: OcrExtractionEvidence & Readonly<{ rawProviderPayload: string }> = {
      ...evidence,
      rawProviderPayload: 'must never escape',
    }
    expect(() =>
      createFakeOcrProvider({
        provider: 'invalid-output-fake',
        model: 'synthetic-v1',
        steps: [
          {
            kind: 'evidence',
            evidence: invalidEvidence,
          },
        ],
      }),
    ).toThrow()
  })
})
