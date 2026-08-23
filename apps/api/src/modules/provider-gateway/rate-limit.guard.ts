import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common'
import { RateLimitedError, UnsupportedMediaTypeError } from '@helloreview/contracts'
import { WebhookRateLimiter } from './rate-limit.js'
import { flattenHeaders, singleHeader, type GatewayResponse } from './http.js'
import type { RequestWithRawBody } from './raw-body.middleware.js'

// Rate limiting and media-type checking, applied AFTER authentication (PRD §18.3, T17).
//
// ORDER MATTERS AND IS THE OPPOSITE OF THE OBVIOUS ONE. Rate limiting runs after signature
// verification, not before. Limiting first would let an unauthenticated attacker consume a
// provider's token bucket by sending garbage with that provider's name in the path — a denial of
// service against a specific provider, using the rate limiter as the weapon. Verifying first means
// only requests that genuinely came from a provider can spend that provider's tokens.
//
// The cost is that unauthenticated floods reach the HMAC. That is bounded work on a bounded body
// (the raw-body middleware caps it before either guard runs), which is the right side of the trade.

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(private readonly limiter: WebhookRateLimiter) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp()
    const request: RequestWithRawBody = http.getRequest()
    const provider = request.params.provider ?? ''

    // 415 before 429: a request we would never process should not spend a token.
    const contentType = singleHeader(flattenHeaders(request.headers)['content-type'])
    if (contentType !== undefined && !contentType.toLowerCase().startsWith('application/json')) {
      throw new UnsupportedMediaTypeError('only application/json is accepted', 'UNSUPPORTED_MEDIA_TYPE')
    }

    const decision = await this.limiter.consume(provider)
    if (decision.allowed) return true

    // Retry-After is set on the response rather than only in the body, because a well-behaved
    // provider's HTTP client reads the header and backs off without anyone writing code for it.
    const response = http.getResponse<GatewayResponse & { setHeader?: (name: string, value: string) => void }>()
    response.setHeader?.('Retry-After', String(decision.retryAfterSeconds))

    // Thrown BEFORE the handler runs, so nothing is parsed and nothing is written — T17's "no
    // partial processing".
    throw new RateLimitedError('rate limit exceeded', 'RATE_LIMITED')
  }
}
