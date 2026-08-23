import { Inject, Injectable } from '@nestjs/common'
import { Redis } from 'ioredis'
import { createLogger, type Logger } from '@helloreview/observability'
import { APP_CONFIG, REDIS_CLIENT, type ApiConfig } from '../platform-core/index.js'

// Per-provider rate limiting for the webhook edge (PRD §18.3, T17).
//
// PER PROVIDER, NOT GLOBAL. A shared bucket means one provider's retry storm silences every other
// provider — the platform stops accepting Kakao messages because the website is misbehaving. That
// is an availability failure caused by the control meant to protect availability.
//
// A TOKEN BUCKET, IN REDIS, IN ONE SCRIPT. Three properties, each of which rules out a simpler
// implementation:
//
//   - It must survive across processes. An in-memory counter multiplies the effective limit by the
//     number of api instances, so the configured number means nothing.
//   - It must be ATOMIC. Read-then-write from the application races: two concurrent requests both
//     read the same count and both decide they are under the limit. A Lua script executes on the
//     Redis single thread, so the check and the decrement cannot be interleaved.
//   - It must allow a BURST. A provider that batches deliveries is behaving normally; a fixed
//     per-second cap refuses legitimate traffic. A bucket with capacity absorbs that and still
//     bounds the sustained rate.
//
// FAILURE MODE: OPEN, LOUDLY. If Redis is unreachable this allows the request and logs an alert.
// That is a deliberate trade and worth stating plainly, because it is the opposite of the choice
// made for signature verification: a signature is an AUTHENTICATION control and fails closed, while
// this is an availability control, and failing closed here would convert a Redis blip into a total
// outage of event ingestion — losing exactly the events the platform exists to process. The alert
// is the compensating control, and it is why this cannot fail open silently.

const TOKEN_BUCKET_SCRIPT = `
local key         = KEYS[1]
local capacity    = tonumber(ARGV[1])
local refillPerMs = tonumber(ARGV[2])
local nowMs       = tonumber(ARGV[3])
local ttlMs       = tonumber(ARGV[4])

local state  = redis.call('HMGET', key, 'tokens', 'updatedAt')
local tokens = tonumber(state[1])
local updatedAt = tonumber(state[2])

if tokens == nil then
  tokens = capacity
  updatedAt = nowMs
end

-- Refill for the time that has passed, capped at capacity. Clamped at zero because a clock that
-- moves backwards (NTP correction) would otherwise mint a negative refill and empty the bucket.
local elapsed = math.max(0, nowMs - updatedAt)
tokens = math.min(capacity, tokens + elapsed * refillPerMs)

local allowed = 0
local retryAfterMs = 0

if tokens >= 1 then
  allowed = 1
  tokens = tokens - 1
else
  -- How long until one whole token exists. Returned so the caller can send Retry-After rather
  -- than leaving a well-behaved provider to guess.
  retryAfterMs = math.ceil((1 - tokens) / refillPerMs)
end

redis.call('HSET', key, 'tokens', tokens, 'updatedAt', nowMs)
redis.call('PEXPIRE', key, ttlMs)

return { allowed, retryAfterMs }
`

export type RateLimitDecision = Readonly<{ allowed: boolean; retryAfterSeconds: number }>

export type RateLimitPolicy = Readonly<{
  /** Requests absorbed in a burst. */
  capacity: number
  /** Sustained rate once the burst is spent. */
  refillPerSecond: number
}>

const DEFAULT_POLICY: RateLimitPolicy = { capacity: 120, refillPerSecond: 2 }

@Injectable()
export class WebhookRateLimiter {
  private readonly logger: Logger

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(APP_CONFIG) config: ApiConfig,
  ) {
    this.logger = createLogger({ module: 'provider-gateway', environment: config.environment })
  }

  /**
   * Spend one token for `provider`.
   *
   * `now` is injected rather than read from Redis TIME so a test can move the clock without
   * sleeping. Redis TIME would be more correct across instances with skewed clocks; the skew that
   * matters here is seconds against a window of minutes, and injectability is worth more than that
   * precision while this is the only rate limiter in the system.
   */
  async consume(
    provider: string,
    policy: RateLimitPolicy = DEFAULT_POLICY,
    now = Date.now(),
  ): Promise<RateLimitDecision> {
    // The bucket must not be refillable to more than capacity, and must expire once idle, or a
    // provider that stops sending leaves a key behind forever.
    const ttlMs = Math.ceil((policy.capacity / policy.refillPerSecond) * 1000) + 60_000

    try {
      const result: unknown = await this.redis.eval(
        TOKEN_BUCKET_SCRIPT,
        1,
        `ratelimit:webhook:${provider}`,
        String(policy.capacity),
        String(policy.refillPerSecond / 1000),
        String(now),
        String(ttlMs),
      )

      if (!Array.isArray(result) || result.length < 2) {
        return this.failOpen(provider, 'RATE_LIMIT_SCRIPT_UNEXPECTED_RESULT')
      }

      const allowed = Number(result[0]) === 1
      const retryAfterSeconds = Math.ceil(Number(result[1]) / 1000)
      return { allowed, retryAfterSeconds: allowed ? 0 : Math.max(1, retryAfterSeconds) }
    } catch {
      // The error is deliberately not interpolated: an ioredis error message can carry the
      // connection string, and that carries a password (PRD §21.4).
      return this.failOpen(provider, 'RATE_LIMIT_BACKEND_UNAVAILABLE')
    }
  }

  /**
   * Allow the request, and say so loudly.
   *
   * §23.3 lists the critical alerts; a rate limiter that has stopped limiting belongs among them,
   * because the symptom is otherwise invisible — everything keeps working until it suddenly does
   * not.
   */
  private failOpen(provider: string, reasonCode: string): RateLimitDecision {
    this.logger.error('rate limiting is not being enforced', {
      operation: 'provider_gateway.rate_limit',
      result: 'degraded',
      reasonCode,
      provider,
    })
    return { allowed: true, retryAfterSeconds: 0 }
  }
}
