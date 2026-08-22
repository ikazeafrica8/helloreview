// Unit tier: the configuration loaders, exercised in-process.
//
// These are the first tests that import application SOURCE rather than spawning a built process,
// which is what the unit tier exists for — and the only kind v8 coverage can actually observe.
// Both loaders are pure functions of their input, so no environment is touched here.
//
// Importing .ts directly is safe for these two files specifically: they contain no decorators, so
// esbuild's missing emitDecoratorMetadata (see vitest.config.ts) does not apply.

import { test, describe, expect } from 'vitest'
import { loadAppConfig, ConfigurationError } from '../../apps/api/src/modules/platform-core/config/load-app-config.js'
import { loadWorkerConfig } from '../../apps/worker/src/config/load-worker-config.js'

/**
 * Run `body`, requiring it to throw a ConfigurationError, and return it narrowed.
 *
 * Narrowing via instanceof rather than `catch (e) { (e as ConfigurationError) }`: the cast is
 * exactly what @typescript-eslint/no-unsafe-type-assertion forbids, and the ban is right — a cast
 * here would silently pass if the loader ever threw something else, which is the case the test is
 * supposed to catch.
 */
const expectConfigurationError = (body: () => unknown): ConfigurationError => {
  try {
    body()
  } catch (error) {
    if (error instanceof ConfigurationError) return error
    throw error
  }
  throw new Error('expected a ConfigurationError, but nothing was thrown')
}

const VALID = {
  DATABASE_URL: 'postgres://user:pw@127.0.0.1:15432/helloreview',
  REDIS_URL: 'redis://default:pw@127.0.0.1:16379/0',
  API_PORT: '13000',
}

describe('loadAppConfig', () => {
  test('returns a frozen, typed configuration when the environment is complete', () => {
    const config = loadAppConfig(VALID)

    expect(config.databaseUrl).toBe(VALID.DATABASE_URL)
    expect(config.redisUrl).toBe(VALID.REDIS_URL)
    expect(config.apiPort).toBe(13000)
    // Frozen so a later module cannot reach in and change configuration at runtime.
    expect(Object.isFrozen(config)).toBe(true)
  })

  test('reports EVERY problem at once, not just the first', () => {
    // Fixing configuration one error per restart is the small friction that makes people copy
    // values around until it works. This is the behaviour T8 must preserve.
    const { problems } = expectConfigurationError(() => loadAppConfig({}))

    expect(problems).toHaveLength(3)
    expect(problems.join('\n')).toMatch(/DATABASE_URL/)
    expect(problems.join('\n')).toMatch(/REDIS_URL/)
    expect(problems.join('\n')).toMatch(/API_PORT/)
  })

  test('never echoes the offending value, because a malformed URL still carries a password', () => {
    const secret = 'sup3rsecret'
    const error = expectConfigurationError(() => loadAppConfig({ ...VALID, DATABASE_URL: `not-a-url-${secret}` }))
    expect(error.message).not.toContain(secret)
  })

  test('rejects a URL that parses but can never connect', () => {
    // `new URL('redis://')` succeeds — WHATWG allows a non-special scheme with an empty host — so
    // a bare try/catch around new URL() accepts values that fail only at connect time.
    expect(() => loadAppConfig({ ...VALID, DATABASE_URL: 'nonsense://' })).toThrow(ConfigurationError)
    expect(() => loadAppConfig({ ...VALID, DATABASE_URL: 'postgres://' })).toThrow(ConfigurationError)
    expect(() => loadAppConfig({ ...VALID, REDIS_URL: 'http://127.0.0.1:16379' })).toThrow(ConfigurationError)
  })

  test.each([
    ['not a number', 'abc'],
    ['zero', '0'],
    ['above the port range', '70000'],
    ['empty', ''],
  ])('rejects an API_PORT that is %s', (_label, value) => {
    expect(() => loadAppConfig({ ...VALID, API_PORT: value })).toThrow(ConfigurationError)
  })

  test('accepts the boundary ports', () => {
    expect(loadAppConfig({ ...VALID, API_PORT: '1' }).apiPort).toBe(1)
    expect(loadAppConfig({ ...VALID, API_PORT: '65535' }).apiPort).toBe(65535)
  })
})

describe('loadWorkerConfig', () => {
  test('needs only REDIS_URL', () => {
    const config = loadWorkerConfig({ REDIS_URL: VALID.REDIS_URL })
    expect(config.redisUrl).toBe(VALID.REDIS_URL)
    expect(Object.isFrozen(config)).toBe(true)
  })

  test('rejects a missing or malformed REDIS_URL without echoing it', () => {
    expect(() => loadWorkerConfig({})).toThrow(/REDIS_URL is not set/)
    expect(() => loadWorkerConfig({ REDIS_URL: 'nonsense://' })).toThrow(/REDIS_URL/)
    expect(() => loadWorkerConfig({ REDIS_URL: '   ' })).toThrow(/REDIS_URL is not set/)
  })
})
