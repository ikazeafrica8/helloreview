import { ocrRequestSchema, ocrResultSchema, type OcrRequest } from '@helloreview/contracts'
import { OcrProviderAbortedError, type OcrProvider } from '../ports/ocr-provider.js'

export type OcrProviderConformanceCheck = Readonly<{ name: string; run: () => Promise<void> }>

export type OcrProviderConformanceFixtures = Readonly<{
  createProvider: () => OcrProvider
  createAbortableProvider: () => OcrProvider
  request: OcrRequest
  /** Optional adapter-specific assertion that a pre-aborted call left no observable state. */
  assertPreAbortedState?: (provider: OcrProvider) => void
}>

const expectTrue = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(message)
}

const expectSameString = (actual: string, expected: string, message: string): void => {
  expectTrue(actual === expected, message)
}

/** Behaviour the deterministic fake and every future approved OCR adapter must preserve. */
export const ocrProviderConformanceChecks = ({
  createProvider,
  createAbortableProvider,
  request: rawRequest,
  assertPreAbortedState,
}: OcrProviderConformanceFixtures): readonly OcrProviderConformanceCheck[] => {
  const request = ocrRequestSchema.parse(rawRequest)
  return [
    {
      name: 'returns only a strict OCR result from a named provider and model',
      run: async () => {
        const provider = createProvider()
        expectTrue(provider.provider.length > 0, 'an OCR provider must name itself')
        expectTrue(provider.model.length > 0, 'an OCR provider must name its model')
        const result = ocrResultSchema.parse(await provider.extract(request))
        expectTrue(result.provider === provider.provider, 'result provider does not match the adapter')
        expectTrue(result.model === provider.model, 'result model does not match the adapter')
      },
    },
    {
      name: 'preserves request identity and every contract version',
      run: async () => {
        const result = ocrResultSchema.parse(await createProvider().extract(request))
        expectSameString(result.requestId, request.requestId, 'OCR result changed the request identity')
        expectSameString(result.task, request.task, 'OCR result changed the task')
        expectSameString(result.schemaVersion, request.schemaVersion, 'OCR result changed the schema version')
        expectSameString(result.promptVersion, request.promptVersion, 'OCR result changed the prompt version')
        expectSameString(result.inputVersion, request.inputVersion, 'OCR result changed the input version')
      },
    },
    {
      name: 'does not echo secure attachment material into the result',
      run: async () => {
        const resultText = JSON.stringify(await createProvider().extract(request))
        expectTrue(
          !resultText.includes(request.input.secureAttachmentReference),
          'OCR result exposed the secure attachment reference',
        )
        expectTrue(!resultText.includes(request.input.contentHash), 'OCR result exposed the content hash')
      },
    },
    {
      name: 'does not mutate the provider-neutral request',
      run: async () => {
        const before = JSON.stringify(request)
        await createProvider().extract(request)
        expectTrue(JSON.stringify(request) === before, 'OCR adapter mutated its request')
      },
    },
    {
      name: 'honours a pre-aborted provider request',
      run: async () => {
        const provider = createProvider()
        const abortController = new AbortController()
        abortController.abort()
        let caught: unknown
        try {
          await provider.extract(request, { signal: abortController.signal })
        } catch (error) {
          caught = error
        }
        expectTrue(caught instanceof OcrProviderAbortedError, 'OCR adapter ignored or misclassified abort')
        assertPreAbortedState?.(provider)
      },
    },
    {
      name: 'honours an in-flight abort and prevents late completion',
      run: async () => {
        const abortController = new AbortController()
        const pending = createAbortableProvider().extract(request, { signal: abortController.signal })
        abortController.abort()
        let caught: unknown
        try {
          await pending
        } catch (error) {
          caught = error
        }
        expectTrue(caught instanceof OcrProviderAbortedError, 'OCR adapter continued after an in-flight abort')
      },
    },
  ]
}
