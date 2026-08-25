import { Module } from '@nestjs/common'
import { AI_PROVIDER_CASCADE, createUnavailableAiTextProvider } from '@helloreview/adapters'
import { AiOrchestrationService } from './ai-orchestration.service.js'

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
  ],
  exports: [AiOrchestrationService, AI_PROVIDER_CASCADE],
})
export class AiOrchestrationModule {}
