// Unit tier: the shared configuration loader (T8).
//
// Both loaders are pure functions of their input, so nothing here touches the environment. These
// import application SOURCE rather than a compiled process, which is what the unit tier is for —
// and the only kind of test v8 coverage can observe.

import { test, describe, expect } from 'vitest'
import {
  loadApiConfig,
  loadApplicationImportConfig,
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
  WEBHOOK_SECRET_WEBSITE: 'a-test-webhook-secret-of-at-least-32-characters',
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

    // Five required keys today. The count is asserted as well as the names so that adding a key
    // without adding it here fails loudly rather than silently leaving it unchecked.
    expect(problems).toHaveLength(5)
    const joined = problems.join('\n')
    expect(joined).toMatch(/DATABASE_URL/)
    expect(joined).toMatch(/REDIS_URL/)
    expect(joined).toMatch(/API_PORT/)
    expect(joined).toMatch(/MASKING_PEPPER/)
    expect(joined).toMatch(/WEBHOOK_SECRET_WEBSITE/)
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

  test('application reconciliation and freshness use bounded deployment defaults', () => {
    const config = loadApiConfig(VALID)
    expect(config.applicationReconciliationWindowSeconds).toBe(300)
    expect(config.applicationReconciliationRetrySeconds).toBe(30)
    expect(config.applicationFreshnessThresholdSeconds).toBe(900)

    const supplied = loadApiConfig({
      ...VALID,
      APPLICATION_RECONCILIATION_WINDOW_SECONDS: '600',
      APPLICATION_RECONCILIATION_RETRY_SECONDS: '60',
      APPLICATION_FRESHNESS_THRESHOLD_SECONDS: '1800',
    })
    expect(supplied.applicationReconciliationWindowSeconds).toBe(600)
    expect(supplied.applicationReconciliationRetrySeconds).toBe(60)
    expect(supplied.applicationFreshnessThresholdSeconds).toBe(1800)
  })

  test.each([
    ['window below its floor', 'APPLICATION_RECONCILIATION_WINDOW_SECONDS', '10'],
    ['retry interval at zero', 'APPLICATION_RECONCILIATION_RETRY_SECONDS', '0'],
    ['freshness above its ceiling', 'APPLICATION_FRESHNESS_THRESHOLD_SECONDS', '999999'],
  ])('rejects an application %s', (_label, key, value) => {
    expect(() => loadApiConfig({ ...VALID, [key]: value })).toThrow(ConfigurationError)
  })
})

describe('webhook signing configuration (T16)', () => {
  test('the signing secret is keyed by the §18.1 source value the envelope carries', () => {
    // The gateway looks a verifier up by the `source` in the envelope. Keying the map by anything
    // else would need a second name kept in step by hand, which is a mapping that drifts.
    const config = loadApiConfig(VALID)
    expect(config.webhookSecrets.helloreview_website).toBe(VALID.WEBHOOK_SECRET_WEBSITE)
  })

  test('a short secret is refused', () => {
    // This secret is the only thing between the internet and the ability to write business state.
    // An attacker who captures one signed request can grind candidates against it offline, so a
    // short one is not "slightly weaker", it is breakable without touching us.
    expect(() => loadApiConfig({ ...VALID, WEBHOOK_SECRET_WEBSITE: 'too-short' })).toThrow(ConfigurationError)
  })

  test('the secret is marked as a secret, so redaction covers it', () => {
    expect(isSecret('WEBHOOK_SECRET_WEBSITE')).toBe(true)
    expect(redactEnvironment(VALID).WEBHOOK_SECRET_WEBSITE).toBe('[redacted]')
  })

  test('the replay window defaults to five minutes when unset', () => {
    const { WEBHOOK_REPLAY_WINDOW_SECONDS: _omitted, ...withoutWindow } = {
      ...VALID,
      WEBHOOK_REPLAY_WINDOW_SECONDS: '',
    }
    expect(loadApiConfig(withoutWindow).webhookReplayWindowSeconds).toBe(300)
  })

  test.each([
    ['below the floor', '10'],
    ['above the ceiling', '99999'],
    ['not a number', 'five minutes'],
  ])('a replay window %s is refused', (_label, value) => {
    // Bounded at BOTH ends. Too tight refuses a provider's legitimate retry; too loose leaves a
    // captured request replayable for that long, which is the one that is a security problem.
    expect(() => loadApiConfig({ ...VALID, WEBHOOK_REPLAY_WINDOW_SECONDS: value })).toThrow(ConfigurationError)
  })

  test('a supplied window is used', () => {
    expect(loadApiConfig({ ...VALID, WEBHOOK_REPLAY_WINDOW_SECONDS: '900' }).webhookReplayWindowSeconds).toBe(900)
  })
})

describe('loadWorkerConfig', () => {
  test('needs only what the worker actually reads, not the whole api surface', () => {
    // A worker that refuses to start over a value it does not use is a confusing failure on call.
    // API_PORT and the webhook signing secret are deliberately absent: the worker serves no HTTP
    // and verifies no signatures.
    //
    // DATABASE_URL IS now required, and that is a real change rather than an oversight. The worker
    // was Redis-only until the inbox relay landed; the relay reads `event_inbox` directly, and it
    // is a correctness guarantee — a worker that started without a database and silently ran no
    // relay would leave stranded events unrepaired. Failing at startup is the right behaviour, and
    // a deployment adding this variable is the intended consequence.
    const config = loadWorkerConfig({
      REDIS_URL: VALID.REDIS_URL,
      MASKING_PEPPER: VALID.MASKING_PEPPER,
      DATABASE_URL: VALID.DATABASE_URL,
    })
    expect(config.redisUrl).toBe(VALID.REDIS_URL)
    expect(config.databaseUrl).toBe(VALID.DATABASE_URL)
    expect(config.applicationReconciliationWindowSeconds).toBe(300)
    expect(config.applicationReconciliationRetrySeconds).toBe(30)
    expect(config.applicationFreshnessThresholdSeconds).toBe(900)
    expect(Object.isFrozen(config)).toBe(true)
  })

  test('the worker refuses to start without a database, because the relay needs one', () => {
    // Asserted rather than implied. The relay is what turns "a provider retried" from the
    // correctness argument into a mere optimisation, so a worker running without it is degraded in
    // a way nothing else would report.
    expect(() => loadWorkerConfig({ REDIS_URL: VALID.REDIS_URL, MASKING_PEPPER: VALID.MASKING_PEPPER })).toThrow(
      /DATABASE_URL/,
    )
  })

  test('applies the same REDIS_URL rule as the api, because the schema is picked not copied', () => {
    const withPepper = { MASKING_PEPPER: VALID.MASKING_PEPPER, DATABASE_URL: VALID.DATABASE_URL }
    expect(() => loadWorkerConfig({ ...withPepper, REDIS_URL: 'http://127.0.0.1:16379' })).toThrow(ConfigurationError)
    expect(() => loadWorkerConfig({ ...withPepper, REDIS_URL: 'redis://' })).toThrow(ConfigurationError)
    expect(() => loadWorkerConfig(withPepper)).toThrow(/REDIS_URL is not set/)
  })
})

describe('loadApplicationImportConfig', () => {
  test('requires only the database and keyed-digest secret used by the operator command', () => {
    const config = loadApplicationImportConfig({
      DATABASE_URL: VALID.DATABASE_URL,
      MASKING_PEPPER: VALID.MASKING_PEPPER,
    })
    expect(config).toEqual({
      databaseUrl: VALID.DATABASE_URL,
      maskingPepper: VALID.MASKING_PEPPER,
    })
    expect(Object.isFrozen(config)).toBe(true)
  })

  test('does not accept a missing database or a weak digest secret', () => {
    expect(() => loadApplicationImportConfig({ MASKING_PEPPER: VALID.MASKING_PEPPER })).toThrow(/DATABASE_URL/)
    expect(() =>
      loadApplicationImportConfig({ DATABASE_URL: VALID.DATABASE_URL, MASKING_PEPPER: 'too-short' }),
    ).toThrow(ConfigurationError)
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
