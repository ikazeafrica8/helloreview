import { Module } from '@nestjs/common'
import { AI_PROVIDER_CASCADE, createUnavailableAiTextProvider } from '@helloreview/adapters'
import { AiBudgetLedger } from './ai-budget.js'
import { AiOrchestrationService } from './ai-orchestration.service.js'
import { KoreanDateTimePipeline } from './korean-date-time-pipeline.js'

@Module({
  providers: [
    {
      provide: AI_PROVIDER_CASCADE,
      useFactory: () => [createUnavailableAiTextProvider()],
    },
    {
      provide: AiOrchestrationService,
      inject: [AI_PROVIDER_CASCADE],
      useFactory: (providers: ReturnType<typeof createUnavailableAiTextProvider>[]) =>
        new AiOrchestrationService(providers),
    },
    {
      provide: AiBudgetLedger,
      useFactory: () =>
        new AiBudgetLedger({
          maximumInputCharacters: 1_000,
          maximumEstimatedTokensPerRequest: 1_000,
          maximumEstimatedTokensPerScope: 10_000,
          maximumEstimatedCostMicrosPerRequest: 10_000,
          maximumEstimatedCostMicrosPerScope: 100_000,
          estimatedCostMicrosPerThousandTokens: 10_000,
        }),
    },
    {
      provide: KoreanDateTimePipeline,
      inject: [AiOrchestrationService, AiBudgetLedger],
      useFactory: (orchestration: AiOrchestrationService, budget: AiBudgetLedger) =>
        new KoreanDateTimePipeline(orchestration, budget, { now: () => new Date() }),
    },
  ],
  exports: [AiOrchestrationService, KoreanDateTimePipeline, AI_PROVIDER_CASCADE],
})
export class AiOrchestrationModule {}
