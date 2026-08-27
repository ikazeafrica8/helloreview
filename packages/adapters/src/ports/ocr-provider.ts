import type { OcrRequest, OcrResult } from '@helloreview/contracts'

/** Injection token for a provider selected only by an approved composition root. */
export const OCR_PROVIDER = Symbol('OCR_PROVIDER')

export type OcrProviderExecutionOptions = Readonly<{
  signal?: AbortSignal
}>

/** Providers receive immutable, minimum-context request data. */
export type OcrProviderRequest = Readonly<Omit<OcrRequest, 'input'> & { input: Readonly<OcrRequest['input']> }>

/** A provider-neutral abort classification used when an orchestration time budget expires. */
export class OcrProviderAbortedError extends Error {
  override readonly name = 'OcrProviderAbortedError'
  readonly reasonCode = 'OCR_PROVIDER_ABORTED'

  constructor() {
    super('OCR provider operation was aborted')
  }
}

/**
 * Provider-neutral OCR boundary.
 *
 * The request contains an already-approved secure attachment reference, never image bytes. A
 * provider may return only the strict, allowlisted OCR result contract; it has no tools and no
 * authority to mutate workflow state.
 */
export type OcrProvider = Readonly<{
  provider: string
  model: string
  extract: (request: OcrProviderRequest, options?: OcrProviderExecutionOptions) => Promise<OcrResult>
}>
