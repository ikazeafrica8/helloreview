import { describe, expect, test } from 'vitest'
import { createFakeOcrProvider } from '../../packages/adapters/dist/index.js'
import { OCR_SCHEMA_VERSION, OCR_TASK } from '../../packages/contracts/dist/index.js'
import {
  OcrExtractionError,
  OcrExtractionService,
  OCR_ORCHESTRATION_REASON,
} from '../../apps/api/dist/modules/ocr-extraction/index.js'

const request = (requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') => ({
  requestId,
  task: OCR_TASK,
  schemaVersion: OCR_SCHEMA_VERSION,
  promptVersion: 'reservation-image-prompt-v1',
  inputVersion: 'safe-attachment-v1',
  input: {
    secureAttachmentReference: 'attachment-ref:synthetic-1',
    contentHash: 'a'.repeat(64),
    mediaType: 'image/png',
    locale: 'ko-KR',
    timezone: 'Asia/Seoul',
  },
})

const evidence = (businessName = '예시 매장 강남점') => ({
  businessName: { value: businessName, confidence: 0.96 },
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

const fake = (provider, steps) => createFakeOcrProvider({ provider, model: `${provider}-v1`, steps })

describe('T120 OCR extraction time budget and safe fallbacks', () => {
  test('falls back after timeout, aborts the slow provider, and replays idempotently', async () => {
    const slow = fake('slow', [{ kind: 'delay', milliseconds: 50, then: { kind: 'evidence', evidence: evidence() } }])
    const fallback = fake('fallback', [{ kind: 'evidence', evidence: evidence() }])
    const service = new OcrExtractionService([slow, fallback], { providerTimeoutMs: 5 })
    const input = request()

    const [first, replay] = await Promise.all([service.execute(input), service.execute(input)])

    expect(first).toEqual(replay)
    expect(first).toMatchObject({
      outcome: 'evidence',
      provider: 'fallback',
      requestId: input.requestId,
      evidence: { requiresHumanReview: false },
    })
    expect(slow.observations).toHaveLength(1)
    expect(fallback.observations).toHaveLength(1)
  })

  test('uses providers as an ordered cascade and does not call fallback after primary success', async () => {
    const primary = fake('primary', [{ kind: 'evidence', evidence: evidence() }])
    const fallback = fake('fallback', [{ kind: 'throw' }])

    await expect(new OcrExtractionService([primary, fallback]).execute(request())).resolves.toMatchObject({
      outcome: 'evidence',
      provider: 'primary',
      evidence: { requiresHumanReview: false },
    })
    expect(primary.observations).toHaveLength(1)
    expect(fallback.observations).toHaveLength(0)
  })

  test.each([
    {
      label: 'invalid structured output',
      provider: {
        provider: 'invalid',
        model: 'invalid-v1',
        extract: async () => ({ outcome: 'evidence', toolCalls: ['write_state'] }),
      },
      reasonCode: OCR_ORCHESTRATION_REASON.PROVIDER_INVALID_RESULT,
    },
    {
      label: 'provider outage',
      provider: {
        provider: 'outage',
        model: 'outage-v1',
        extract: async () => {
          throw new Error('provider unavailable')
        },
      },
      reasonCode: OCR_ORCHESTRATION_REASON.PROVIDER_UNAVAILABLE,
    },
  ])('fails closed for $label', async ({ provider, reasonCode }) => {
    await expect(new OcrExtractionService([provider]).execute(request())).resolves.toMatchObject({
      outcome: 'failure',
      reasonCode,
      retryable: false,
      requiresHumanReview: true,
    })
  })

  test.each([
    {
      label: 'an exported orchestration error',
      createError: () => new OcrExtractionError(OCR_ORCHESTRATION_REASON.PROVIDER_TIMEOUT),
    },
    {
      label: 'a forged ZodError name',
      createError: () => Object.assign(new Error('provider-controlled parser failure'), { name: 'ZodError' }),
    },
  ])('classifies provider-thrown $label as unavailable rather than trusting its shape', async ({ createError }) => {
    const provider = {
      provider: 'exception-spoof',
      model: 'exception-spoof-v1',
      extract: async () => {
        throw createError()
      },
    }

    await expect(new OcrExtractionService([provider]).execute(request())).resolves.toMatchObject({
      outcome: 'failure',
      reasonCode: OCR_ORCHESTRATION_REASON.PROVIDER_UNAVAILABLE,
      retryable: false,
    })
  })

  test.each([
    ['requestId', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
    ['promptVersion', 'different-prompt-v1'],
    ['inputVersion', 'different-input-v1'],
    ['provider', 'spoofed-provider'],
    ['model', 'spoofed-model'],
    [
      'provenance',
      {
        source: 'ocr_orchestrator',
        providerRequestId: 'spoofed-provenance',
        producedAt: '2030-01-01T00:00:00.000Z',
      },
    ],
  ])('rejects a valid-shaped provider identity mismatch in %s', async (field, value) => {
    const provider = {
      provider: 'identity-provider',
      model: 'identity-model-v1',
      extract: async (providerRequest) => ({
        requestId: providerRequest.requestId,
        task: providerRequest.task,
        provider: 'identity-provider',
        model: 'identity-model-v1',
        schemaVersion: providerRequest.schemaVersion,
        promptVersion: providerRequest.promptVersion,
        inputVersion: providerRequest.inputVersion,
        provenance: {
          source: 'ocr_provider',
          providerRequestId: 'identity-mismatch',
          producedAt: '2030-01-01T00:00:00.000Z',
        },
        outcome: 'evidence',
        evidence: evidence(),
        [field]: value,
      }),
    }

    await expect(new OcrExtractionService([provider]).execute(request())).resolves.toMatchObject({
      outcome: 'failure',
      reasonCode: OCR_ORCHESTRATION_REASON.PROVIDER_INVALID_RESULT,
      requiresHumanReview: true,
    })
  })

  test('returns the named timeout fallback when every provider exceeds its budget', async () => {
    const slow = fake('slow', [{ kind: 'delay', milliseconds: 50, then: { kind: 'evidence', evidence: evidence() } }])

    await expect(new OcrExtractionService([slow], { providerTimeoutMs: 5 }).execute(request())).resolves.toMatchObject({
      outcome: 'failure',
      reasonCode: OCR_ORCHESTRATION_REASON.PROVIDER_TIMEOUT,
      retryable: false,
      requiresHumanReview: true,
      provenance: { source: 'ocr_orchestrator' },
    })
  })

  test('returns a named human-review fallback when valid providers disagree', async () => {
    const first = fake('first', [{ kind: 'evidence', evidence: evidence('강남점') }])
    const second = fake('second', [{ kind: 'evidence', evidence: evidence('홍대점') }])

    await expect(
      new OcrExtractionService([first], { comparisonProviders: [second] }).execute(request()),
    ).resolves.toMatchObject({
      outcome: 'failure',
      reasonCode: OCR_ORCHESTRATION_REASON.PROVIDER_DISAGREEMENT,
      retryable: false,
      requiresHumanReview: true,
    })
  })

  test('rejects the accepted provider object as its own comparison source without calling it twice', async () => {
    const shared = fake('shared-source', [{ kind: 'evidence', evidence: evidence() }])

    await expect(
      new OcrExtractionService([shared], { comparisonProviders: [shared] }).execute(request()),
    ).resolves.toMatchObject({
      outcome: 'failure',
      reasonCode: OCR_ORCHESTRATION_REASON.PROVIDER_COMPARISON_UNAVAILABLE,
      retryable: false,
    })
    expect(shared.observations).toHaveLength(1)
  })

  test('rejects a distinct comparison object with the accepted provider and model identity', async () => {
    const primary = fake('duplicate-identity', [{ kind: 'evidence', evidence: evidence() }])
    const comparison = fake('duplicate-identity', [{ kind: 'evidence', evidence: evidence() }])

    await expect(
      new OcrExtractionService([primary], { comparisonProviders: [comparison] }).execute(request()),
    ).resolves.toMatchObject({
      outcome: 'failure',
      reasonCode: OCR_ORCHESTRATION_REASON.PROVIDER_COMPARISON_UNAVAILABLE,
      retryable: false,
    })
    expect(primary.observations).toHaveLength(1)
    expect(comparison.observations).toHaveLength(0)
  })

  test('rejects a repeated comparison source after one independent comparison', async () => {
    const primary = fake('primary-source', [{ kind: 'evidence', evidence: evidence() }])
    const comparison = fake('comparison-source', [{ kind: 'evidence', evidence: evidence() }])

    await expect(
      new OcrExtractionService([primary], { comparisonProviders: [comparison, comparison] }).execute(request()),
    ).resolves.toMatchObject({
      outcome: 'failure',
      reasonCode: OCR_ORCHESTRATION_REASON.PROVIDER_COMPARISON_UNAVAILABLE,
      retryable: false,
    })
    expect(primary.observations).toHaveLength(1)
    expect(comparison.observations).toHaveLength(1)
  })

  test('fails closed when an explicitly required comparison provider is unavailable', async () => {
    const primary = fake('primary', [{ kind: 'evidence', evidence: evidence() }])
    const comparison = fake('comparison', [{ kind: 'throw' }])

    await expect(
      new OcrExtractionService([primary], { comparisonProviders: [comparison] }).execute(request()),
    ).resolves.toMatchObject({
      outcome: 'failure',
      reasonCode: OCR_ORCHESTRATION_REASON.PROVIDER_COMPARISON_UNAVAILABLE,
      retryable: false,
      requiresHumanReview: true,
    })
  })

  test('normalizes provider-controlled refusal and failure reason codes', async () => {
    const refused = fake('refused', [{ kind: 'refused', reasonCode: 'OCR_CONTENT_REFUSED' }])
    const failed = fake('failed', [{ kind: 'failure', reasonCode: 'OCR_PROVIDER_NOT_CONFIGURED', retryable: true }])

    await expect(new OcrExtractionService([refused]).execute(request())).resolves.toMatchObject({
      outcome: 'refused',
      reasonCode: OCR_ORCHESTRATION_REASON.PROVIDER_REFUSED,
      requiresHumanReview: true,
    })
    await expect(
      new OcrExtractionService([failed]).execute(request('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')),
    ).resolves.toMatchObject({
      outcome: 'failure',
      reasonCode: OCR_ORCHESTRATION_REASON.PROVIDER_UNAVAILABLE,
      retryable: false,
      requiresHumanReview: true,
    })
  })

  test('coalesces concurrent work but permits an explicit same-job retry after failure', async () => {
    const provider = fake('retryable', [{ kind: 'throw' }, { kind: 'evidence', evidence: evidence() }])
    const service = new OcrExtractionService([provider])
    const input = request()

    await expect(service.execute(input)).resolves.toMatchObject({ outcome: 'failure' })
    await expect(service.execute(input)).resolves.toMatchObject({
      outcome: 'evidence',
      evidence: { requiresHumanReview: false },
    })
    expect(provider.observations).toHaveLength(2)
  })

  test('deep-freezes canonical request identity before an untrusted provider receives it', async () => {
    const mutationSucceeded = []
    const mutationBlocked = []
    const malicious = {
      provider: 'mutating',
      model: 'mutating-v1',
      extract: async (providerRequest) => {
        try {
          providerRequest.requestId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
          mutationSucceeded.push('requestId')
        } catch {
          mutationBlocked.push('requestId')
        }
        try {
          providerRequest.input.contentHash = 'b'.repeat(64)
          mutationSucceeded.push('contentHash')
        } catch {
          mutationBlocked.push('contentHash')
        }
        return {
          requestId: providerRequest.requestId,
          task: providerRequest.task,
          provider: 'mutating',
          model: 'mutating-v1',
          schemaVersion: providerRequest.schemaVersion,
          promptVersion: providerRequest.promptVersion,
          inputVersion: providerRequest.inputVersion,
          provenance: {
            source: 'ocr_provider',
            providerRequestId: 'mutation-attempt',
            producedAt: '2030-01-01T00:00:00.000Z',
          },
          outcome: 'evidence',
          evidence: evidence(),
        }
      },
    }
    const input = request()

    await expect(new OcrExtractionService([malicious]).execute(input)).resolves.toMatchObject({
      requestId: input.requestId,
      outcome: 'evidence',
      evidence: { requiresHumanReview: false },
    })
    expect(mutationSucceeded).toEqual([])
    expect(mutationBlocked).toEqual(['requestId', 'contentHash'])
    expect(input.input.contentHash).toBe('a'.repeat(64))
  })

  test('returns a recursively immutable cached result so caller mutation cannot corrupt replay', async () => {
    const provider = fake('immutable-result', [{ kind: 'evidence', evidence: evidence('원본 매장') }])
    const service = new OcrExtractionService([provider])
    const input = request()
    const first = await service.execute(input)

    expect(first).toMatchObject({
      outcome: 'evidence',
      evidence: {
        businessName: { value: '원본 매장' },
        requiresHumanReview: false,
      },
    })
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.provenance)).toBe(true)
    expect(Object.isFrozen(first.evidence)).toBe(true)
    expect(Object.isFrozen(first.evidence.businessName)).toBe(true)
    expect(Object.isFrozen(first.evidence.missingFields)).toBe(true)
    expect(Reflect.set(first.evidence.businessName, 'value', '호출자 변경')).toBe(false)
    expect(() => first.evidence.missingFields.push('businessName')).toThrow(TypeError)

    const replay = await service.execute(input)
    expect(replay).toBe(first)
    expect(replay.evidence.businessName.value).toBe('원본 매장')
    expect(provider.observations).toHaveLength(1)
  })

  test.each([
    ['secure attachment reference', (input) => input.input.secureAttachmentReference],
    ['content hash', (input) => input.input.contentHash],
  ])('rejects a provider result that echoes the %s', async (_label, leakedValue) => {
    const provider = {
      provider: 'echoing-provider',
      model: 'echoing-provider-v1',
      extract: async (providerRequest) => ({
        requestId: providerRequest.requestId,
        task: providerRequest.task,
        provider: 'echoing-provider',
        model: 'echoing-provider-v1',
        schemaVersion: providerRequest.schemaVersion,
        promptVersion: providerRequest.promptVersion,
        inputVersion: providerRequest.inputVersion,
        provenance: {
          source: 'ocr_provider',
          providerRequestId: 'echo-check',
          producedAt: '2030-01-01T00:00:00.000Z',
        },
        outcome: 'evidence',
        evidence: evidence(leakedValue(providerRequest)),
      }),
    }

    await expect(new OcrExtractionService([provider]).execute(request())).resolves.toMatchObject({
      outcome: 'failure',
      reasonCode: OCR_ORCHESTRATION_REASON.PROVIDER_INVALID_RESULT,
      retryable: false,
    })
  })

  test('rejects request-id content conflicts and never returns protected workflow commands', async () => {
    const provider = fake('only', [{ kind: 'evidence', evidence: evidence() }])
    const service = new OcrExtractionService([provider])
    const input = request()
    const result = await service.execute(input)

    expect(() => service.execute({ ...input, input: { ...input.input, contentHash: 'b'.repeat(64) } })).toThrow(
      /OCR_REQUEST_ID_CONTENT_MISMATCH/,
    )
    expect(JSON.stringify(result)).not.toMatch(
      /selectionState|consentState|reservationState|businessApprovalState|guidelineState|toolCalls/,
    )
  })

  test('fails closed when no provider is configured or the time budget is invalid', async () => {
    await expect(new OcrExtractionService([]).execute(request())).resolves.toMatchObject({
      outcome: 'failure',
      reasonCode: OCR_ORCHESTRATION_REASON.PROVIDER_CASCADE_EXHAUSTED,
    })
    expect(() => new OcrExtractionService([], { providerTimeoutMs: 0 })).toThrow(RangeError)
    expect(() => new OcrExtractionService([], { providerTimeoutMs: 2_147_483_648 })).toThrow(RangeError)
  })
})

describe('T133 bounded OCR idempotency retention', () => {
  const evidenceSteps = (count) => Array.from({ length: count }, () => ({ kind: 'evidence', evidence: evidence() }))
  const requestId = (suffix) => `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${suffix}`

  test('evicts the oldest request identity once the configured size bound is reached', async () => {
    const provider = fake('bounded', evidenceSteps(6))
    const service = new OcrExtractionService([provider], { idempotency: { maximumEntries: 2 } })
    const first = request(requestId('1'))

    await service.execute(first)
    await service.execute(request(requestId('2')))
    expect(provider.observations).toHaveLength(2)

    await service.execute(first)
    expect(provider.observations).toHaveLength(2)

    await service.execute(request(requestId('3')))
    expect(provider.observations).toHaveLength(3)

    await service.execute(first)
    expect(provider.observations).toHaveLength(4)
  })

  test('stops retaining evidence and its fingerprint together once the retention window passes', async () => {
    let now = 1_000
    const provider = fake('expiring', evidenceSteps(4))
    const service = new OcrExtractionService([provider], {
      idempotency: { retentionMs: 60_000 },
      clock: () => now,
    })
    const input = request()

    await service.execute(input)
    await service.execute(input)
    expect(provider.observations).toHaveLength(1)
    expect(() => service.execute({ ...input, input: { ...input.input, contentHash: 'b'.repeat(64) } })).toThrow(
      /OCR_REQUEST_ID_CONTENT_MISMATCH/,
    )

    now += 60_000
    await expect(service.execute(input)).resolves.toMatchObject({ outcome: 'evidence' })
    expect(provider.observations).toHaveLength(2)
  })

  test('releases the retained fingerprint with the retained result, never one without the other', async () => {
    let now = 5_000
    const provider = fake('coherent', evidenceSteps(3))
    const service = new OcrExtractionService([provider], {
      idempotency: { retentionMs: 30_000 },
      clock: () => now,
    })
    const input = request()

    await service.execute(input)
    now += 30_000
    await expect(
      service.execute({ ...input, input: { ...input.input, contentHash: 'c'.repeat(64) } }),
    ).resolves.toMatchObject({ outcome: 'evidence' })
    expect(provider.observations).toHaveLength(2)
  })

  test('rejects an unusable retention policy instead of retaining evidence without a bound', () => {
    expect(() => new OcrExtractionService([], { idempotency: { maximumEntries: 0 } })).toThrow(RangeError)
    expect(() => new OcrExtractionService([], { idempotency: { retentionMs: 0 } })).toThrow(RangeError)
    expect(() => new OcrExtractionService([], { idempotency: { maximumEntries: 1.5 } })).toThrow(RangeError)
  })
})
