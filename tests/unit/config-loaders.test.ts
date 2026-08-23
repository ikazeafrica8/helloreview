// Unit tier: the shared configuration loader (T8).
//
// Both loaders are pure functions of their input, so nothing here touches the environment. These
// import application SOURCE rather than a compiled process, which is what the unit tier is for —
// and the only kind of test v8 coverage can observe.

import { test, describe, expect } from 'vitest'
import {
  loadApiConfig,
  loadWorkerConfig,
  redactEnvironment,
  ConfigurationError,
  isSecret,
} from '../../packages/config/src/index.js'

/**
 * Run `body`, requiring a ConfigurationError, and return it narrowed.
 *
 * instanceof rather than `catch (e) { e as ConfigurationError }`: the cast is what
 * @typescript-eslint/no-unsafe-type-assertion forbids, and the ban is right — a cast would pass
 * silently if the loader ever threw something else, which is the case worth catching.
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
  MASKING_PEPPER: 'a-test-pepper-at-least-16-chars',
}

describe('loadApiConfig', () => {
  test('returns a frozen, typed configuration when the environment is complete', () => {
    const config = loadApiConfig(VALID)

    expect(config.databaseUrl).toBe(VALID.DATABASE_URL)
    expect(config.redisUrl).toBe(VALID.REDIS_URL)
    expect(config.apiPort).toBe(13000)
    // Frozen so a later module cannot reach in and change configuration at runtime.
    expect(Object.isFrozen(config)).toBe(true)
  })

  test('reports EVERY problem at once, not just the first', () => {
    // Fixing configuration one error per restart is the small friction that makes people copy
    // values around until something works.
    const { problems } = expectConfigurationError(() => loadApiConfig({}))

    expect(problems).toHaveLength(4)
    const joined = problems.join('\n')
    expect(joined).toMatch(/DATABASE_URL/)
    expect(joined).toMatch(/REDIS_URL/)
    expect(joined).toMatch(/API_PORT/)
    expect(joined).toMatch(/MASKING_PEPPER/)
  })

  test('never echoes a value, because a malformed URL still carries a password', () => {
    // Zod's default messages quote the input. For DATABASE_URL that would print a password into the
    // startup log of a process that has not started yet (SPEC.md §21.4).
    const secret = 'sup3rsecret'
    const error = expectConfigurationError(() => loadApiConfig({ ...VALID, DATABASE_URL: `bad-${secret}` }))
    expect(error.message).not.toContain(secret)
  })

  test('rejects a URL that parses but can never connect', () => {
    // `new URL('nonsense://')` succeeds — WHATWG allows a non-special scheme with an empty host — so
    // a bare url() check accepts values that fail only at connect time. This was a real bug in the
    // loaders T8 replaced.
    expect(() => loadApiConfig({ ...VALID, DATABASE_URL: 'nonsense://' })).toThrow(ConfigurationError)
    expect(() => loadApiConfig({ ...VALID, DATABASE_URL: 'postgres://' })).toThrow(ConfigurationError)
    expect(() => loadApiConfig({ ...VALID, REDIS_URL: 'http://127.0.0.1:16379' })).toThrow(ConfigurationError)
  })

  test.each([
    ['not a number', 'abc'],
    ['zero', '0'],
    ['above the port range', '70000'],
    ['empty', ''],
  ])('rejects an API_PORT that is %s', (_label, value) => {
    expect(() => loadApiConfig({ ...VALID, API_PORT: value })).toThrow(ConfigurationError)
  })

  test('accepts the boundary ports', () => {
    expect(loadApiConfig({ ...VALID, API_PORT: '1' }).apiPort).toBe(1)
    expect(loadApiConfig({ ...VALID, API_PORT: '65535' }).apiPort).toBe(65535)
  })
})

describe('loadWorkerConfig', () => {
  test('needs only what the worker actually reads, not the whole api surface', () => {
    // A worker that refuses to start over a value it does not use is a confusing failure on call —
    // API_PORT and DATABASE_URL are deliberately absent here.
    const config = loadWorkerConfig({ REDIS_URL: VALID.REDIS_URL, MASKING_PEPPER: VALID.MASKING_PEPPER })
    expect(config.redisUrl).toBe(VALID.REDIS_URL)
    expect(Object.isFrozen(config)).toBe(true)
  })

  test('applies the same REDIS_URL rule as the api, because the schema is picked not copied', () => {
    const withPepper = { MASKING_PEPPER: VALID.MASKING_PEPPER }
    expect(() => loadWorkerConfig({ ...withPepper, REDIS_URL: 'http://127.0.0.1:16379' })).toThrow(ConfigurationError)
    expect(() => loadWorkerConfig({ ...withPepper, REDIS_URL: 'redis://' })).toThrow(ConfigurationError)
    expect(() => loadWorkerConfig(withPepper)).toThrow(/REDIS_URL is not set/)
  })
})

describe('redaction', () => {
  test('every credential-bearing key is marked secret', () => {
    expect(isSecret('DATABASE_URL')).toBe(true)
    expect(isSecret('REDIS_URL')).toBe(true)
    // The pepper is what makes a masked identifier unlinkable; leaking it undoes the masking.
    expect(isSecret('MASKING_PEPPER')).toBe(true)
    expect(isSecret('API_PORT')).toBe(false)
  })

  test('secrets are replaced wholesale, never truncated', () => {
    const redacted = redactEnvironment(VALID)

    // A prefix still leaks the scheme, host and usually the username — "it is only the first few
    // characters" is how credentials reach a log aggregator.
    expect(redacted.DATABASE_URL).toBe('[redacted]')
    expect(redacted.REDIS_URL).toBe('[redacted]')
    expect(redacted.MASKING_PEPPER).toBe('[redacted]')
    expect(JSON.stringify(redacted)).not.toContain('pw')
    expect(JSON.stringify(redacted)).not.toContain('127.0.0.1:15432')

    // Non-secret values stay readable, which is the entire point of redacting selectively.
    expect(redacted.API_PORT).toBe('13000')
  })

  test('absent keys are omitted rather than reported as redacted', () => {
    // Printing "[redacted]" for a variable that is simply not set would send someone hunting for a
    // value that does not exist.
    expect(redactEnvironment({ API_PORT: '13000' })).toEqual({ API_PORT: '13000' })
  })
})
