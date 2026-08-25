import { createHash } from 'node:crypto'
import type { AiTextProvider } from '@helloreview/adapters'
import { aiRequestSchema, aiResultSchema, type AiRequest, type AiResult } from '@helloreview/contracts'
import { AI_ORCHESTRATION_REASON } from './reason-codes.js'

export class AiOrchestrationError extends Error {
  override readonly name = 'AiOrchestrationError'
  constructor(readonly reasonCode: string) {
    super(`AI orchestration rejected: ${reasonCode}`)
  }
}

const fingerprint = (request: AiRequest): string => createHash('sha256').update(JSON.stringify(request)).digest('hex')

const withTimeout = async (provider: AiTextProvider, request: AiRequest, timeoutMs: number): Promise<AiResult> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      provider.execute(request),
      new Promise<AiResult>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new AiOrchestrationError(AI_ORCHESTRATION_REASON.PROVIDER_TIMEOUT))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export class AiOrchestrationService {
  private readonly requests = new Map<string, Readonly<{ fingerprint: string; result: Promise<AiResult> }>>()

  constructor(private readonly providers: readonly AiTextProvider[]) {}

  execute(rawRequest: AiRequest, timeoutMs = 2_000): Promise<AiResult> {
    const request = aiRequestSchema.parse(rawRequest)
    const requestFingerprint = fingerprint(request)
    const existing = this.requests.get(request.requestId)
    if (existing !== undefined) {
      if (existing.fingerprint !== requestFingerprint) {
        throw new AiOrchestrationError(AI_ORCHESTRATION_REASON.REQUEST_CONFLICT)
      }
      return existing.result
    }
    const result = this.runCascade(request, timeoutMs)
    this.requests.set(request.requestId, { fingerprint: requestFingerprint, result })
    return result
  }

  private async runCascade(request: AiRequest, timeoutMs: number): Promise<AiResult> {
    for (const provider of this.providers) {
      try {
        const result = aiResultSchema.parse(await withTimeout(provider, request, timeoutMs))
        if (result.requestId !== request.requestId || result.task !== request.task) continue
        if (result.outcome !== 'failure') return result
      } catch {
        // Provider errors, timeouts, and invalid shapes remain evidence of failure only.
      }
    }
    return aiResultSchema.parse({
      requestId: request.requestId,
      task: request.task,
      provider: 'none',
      model: 'none',
      schemaVersion: request.schemaVersion,
      promptVersion: request.promptVersion,
      inputVersion: request.inputVersion,
      provenance: {
        source: 'ai_provider',
        providerRequestId: `cascade-exhausted:${request.requestId}`,
        producedAt: new Date(0).toISOString(),
      },
      outcome: 'failure',
      reasonCode: AI_ORCHESTRATION_REASON.PROVIDER_CASCADE_EXHAUSTED,
      retryable: false,
      requiresHumanReview: true,
    })
  }
}
