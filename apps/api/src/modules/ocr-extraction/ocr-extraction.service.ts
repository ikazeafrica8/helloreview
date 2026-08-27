import { createHash } from 'node:crypto'
import type { OcrProvider } from '@helloreview/adapters'
import {
  ocrRequestSchema,
  ocrResultSchema,
  type OcrRequest,
  type OcrResult,
  type OcrResultReasonCode,
} from '@helloreview/contracts'
import { OCR_ORCHESTRATION_REASON } from './reason-codes.js'

export class OcrExtractionError extends Error {
  override readonly name = 'OcrExtractionError'

  constructor(readonly reasonCode: string) {
    super(`OCR extraction rejected: ${reasonCode}`)
  }
}

export type OcrExtractionServiceOptions = Readonly<{
  /** Per-provider time budget. A conforming provider must honour the abort signal. */
  providerTimeoutMs?: number
  /** Independent evidence sources, distinct from the ordered primary/fallback chain. */
  comparisonProviders?: readonly OcrProvider[]
}>

type ProviderAttempt =
  | Readonly<{
      kind: 'evidence'
      result: Extract<OcrResult, { outcome: 'evidence' }>
      source: OcrProvider
      identity: ProviderIdentity
    }>
  | Readonly<{ kind: 'refused' }>
  | Readonly<{ kind: 'failure'; reasonCode: OcrResultReasonCode }>

type ProviderIdentity = Readonly<{ provider: string; model: string }>

const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647

class ProviderTimeoutError extends Error {
  override readonly name = 'ProviderTimeoutError'
}

const fingerprint = (request: OcrRequest): string => createHash('sha256').update(JSON.stringify(request)).digest('hex')

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

const sameEvidence = (
  left: Extract<OcrResult, { outcome: 'evidence' }>,
  right: Extract<OcrResult, { outcome: 'evidence' }>,
): boolean => JSON.stringify(left.evidence) === JSON.stringify(right.evidence)

const matchesRequestAndProvider = (result: OcrResult, request: OcrRequest, provider: ProviderIdentity): boolean =>
  result.requestId === request.requestId &&
  result.promptVersion === request.promptVersion &&
  result.inputVersion === request.inputVersion &&
  result.provider === provider.provider &&
  result.model === provider.model &&
  result.provenance.source === 'ocr_provider'

const exposesSensitiveInput = (result: OcrResult, request: OcrRequest): boolean => {
  const serialized = JSON.stringify(result)
  return serialized.includes(request.input.secureAttachmentReference) || serialized.includes(request.input.contentHash)
}

const readProviderIdentity = (provider: OcrProvider): ProviderIdentity | undefined => {
  try {
    const providerName = provider.provider
    const model = provider.model
    return typeof providerName === 'string' && typeof model === 'string'
      ? Object.freeze({ provider: providerName, model })
      : undefined
  } catch {
    return undefined
  }
}

const providerIdentityKey = (identity: ProviderIdentity): string => JSON.stringify([identity.provider, identity.model])

const withTimeout = async (provider: OcrProvider, request: OcrRequest, timeoutMs: number): Promise<OcrResult> => {
  const abortController = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    return await Promise.race([
      provider.extract(request, { signal: abortController.signal }),
      new Promise<OcrResult>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new ProviderTimeoutError('OCR provider timed out'))
          abortController.abort()
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Provider-neutral, in-memory OCR orchestration for the approved shadow boundary.
 *
 * It validates both sides of the port, uses an ordered fallback chain, optionally compares against
 * explicitly separate evidence sources, and coalesces concurrent duplicate requests. Failed
 * attempts are evicted so an explicit caller retry can reuse the same request/job ID; no retry is
 * scheduled here. It owns no repository, workflow command, queue, or readiness decision.
 */
export class OcrExtractionService {
  private readonly requests = new Map<string, Promise<OcrResult>>()
  private readonly fingerprints = new Map<string, string>()
  private readonly providers: readonly OcrProvider[]
  private readonly providerTimeoutMs: number
  private readonly comparisonProviders: readonly OcrProvider[]

  constructor(providers: readonly OcrProvider[], options: OcrExtractionServiceOptions = {}) {
    this.providers = Object.freeze([...providers])
    this.providerTimeoutMs = options.providerTimeoutMs ?? 2_000
    this.comparisonProviders = Object.freeze([...(options.comparisonProviders ?? [])])
    if (
      !Number.isSafeInteger(this.providerTimeoutMs) ||
      this.providerTimeoutMs <= 0 ||
      this.providerTimeoutMs > MAX_NODE_TIMER_DELAY_MS
    ) {
      throw new RangeError('providerTimeoutMs must be within the supported positive Node.js timer range')
    }
  }

  execute(rawRequest: OcrRequest): Promise<OcrResult> {
    const request = deepFreeze(ocrRequestSchema.parse(rawRequest))
    const requestFingerprint = fingerprint(request)
    const knownFingerprint = this.fingerprints.get(request.requestId)
    if (knownFingerprint !== undefined && knownFingerprint !== requestFingerprint) {
      throw new OcrExtractionError(OCR_ORCHESTRATION_REASON.REQUEST_CONFLICT)
    }

    const existing = this.requests.get(request.requestId)
    if (existing !== undefined) return existing

    this.fingerprints.set(request.requestId, requestFingerprint)
    const result = this.runProviders(request).then((outcome) => {
      if (outcome.outcome === 'failure') this.requests.delete(request.requestId)
      return deepFreeze(ocrResultSchema.parse(outcome))
    })
    this.requests.set(request.requestId, result)
    return result
  }

  private async attemptProvider(
    provider: OcrProvider,
    request: OcrRequest,
    knownIdentity?: ProviderIdentity,
  ): Promise<ProviderAttempt> {
    const providerIdentity = knownIdentity ?? readProviderIdentity(provider)
    if (providerIdentity === undefined) {
      return { kind: 'failure', reasonCode: OCR_ORCHESTRATION_REASON.PROVIDER_UNAVAILABLE }
    }

    let rawResult: OcrResult
    try {
      rawResult = await withTimeout(provider, request, this.providerTimeoutMs)
    } catch (error) {
      return {
        kind: 'failure',
        reasonCode:
          error instanceof ProviderTimeoutError
            ? OCR_ORCHESTRATION_REASON.PROVIDER_TIMEOUT
            : OCR_ORCHESTRATION_REASON.PROVIDER_UNAVAILABLE,
      }
    }

    const parsedResult = ocrResultSchema.safeParse(rawResult)
    if (!parsedResult.success) {
      return { kind: 'failure', reasonCode: OCR_ORCHESTRATION_REASON.PROVIDER_INVALID_RESULT }
    }

    const result = parsedResult.data
    if (exposesSensitiveInput(result, request) || !matchesRequestAndProvider(result, request, providerIdentity)) {
      return { kind: 'failure', reasonCode: OCR_ORCHESTRATION_REASON.PROVIDER_INVALID_RESULT }
    }
    if (result.outcome === 'evidence') {
      return { kind: 'evidence', result, source: provider, identity: providerIdentity }
    }
    if (result.outcome === 'refused') return { kind: 'refused' }
    return { kind: 'failure', reasonCode: OCR_ORCHESTRATION_REASON.PROVIDER_UNAVAILABLE }
  }

  private async runProviders(request: OcrRequest): Promise<OcrResult> {
    const failures: OcrResultReasonCode[] = []
    let accepted: ProviderAttempt | undefined

    for (const provider of this.providers) {
      const attempt = await this.attemptProvider(provider, request)
      if (attempt.kind === 'failure') {
        failures.push(attempt.reasonCode)
        continue
      }
      accepted = attempt
      break
    }

    if (accepted?.kind === 'refused') {
      return this.safeRefusal(request, OCR_ORCHESTRATION_REASON.PROVIDER_REFUSED)
    }

    if (accepted?.kind === 'evidence') {
      const seenSources = new Set<OcrProvider>([accepted.source])
      const seenIdentities = new Set<string>([providerIdentityKey(accepted.identity)])
      for (const provider of this.comparisonProviders) {
        const comparisonIdentity = readProviderIdentity(provider)
        if (
          comparisonIdentity === undefined ||
          seenSources.has(provider) ||
          seenIdentities.has(providerIdentityKey(comparisonIdentity))
        ) {
          return this.safeFailure(request, OCR_ORCHESTRATION_REASON.PROVIDER_COMPARISON_UNAVAILABLE)
        }
        seenSources.add(provider)
        seenIdentities.add(providerIdentityKey(comparisonIdentity))

        const comparison = await this.attemptProvider(provider, request, comparisonIdentity)
        if (comparison.kind === 'failure') {
          return this.safeFailure(request, OCR_ORCHESTRATION_REASON.PROVIDER_COMPARISON_UNAVAILABLE)
        }
        if (comparison.kind === 'refused' || !sameEvidence(accepted.result, comparison.result)) {
          return this.safeFailure(request, OCR_ORCHESTRATION_REASON.PROVIDER_DISAGREEMENT)
        }
      }
      // The provider flag is evidence, not an authority decision. The downstream structural
      // quality decision preserves manual operator approval and owns progression policy.
      return accepted.result
    }

    const uniqueReasons = new Set(failures)
    const reasonCode = uniqueReasons.size === 1 ? failures[0] : OCR_ORCHESTRATION_REASON.PROVIDER_CASCADE_EXHAUSTED
    return this.safeFailure(request, reasonCode ?? OCR_ORCHESTRATION_REASON.PROVIDER_CASCADE_EXHAUSTED)
  }

  private safeRefusal(request: OcrRequest, reasonCode: OcrResultReasonCode): OcrResult {
    return ocrResultSchema.parse({
      ...this.safeMetadata(request, reasonCode),
      outcome: 'refused',
      reasonCode,
      requiresHumanReview: true,
    })
  }

  private safeFailure(request: OcrRequest, reasonCode: OcrResultReasonCode): OcrResult {
    return ocrResultSchema.parse({
      ...this.safeMetadata(request, reasonCode),
      outcome: 'failure',
      reasonCode,
      // False means this service never schedules an automatic retry. A caller may make a later,
      // explicit same-request invocation after this failed attempt has been evicted.
      retryable: false,
      requiresHumanReview: true,
    })
  }

  private safeMetadata(request: OcrRequest, reasonCode: OcrResultReasonCode) {
    return {
      requestId: request.requestId,
      task: request.task,
      provider: 'none',
      model: 'none',
      schemaVersion: request.schemaVersion,
      promptVersion: request.promptVersion,
      inputVersion: request.inputVersion,
      provenance: {
        source: 'ocr_orchestrator' as const,
        providerRequestId: `safe-fallback:${reasonCode}:${request.requestId}`,
        producedAt: new Date(0).toISOString(),
      },
    }
  }
}
