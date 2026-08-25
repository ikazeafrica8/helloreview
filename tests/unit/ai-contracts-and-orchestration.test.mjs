import { randomUUID } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { AI_PROTECTED_STATE_BOUNDARY, aiRequestSchema, aiResultSchema } from '../../packages/contracts/dist/index.js'
import { createFakeAiTextProvider } from '../../packages/adapters/dist/index.js'
import { AiOrchestrationService } from '../../apps/api/dist/modules/ai-orchestration/ai-orchestration.service.js'

const request = (requestId = randomUUID()) => ({
  requestId,
  task: 'intent_classification',
  schemaVersion: 'kakao-intent-v1',
  promptVersion: 'intent-prompt-v1',
  inputVersion: 'message-v1',
  input: { text: '신청 완료했어요', locale: 'ko-KR', timezone: 'Asia/Seoul' },
})

const evidence = {
  task: 'intent_classification',
  intentCode: 'APPLICATION_COMPLETED_CLAIM',
  confidence: 0.94,
  entities: {
    participantName: null,
    phoneNumber: null,
    campaignName: null,
    reservationDateText: null,
    reservationTimeText: null,
    businessName: null,
  },
  ambiguities: [],
  requiresClarification: false,
  requiresHumanReview: false,
}

describe('T62 strict evidence-only AI contracts', () => {
  test('rejects unknown request and result fields', async () => {
    expect(() => aiRequestSchema.parse({ ...request(), selectionState: 'auto_selected' })).toThrow()
    const provider = createFakeAiTextProvider({
      provider: 'fake',
      model: 'fake-v1',
      steps: [{ kind: 'evidence', evidence }],
    })
    const result = await provider.execute(request())
    expect(() => aiResultSchema.parse({ ...result, rawModelOutput: 'hidden' })).toThrow()
  })

  test('has a compile-time and runtime protected-state boundary', () => {
    expect(AI_PROTECTED_STATE_BOUNDARY).toBe(true)
    expect(Object.keys(evidence)).not.toEqual(
      expect.arrayContaining(['selectionState', 'consentState', 'reservationState', 'guidelineState']),
    )
  })
})

describe('T63 provider-neutral cascade', () => {
  test('falls back after timeout, preserves request identity, and is idempotent', async () => {
    const slow = createFakeAiTextProvider({
      provider: 'slow',
      model: 'slow-v1',
      steps: [{ kind: 'delay', milliseconds: 30, then: { kind: 'evidence', evidence } }],
    })
    const fallback = createFakeAiTextProvider({
      provider: 'fallback',
      model: 'fallback-v1',
      steps: [{ kind: 'evidence', evidence }],
    })
    const service = new AiOrchestrationService([slow, fallback])
    const input = request()
    const [first, replay] = await Promise.all([service.execute(input, 5), service.execute(input, 5)])
    expect(first).toEqual(replay)
    expect(first).toMatchObject({ requestId: input.requestId, provider: 'fallback', outcome: 'evidence' })
    expect(slow.observations).toHaveLength(1)
    expect(fallback.observations).toHaveLength(1)
  })

  test('fails closed after cascade exhaustion and rejects request-id content conflicts', async () => {
    const failed = createFakeAiTextProvider({
      provider: 'failed',
      model: 'failed-v1',
      steps: [{ kind: 'throw' }],
    })
    const service = new AiOrchestrationService([failed])
    const input = request()
    await expect(service.execute(input)).resolves.toMatchObject({
      requestId: input.requestId,
      outcome: 'failure',
      reasonCode: 'AI_PROVIDER_CASCADE_EXHAUSTED',
      requiresHumanReview: true,
    })
    expect(() => service.execute({ ...input, input: { ...input.input, text: 'changed' } })).toThrow(
      /AI_REQUEST_ID_CONTENT_MISMATCH/,
    )
  })
})
