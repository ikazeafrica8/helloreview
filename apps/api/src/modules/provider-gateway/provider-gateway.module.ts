import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common'
import { PlatformCoreModule } from '../platform-core/index.js'
import { ProviderRegistry } from './provider-registry.js'
import { SignatureGuard } from './signature.guard.js'
import { RateLimitGuard } from './rate-limit.guard.js'
import { WebhookRateLimiter } from './rate-limit.js'
import { WebhookController } from './webhook.controller.js'
import { createRawBodyMiddleware } from './raw-body.middleware.js'

/**
 * The provider gateway (SPEC.md §3.1: depends on platform-core only).
 *
 * The raw-body middleware is bound to the webhook route HERE rather than globally. Disabling body
 * parsing for the whole application would make every future endpoint pay for this one's
 * constraints, and re-enabling it selectively later is the kind of change that silently
 * reintroduces a parsed-before-authenticated body.
 */
const WEBHOOK_BODY_LIMIT_BYTES = 1_048_576

@Module({
  imports: [PlatformCoreModule],
  controllers: [WebhookController],
  providers: [ProviderRegistry, SignatureGuard, RateLimitGuard, WebhookRateLimiter],
  exports: [ProviderRegistry, WebhookRateLimiter],
})
export class ProviderGatewayModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(createRawBodyMiddleware(WEBHOOK_BODY_LIMIT_BYTES))
      .forRoutes({ path: 'webhooks/:provider', method: RequestMethod.POST })
  }
}
