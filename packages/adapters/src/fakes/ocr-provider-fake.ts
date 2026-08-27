import {
  ocrExtractionEvidenceSchema,
  ocrRequestSchema,
  ocrResultSchema,
  type OcrExtractionEvidence,
  type OcrRequest,
  type OcrResult,
  type OcrResultReasonCode,
} from '@helloreview/contracts'
import { OcrProviderAbortedError, type OcrProvider } from '../ports/ocr-provider.js'
import type { OcrProviderExecutionOptions, OcrProviderRequest } from '../ports/ocr-provider.js'

type NonDelayFakeOcrProviderStep =
  | Readonly<{ kind: 'evidence'; evidence: OcrExtractionEvidence }>
  | Readonly<{ kind: 'refused'; reasonCode: OcrResultReasonCode }>
  | Readonly<{ kind: 'failure'; reasonCode: OcrResultReasonCode; retryable: boolean }>
  | Readonly<{ kind: 'throw'; message?: string }>

export type FakeOcrProviderStep =
  NonDelayFakeOcrProviderStep | Readonly<{ kind: 'delay'; milliseconds: number; then: NonDelayFakeOcrProviderStep }>

/** Deliberately excludes the complete input object, attachment reference, hash, media, and content. */
export type OcrProviderObservation = Readonly<{
  requestId: string
  task: OcrRequest['task']
  schemaVersion: string
  promptVersion: string
  inputVersion: string
}>

export type FakeOcrProvider = OcrProvider &
  Readonly<{
    readonly observations: readonly OcrProviderObservation[]
  }>

export type FakeOcrProviderOptions = Readonly<{
  provider: string
  model: string
  steps: readonly FakeOcrProviderStep[]
  /** Used after the script is exhausted. Defaults to a non-retryable safe failure. */
  defaultStep?: NonDelayFakeOcrProviderStep
  clock?: () => Date
}>

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted === true) throw new OcrProviderAbortedError()
}

const wait = (milliseconds: number, signal: AbortSignal | undefined): Promise<void> => {
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer)
      reject(new OcrProviderAbortedError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

const DEFAULT_PRODUCED_AT = new Date('2026-01-01T00:00:00.000Z')

/**
 * Deterministic scripted OCR fake. It validates both sides of the provider boundary and records
 * request metadata only, so tests cannot accidentally retain screenshot references or content.
 */
export const createFakeOcrProvider = (options: FakeOcrProviderOptions): FakeOcrProvider => {
  const observations: OcrProviderObservation[] = []
  const provider = options.provider
  const model = options.model
  const cloneStep = (step: NonDelayFakeOcrProviderStep): NonDelayFakeOcrProviderStep =>
    step.kind === 'evidence'
      ? { kind: 'evidence', evidence: ocrExtractionEvidenceSchema.parse(step.evidence) }
      : { ...step }
  const steps = options.steps.map((step): FakeOcrProviderStep =>
    step.kind === 'delay'
      ? { kind: 'delay', milliseconds: step.milliseconds, then: cloneStep(step.then) }
      : cloneStep(step),
  )
  const clock = options.clock ?? (() => DEFAULT_PRODUCED_AT)
  const defaultStep = cloneStep(
    options.defaultStep ?? {
      kind: 'failure',
      reasonCode: 'OCR_FAKE_PLAN_EXHAUSTED',
      retryable: false,
    },
  )
  let nextStep = 0

  const resolveStep = (
    request: OcrRequest,
    step: NonDelayFakeOcrProviderStep,
    providerRequestId: string,
    signal: AbortSignal | undefined,
  ): Promise<OcrResult> =>
    Promise.resolve().then(() => {
      throwIfAborted(signal)
      if (step.kind === 'throw') throw new Error(step.message ?? 'fake OCR provider failure')

      const metadata = {
        requestId: request.requestId,
        task: request.task,
        provider,
        model,
        schemaVersion: request.schemaVersion,
        promptVersion: request.promptVersion,
        inputVersion: request.inputVersion,
        provenance: {
          source: 'ocr_provider' as const,
          providerRequestId,
          producedAt: clock().toISOString(),
        },
      }
      const result: OcrResult =
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

      return ocrResultSchema.parse(result)
    })

  const extract = async (
    rawRequest: OcrProviderRequest,
    executionOptions: OcrProviderExecutionOptions = {},
  ): Promise<OcrResult> => {
    // A request that was already cancelled never crosses the fake boundary: it must not consume
    // a scripted response or create even a metadata-only observation.
    throwIfAborted(executionOptions.signal)
    const request = ocrRequestSchema.parse(rawRequest)
    throwIfAborted(executionOptions.signal)
    const callNumber = nextStep + 1
    const scriptedStep = steps[nextStep]
    nextStep += 1
    observations.push(
      Object.freeze({
        requestId: request.requestId,
        task: request.task,
        schemaVersion: request.schemaVersion,
        promptVersion: request.promptVersion,
        inputVersion: request.inputVersion,
      }),
    )

    const step = scriptedStep ?? defaultStep
    if (step.kind === 'delay') {
      await wait(step.milliseconds, executionOptions.signal)
      return resolveStep(request, step.then, `fake-ocr-${String(callNumber)}`, executionOptions.signal)
    }
    return resolveStep(request, step, `fake-ocr-${String(callNumber)}`, executionOptions.signal)
  }

  return Object.freeze({
    provider,
    model,
    extract,
    get observations(): readonly OcrProviderObservation[] {
      return Object.freeze([...observations])
    },
  })
}

/** Production-safe default: consistently reports that no OCR provider has been configured. */
export const createUnavailableOcrProvider = (): FakeOcrProvider =>
  createFakeOcrProvider({
    provider: 'unconfigured',
    model: 'none',
    steps: [],
    defaultStep: { kind: 'failure', reasonCode: 'OCR_PROVIDER_NOT_CONFIGURED', retryable: false },
  })
