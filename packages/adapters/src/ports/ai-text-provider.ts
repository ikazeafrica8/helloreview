import type { AiRequest, AiResult } from '@helloreview/contracts'

export const AI_PROVIDER_CASCADE = Symbol('AI_PROVIDER_CASCADE')

export type AiTextProvider = Readonly<{
  provider: string
  model: string
  execute: (request: AiRequest) => Promise<AiResult>
}>
