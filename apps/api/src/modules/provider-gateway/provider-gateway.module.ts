import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common'
import { PlatformCoreModule } from '../platform-core/index.js'
import { ProviderRegistry } from './provider-registry.js'
import { SignatureGuard } from './signature.guard.js'
import { RateLimitGuard } from './rate-limit.guard.js'
import { WebhookRateLimiter } from './rate-limit.js'
import { InboxRepository } from './inbox.repository.js'
import { InboxService } from './inbox.service.js'
import { WebhookController } from './webhook.controller.js'
import { createRawBodyMiddleware } from './raw-body.middleware.js'

/**
 * The provider gateway (SPEC.md §3.1: depends on platform-core only).
 *
 * The raw-body middleware is bound to the webhook route HERE rather than globally, so only this
 * route pays for streaming its own body.
 *
 * Body PARSING, separately, is off application-wide at main.ts (`bodyParser: false`) and no parser
 * is registered anywhere. Any future route needing a parsed body must add its own middleware —
 * see the note on createRawBodyMiddleware. An earlier version of this comment implied parsing was
 * still on elsewhere; it is not.
 */
const WEBHOOK_BODY_LIMIT_BYTES = 1_048_576

@Module({
  imports: [PlatformCoreModule],
  controllers: [WebhookController],
  providers: [ProviderRegistry, SignatureGuard, RateLimitGuard, WebhookRateLimiter, InboxRepository, InboxService],
  exports: [ProviderRegistry, WebhookRateLimiter, InboxService, InboxRepository],
})
export class ProviderGatewayModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(createRawBodyMiddleware(WEBHOOK_BODY_LIMIT_BYTES))
      .forRoutes({ path: 'webhooks/:provider', method: RequestMethod.POST })
  }
}
