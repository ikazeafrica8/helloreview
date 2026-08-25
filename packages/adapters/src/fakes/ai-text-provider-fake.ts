import { randomUUID } from 'node:crypto'
import { aiResultSchema, type AiEvidence, type AiRequest, type AiResult } from '@helloreview/contracts'
import type { AiTextProvider } from '../ports/ai-text-provider.js'

export type FakeAiProviderStep =
  | Readonly<{ kind: 'evidence'; evidence: AiEvidence }>
  | Readonly<{ kind: 'refused'; reasonCode: string }>
  | Readonly<{ kind: 'failure'; reasonCode: string; retryable: boolean }>
  | Readonly<{ kind: 'throw'; message?: string }>
  | Readonly<{ kind: 'delay'; milliseconds: number; then: Exclude<FakeAiProviderStep, { kind: 'delay' }> }>

export type FakeAiProvider = AiTextProvider &
  Readonly<{ observations: readonly Readonly<{ requestId: string; task: string; schemaVersion: string }>[] }>

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })

export const createFakeAiTextProvider = (
  input: Readonly<{
    provider: string
    model: string
    steps: readonly FakeAiProviderStep[]
    clock?: () => Date
  }>,
): FakeAiProvider => {
  const observations: Readonly<{ requestId: string; task: string; schemaVersion: string }>[] = []
  let nextStep = 0
  const clock = input.clock ?? (() => new Date())

  const resolveStep = (request: AiRequest, step: Exclude<FakeAiProviderStep, { kind: 'delay' }>): Promise<AiResult> =>
    Promise.resolve().then(() => {
      if (step.kind === 'throw') throw new Error(step.message ?? 'fake AI provider failure')
      const metadata = {
        requestId: request.requestId,
        task: request.task,
        provider: input.provider,
        model: input.model,
        schemaVersion: request.schemaVersion,
        promptVersion: request.promptVersion,
        inputVersion: request.inputVersion,
        provenance: {
          source: 'ai_provider' as const,
          providerRequestId: `fake-${randomUUID()}`,
          producedAt: clock().toISOString(),
        },
      }
      const raw: AiResult =
        step.kind === 'evidence'
          ? { ...metadata, outcome: 'evidence', evidence: step.evidence }
          : step.kind === 'refused'
            ? { ...metadata, outcome: 'refused', reasonCode: step.reasonCode, requiresHumanReview: true }
            : {
                ...metadata,
                outcome: 'failure',
                reasonCode: step.reasonCode,
                retryable: step.retryable,
                requiresHumanReview: true,
              }
      return aiResultSchema.parse(raw)
    })

  const execute = async (request: AiRequest): Promise<AiResult> => {
    observations.push({ requestId: request.requestId, task: request.task, schemaVersion: request.schemaVersion })
    const step = input.steps[nextStep] ?? { kind: 'failure', reasonCode: 'FAKE_PLAN_EXHAUSTED', retryable: false }
    nextStep += 1
    if (step.kind === 'delay') {
      await wait(step.milliseconds)
      return resolveStep(request, step.then)
    }
    return resolveStep(request, step)
  }

  return Object.freeze({ provider: input.provider, model: input.model, execute, observations })
}

export const createUnavailableAiTextProvider = (): AiTextProvider =>
  createFakeAiTextProvider({
    provider: 'unconfigured',
    model: 'none',
    steps: [{ kind: 'failure', reasonCode: 'AI_PROVIDER_NOT_CONFIGURED', retryable: false }],
  })
