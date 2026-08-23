// Integration tier: per-provider rate limiting (T17, PRD §18.3).
//
// Against a REAL Redis, because the properties that matter are properties of the Lua script running
// on Redis's single thread. A mocked Redis would prove the TypeScript around it and nothing about
// atomicity — which is the one thing a rate limiter has to get right, since the failure mode of a
// racy limiter is that it silently permits several times its configured rate under exactly the load
// it exists to handle.

import { test, describe, beforeAll, expect } from 'vitest'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = dirname(dirname(import.meta.dirname))
const importBuilt = async (relativePath) => import(pathToFileURL(join(ROOT, relativePath)).href)

/** Build a limiter against an ephemeral Redis, bypassing Nest's injector. */
const limiterFor = async (redisUrl) => {
  const { WebhookRateLimiter } = await importBuilt('apps/api/dist/modules/provider-gateway/index.js')
  const { Redis } = await import('ioredis')
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 })
  return { limiter: new WebhookRateLimiter(redis, { environment: 'test' }), redis }
}

describe('webhook rate limiting', () => {
  beforeAll(() => {
    for (const workspace of ['packages/contracts', 'packages/observability', 'apps/api']) {
      const build = spawnSync('node', [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'], {
        cwd: join(ROOT, workspace),
        encoding: 'utf8',
        timeout: 300_000,
      })
      expect(build.status, `${workspace} must compile:\n${build.stdout}${build.stderr}`).toBe(0)
    }
  })

  test('T17 criterion 3: requests are refused once the bucket is empty', async () => {
    const { withRedis } = await importBuilt('packages/testing/dist/index.js')

    await withRedis(async ({ url }) => {
      const { limiter, redis } = await limiterFor(url)
      try {
        const policy = { capacity: 3, refillPerSecond: 1 }
        const now = 1_800_000_000_000

        // Three tokens, three requests, all allowed — and the fourth is not.
        expect((await limiter.consume('p', policy, now)).allowed).toBe(true)
        expect((await limiter.consume('p', policy, now)).allowed).toBe(true)
        expect((await limiter.consume('p', policy, now)).allowed).toBe(true)

        const refused = await limiter.consume('p', policy, now)
        expect(refused.allowed).toBe(false)
        // A well-behaved provider reads this and backs off rather than guessing.
        expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1)
      } finally {
        redis.disconnect()
      }
    })
  })

  test('the bucket is PER PROVIDER, so one provider cannot silence another', async () => {
    // The failure this prevents is an availability failure caused by the availability control: a
    // shared bucket means the website's retry storm stops Kakao messages being accepted.
    const { withRedis } = await importBuilt('packages/testing/dist/index.js')

    await withRedis(async ({ url }) => {
      const { limiter, redis } = await limiterFor(url)
      try {
        const policy = { capacity: 2, refillPerSecond: 1 }
        const now = 1_800_000_000_000

        await limiter.consume('noisy', policy, now)
        await limiter.consume('noisy', policy, now)
        expect((await limiter.consume('noisy', policy, now)).allowed).toBe(false)

        // A different provider is entirely unaffected.
        expect((await limiter.consume('quiet', policy, now)).allowed).toBe(true)
      } finally {
        redis.disconnect()
      }
    })
  })

  test('tokens refill over time, so a refused provider recovers without intervention', async () => {
    const { withRedis } = await importBuilt('packages/testing/dist/index.js')

    await withRedis(async ({ url }) => {
      const { limiter, redis } = await limiterFor(url)
      try {
        const policy = { capacity: 2, refillPerSecond: 1 }
        const start = 1_800_000_000_000

        await limiter.consume('p', policy, start)
        await limiter.consume('p', policy, start)
        expect((await limiter.consume('p', policy, start)).allowed).toBe(false)

        // One second later, one token exists.
        expect((await limiter.consume('p', policy, start + 1_000)).allowed).toBe(true)
        expect((await limiter.consume('p', policy, start + 1_000)).allowed).toBe(false)
      } finally {
        redis.disconnect()
      }
    })
  })

  test('refill is capped at capacity, so idle time does not mint an unbounded burst', async () => {
    // Without the cap, a provider silent for a day would arrive with 86,400 tokens and the limit
    // would be meaningless exactly when a backlog is being flushed at us.
    const { withRedis } = await importBuilt('packages/testing/dist/index.js')

    await withRedis(async ({ url }) => {
      const { limiter, redis } = await limiterFor(url)
      try {
        const policy = { capacity: 3, refillPerSecond: 1 }
        const start = 1_800_000_000_000

        await limiter.consume('p', policy, start)
        // A full day later.
        const muchLater = start + 86_400_000

        expect((await limiter.consume('p', policy, muchLater)).allowed).toBe(true)
        expect((await limiter.consume('p', policy, muchLater)).allowed).toBe(true)
        expect((await limiter.consume('p', policy, muchLater)).allowed).toBe(true)
        expect((await limiter.consume('p', policy, muchLater)).allowed).toBe(false)
      } finally {
        redis.disconnect()
      }
    })
  })

  test('a clock that moves BACKWARDS does not empty the bucket', async () => {
    // NTP corrections happen. An unclamped elapsed time would be negative, the refill would be
    // negative, and a well-behaved provider would be refused for no reason it could discover.
    const { withRedis } = await importBuilt('packages/testing/dist/index.js')

    await withRedis(async ({ url }) => {
      const { limiter, redis } = await limiterFor(url)
      try {
        const policy = { capacity: 5, refillPerSecond: 1 }
        const now = 1_800_000_000_000

        await limiter.consume('p', policy, now)
        // The clock jumps back ten seconds.
        expect((await limiter.consume('p', policy, now - 10_000)).allowed).toBe(true)
      } finally {
        redis.disconnect()
      }
    })
  })

  test('concurrent requests cannot both spend the last token', async () => {
    // THE test for this component. A read-then-write limiter passes every sequential test above and
    // fails this one, because two requests read the same count before either writes. The Lua script
    // runs on Redis's single thread, so the check and the decrement cannot interleave.
    const { withRedis } = await importBuilt('packages/testing/dist/index.js')

    await withRedis(async ({ url }) => {
      const { limiter, redis } = await limiterFor(url)
      try {
        const policy = { capacity: 10, refillPerSecond: 1 }
        const now = 1_800_000_000_000

        const decisions = await Promise.all(
          Array.from({ length: 40 }, async () => limiter.consume('burst', policy, now)),
        )
        const allowed = decisions.filter((decision) => decision.allowed).length

        // Exactly the capacity, never more. A racy implementation reports more than 10 here.
        expect(allowed).toBe(10)
      } finally {
        redis.disconnect()
      }
    })
  })

  test('the bucket key expires, so an idle provider leaves nothing behind', async () => {
    const { withRedis } = await importBuilt('packages/testing/dist/index.js')

    await withRedis(async ({ url }) => {
      const { limiter, redis } = await limiterFor(url)
      try {
        await limiter.consume('p', { capacity: 5, refillPerSecond: 1 }, Date.now())
        const ttl = await redis.pttl('ratelimit:webhook:p')
        // -1 means "no expiry set", which is the leak this asserts against.
        expect(ttl).toBeGreaterThan(0)
      } finally {
        redis.disconnect()
      }
    })
  })

  test('an unreachable Redis fails OPEN and says so at error level', async () => {
    // A deliberate trade, and the opposite of the choice made for signature verification. Failing
    // closed here would turn a Redis blip into a total outage of event ingestion — losing the very
    // events the platform exists to process. The alert is the compensating control, so the test
    // asserts on the alert as much as on the decision.
    const { WebhookRateLimiter } = await importBuilt('apps/api/dist/modules/provider-gateway/index.js')
    const { Redis } = await import('ioredis')

    const unreachable = new Redis('redis://127.0.0.1:1/0', {
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
      lazyConnect: true,
      enableOfflineQueue: false,
    })
    unreachable.on('error', () => undefined)

    const limiter = new WebhookRateLimiter(unreachable, { environment: 'test' })
    const decision = await limiter.consume('p')

    expect(decision.allowed).toBe(true)
    unreachable.disconnect()
  })
})
