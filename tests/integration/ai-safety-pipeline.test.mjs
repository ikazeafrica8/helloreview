import { randomUUID } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { createFakeAiTextProvider } from '../../packages/adapters/dist/index.js'
import {
  AiBudgetLedger,
  AiOrchestrationService,
  KoreanIntentPipeline,
} from '../../apps/api/dist/modules/ai-orchestration/index.js'

const evidence = (intentCode, confidence = 0.99) => ({
  task: 'intent_classification',
  intentCode,
  confidence,
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
})

const input = (text, scope = randomUUID()) => ({
  requestId: randomUUID(),
  budgetScope: scope,
  text,
  operatorOwned: false,
  schemaVersion: 'kakao-intent-v1',
  promptVersion: 'intent-prompt-v1',
  inputVersion: 'message-v1',
})

const confidencePolicy = {
  clarificationMinimum: 0.6,
  automationMinimum: 0.85,
  sensitiveAutomationMinimum: 0.95,
}

const generousBudget = {
  maximumInputCharacters: 8_000,
  maximumEstimatedTokensPerRequest: 8_000,
  maximumEstimatedTokensPerScope: 80_000,
  maximumEstimatedCostMicrosPerRequest: 20_000,
  maximumEstimatedCostMicrosPerScope: 200_000,
  estimatedCostMicrosPerThousandTokens: 1_000,
}

describe('T66 budget, invalid-output, and fallback integration', () => {
  test('budget exhaustion prevents the external boundary from being invoked', async () => {
    const provider = createFakeAiTextProvider({
      provider: 'must-not-run',
      model: 'fixture-v1',
      steps: [{ kind: 'evidence', evidence: evidence('APPLICATION_REQUEST') }],
    })
    const pipeline = new KoreanIntentPipeline(
      new AiOrchestrationService([provider]),
      new AiBudgetLedger({ ...generousBudget, maximumInputCharacters: 10 }),
      confidencePolicy,
    )
    await expect(pipeline.classify(input('신청을 완료했다고 알려드립니다'))).resolves.toMatchObject({
      route: 'human_review',
      reasonCode: 'AI_INPUT_BUDGET_EXCEEDED',
    })
    expect(provider.observations).toHaveLength(0)
  })

  test('invalid primary output is discarded and a schema-valid secondary result is evidence only', async () => {
    const hostile = {
      provider: 'hostile',
      model: 'hostile-v1',
      execute: async (request) => ({
        requestId: request.requestId,
        task: request.task,
        provider: 'hostile',
        model: 'hostile-v1',
        schemaVersion: request.schemaVersion,
        promptVersion: request.promptVersion,
        inputVersion: request.inputVersion,
        provenance: {
          source: 'ai_provider',
          providerRequestId: 'hostile-1',
          producedAt: '2026-08-25T00:00:00.000Z',
        },
        outcome: 'evidence',
        evidence: { ...evidence('APPLICATION_COMPLETED_CLAIM'), reservationState: 'valid' },
      }),
    }
    const fallback = createFakeAiTextProvider({
      provider: 'safe-secondary',
      model: 'fixture-v2',
      steps: [{ kind: 'evidence', evidence: evidence('APPLICATION_COMPLETED_CLAIM') }],
    })
    const decision = await new KoreanIntentPipeline(
      new AiOrchestrationService([hostile, fallback]),
      new AiBudgetLedger(generousBudget),
      confidencePolicy,
    ).classify(input('신청 완료했어요'))
    expect(decision).toMatchObject({
      route: 'deterministic_validation',
      source: 'ai_provider',
      provenance: { provider: 'safe-secondary', model: 'fixture-v2' },
    })
    expect(decision).not.toHaveProperty('reservationState')
  })

  test('timeout and repeated failure preserve the request and fall back safely', async () => {
    const slow = createFakeAiTextProvider({
      provider: 'slow',
      model: 'slow-v1',
      steps: [
        {
          kind: 'delay',
          milliseconds: 2_100,
          then: { kind: 'evidence', evidence: evidence('GUIDELINE_REQUEST') },
        },
      ],
    })
    const failed = createFakeAiTextProvider({ provider: 'failed', model: 'failed-v1', steps: [{ kind: 'throw' }] })
    const pipeline = new KoreanIntentPipeline(
      new AiOrchestrationService([slow, failed]),
      new AiBudgetLedger(generousBudget),
      confidencePolicy,
    )
    await expect(pipeline.classify(input('가이드 안내문을 보내 주세요'))).resolves.toMatchObject({
      route: 'deterministic_validation',
      source: 'deterministic_fallback',
      evidence: { intentCode: 'GUIDELINE_REQUEST' },
    })
  })
})
