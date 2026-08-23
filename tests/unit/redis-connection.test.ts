// Unit tier: turning a Redis URL into connection options (audit fix).
//
// This function exists because three call sites each decomposed the URL by hand, and all three
// silently dropped TLS: ioredis enables it from a `rediss://` STRING or from an explicit `tls`
// option, never from a decomposed `{ host, port }`. A deployment configured with `rediss://` would
// therefore have connected in PLAINTEXT — sending its Redis password and every job payload
// unencrypted — while the config schema accepted the scheme and the health probe, which passes the
// URL string and so did use TLS, stayed green.
//
// Latent today because no TLS Redis is configured. It would not have been latent on the first
// managed Redis, and "everything works, nothing is encrypted" is invisible without a test.

import { test, describe, expect } from 'vitest'
import { redisConnectionOptions } from '../../packages/config/src/index.js'

describe('TLS survives, which was the bug', () => {
  test('a rediss:// URL produces a tls option', () => {
    expect(redisConnectionOptions('rediss://default:pw@redis.example.com:6380/0')).toMatchObject({ tls: {} })
  })

  test('a plain redis:// URL does NOT', () => {
    // Asked explicitly, so the fix cannot be "always set tls" — which would break every local
    // connection in the repo.
    expect(redisConnectionOptions('redis://default:pw@127.0.0.1:16379/0')).not.toHaveProperty('tls')
  })
})

describe('the parts survive too', () => {
  test('host, port, credentials and database are carried across', () => {
    expect(redisConnectionOptions('redis://someone:s3cret@10.0.0.5:6380/7')).toMatchObject({
      host: '10.0.0.5',
      port: 6380,
      username: 'someone',
      password: 's3cret',
      db: 7,
    })
  })

  test('percent-encoded credentials are decoded', () => {
    // A password containing `@` or `/` must be encoded in the URL and decoded here, or
    // authentication fails with a message that points at the wrong thing.
    expect(redisConnectionOptions('redis://user:p%40ss%2Fword@127.0.0.1:6379/0')).toMatchObject({
      password: 'p@ss/word',
    })
  })

  test('an omitted port and database fall back rather than becoming NaN', () => {
    const options = redisConnectionOptions('redis://127.0.0.1')
    expect(options.port).toBe(6379)
    expect(options).not.toHaveProperty('db')
  })
})

describe('blocking selects the one setting that genuinely differs', () => {
  test('a Worker gets maxRetriesPerRequest: null, because it holds blocking commands open', () => {
    // Without it, ioredis counts a legitimately long blocking read as a failure and the worker dies
    // under no load at all (measured in T5).
    expect(redisConnectionOptions('redis://127.0.0.1:6379/0', { blocking: true })).toMatchObject({
      maxRetriesPerRequest: null,
    })
  })

  test('a producer does NOT', () => {
    // Giving a Queue `null` is what made a failed enqueue wait forever on the retry loop instead of
    // erroring. The accept path's explicit timeout is still the real bound, but the default should
    // not be the one that hangs.
    expect(redisConnectionOptions('redis://127.0.0.1:6379/0')).toMatchObject({ maxRetriesPerRequest: 1 })
  })
})
