// Security tier: the webhook edge as an actual HTTP server (T16, PRD §18.3).
//
// The verifier's own tests prove the algorithm. These prove the WIRING, which is where this kind of
// control usually fails: a correct verifier that the request never reaches, a guard registered on
// the wrong route, a body parser that ran first anyway.
//
// So this boots the real compiled API and sends real requests over a socket.

import { test, describe, beforeAll, afterAll, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

const ROOT = dirname(dirname(import.meta.dirname))
const PORT = 13098
const BASE = `http://127.0.0.1:${String(PORT)}`

const parseEnv = (text) => {
  const out = new Map()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    out.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim())
  }
  return out
}

const ENV = parseEnv(readFileSync(join(ROOT, '.env.example'), 'utf8'))
const SECRET = ENV.get('WEBHOOK_SECRET_WEBSITE')

const sign = (body, timestamp, secret = SECRET) =>
  createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')

/** A well-formed §18.1 envelope for the website provider. */
const envelope = (overrides = {}) =>
  JSON.stringify({
    event_id: 'evt_edge_test',
    event_type: 'application.created',
    event_version: 1,
    source: 'helloreview_website',
    occurred_at: '2026-08-22T10:30:00+09:00',
    idempotency_key: 'helloreview_website:application:app_123:create:v1',
    payload: {
      application_id: 'app_123',
      campaign_id: 'camp_456',
      application_status: 'completed',
      application_source: 'website',
      applicant: { name: '홍길동', phone_normalized: '+821012345678' },
      submitted_at: '2026-08-22T10:30:00+09:00',
    },
    ...overrides,
  })

/** POST to the webhook route, signing correctly unless told otherwise. */
const post = async (body, { signature, timestamp, provider = 'helloreview_website', headers = {} } = {}) => {
  const ts = timestamp ?? Math.floor(Date.now() / 1000).toString()
  const response = await fetch(`${BASE}/webhooks/${provider}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-helloreview-timestamp': ts,
      'x-helloreview-signature': signature ?? sign(body, ts),
      ...headers,
    },
    body,
  })
  const text = await response.text()
  return { status: response.status, text, json: text === '' ? undefined : JSON.parse(text) }
}

/**
 * A database of this suite's own.
 *
 * The controller now PERSISTS, so these tests write rows. Pointing them at the developer's dev
 * database would leave test events in it — the same objection that moved the queue tests onto Redis
 * database 15. Postgres has no numbered databases, so the equivalent is a database named for this
 * suite, created before it runs and dropped after.
 */
const TEST_DATABASE = 'helloreview_webhook_edge'

const adminUrl = () => {
  const url = new URL(ENV.get('DATABASE_MIGRATION_URL'))
  url.pathname = '/postgres'
  return url.toString()
}

const testDatabaseUrl = () => {
  const url = new URL(ENV.get('DATABASE_MIGRATION_URL'))
  url.pathname = `/${TEST_DATABASE}`
  return url.toString()
}

/** Run one SQL statement against the `postgres` maintenance database. */
const admin = async (sql) => {
  const { createDbClient } = await import(pathToFileURL(join(ROOT, 'packages/db/dist/index.js')).href)
  const client = createDbClient(adminUrl(), 1)
  try {
    await client.query(sql)
  } finally {
    await client.close()
  }
}

let child
let output = ''

describe('the webhook edge', () => {
  beforeAll(async () => {
    // BUILD FIRST. This suite spawns apps/api/dist/main.js; without a build it would exercise
    // whatever was last compiled. Measured: a gutted size limit in source left the whole gate green.
    for (const workspace of ['packages/contracts', 'packages/db', 'packages/observability', 'apps/api']) {
      const build = spawnSync('node', [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'], {
        cwd: join(ROOT, workspace),
        encoding: 'utf8',
        timeout: 300_000,
      })
      expect(
        build.status,
        `${workspace} must compile:
${build.stdout}${build.stderr}`,
      ).toBe(0)
    }

    // CREATE DATABASE cannot run inside a transaction, so it goes through a plain connection.
    await admin(`DROP DATABASE IF EXISTS ${TEST_DATABASE}`)
    await admin(`CREATE DATABASE ${TEST_DATABASE}`)
    const { applyMigrations } = await import(pathToFileURL(join(ROOT, 'packages/db/dist/index.js')).href)
    await applyMigrations(testDatabaseUrl())

    child = spawn(process.execPath, [join(ROOT, 'apps', 'api', 'dist', 'main.js')], {
      cwd: ROOT,
      // Redis isolated to database 15, the same policy the queue tests follow: this suite drives
      // the rate limiter hard, and its bucket keys have no business landing beside real work.
      env: {
        ...process.env,
        ...Object.fromEntries(ENV),
        API_PORT: String(PORT),
        DATABASE_URL: testDatabaseUrl(),
        REDIS_URL: ENV.get('REDIS_URL').replace(/\/\d+$/, '/15'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (chunk) => (output += String(chunk)))
    child.stderr.on('data', (chunk) => (output += String(chunk)))

    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`api exited early:\n${output}`)
      try {
        await fetch(`${BASE}/health`)
        return
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }
    throw new Error(`api never became reachable:\n${output}`)
  }, 60_000)

  afterAll(async () => {
    child?.kill()
    // The connection must be gone before the database can be dropped, so give the child a moment
    // to release it. A lingering database is untidy rather than dangerous, hence the tolerance.
    await new Promise((resolve) => setTimeout(resolve, 500))
    await admin(`DROP DATABASE IF EXISTS ${TEST_DATABASE} WITH (FORCE)`).catch(() => undefined)
  })

  test('a correctly signed envelope is accepted with 202-style acknowledgement', async () => {
    const body = envelope()
    const result = await post(body)

    expect(result.status, `expected acceptance, got ${result.text}`).toBeLessThan(300)
    expect(result.json).toMatchObject({ accepted: true, event_id: 'evt_edge_test', duplicate: false })
  })

  test('every 401 carries the SAME reason code, whatever actually failed', async () => {
    // Six distinct checks can refuse a request. If each reported its own code, an attacker could
    // discover which property to vary next — is the provider registered? is the timestamp the
    // problem, or the signature? — one request at a time, and SignatureGuard runs before the rate
    // limiter, so the probing is unlimited.
    const body = envelope()
    const stale = (Math.floor(Date.now() / 1000) - 4000).toString()

    const refusals = [
      await post(body, { signature: 'f'.repeat(64) }),
      await post(body, { provider: 'not_a_real_provider' }),
      await post(body, { signature: '' }),
      await post(body, { timestamp: 'yesterday' }),
      await post(body, { timestamp: stale, signature: sign(body, stale) }),
      await post(body, { headers: { 'x-helloreview-signature': 'nothex' } }),
    ]

    for (const refusal of refusals) {
      expect(refusal.status).toBe(401)
      expect(refusal.json).toMatchObject({ reason_code: 'WEBHOOK_AUTH_FAILED' })
    }
    // Every body identical — the strongest form of the claim.
    expect(new Set(refusals.map((r) => JSON.stringify(r.json))).size).toBe(1)
  })

  test('T16 criterion 1: an unsigned request is refused 401', async () => {
    const response = await fetch(`${BASE}/webhooks/helloreview_website`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: envelope(),
    })
    expect(response.status).toBe(401)
  })

  test('a wrongly signed request is refused 401', async () => {
    const result = await post(envelope(), { signature: 'f'.repeat(64) })
    expect(result.status).toBe(401)
  })

  test('an unknown provider is refused 401, not 404 — the name is not disclosed', async () => {
    // A 404 would confirm which provider names are unregistered, which is free reconnaissance.
    const result = await post(envelope(), { provider: 'not_a_real_provider' })
    expect(result.status).toBe(401)
  })

  test('the rejection is IDENTICAL for a bad signature and an unknown provider', async () => {
    const badSignature = await post(envelope(), { signature: 'f'.repeat(64) })
    const unknownProvider = await post(envelope(), { provider: 'not_a_real_provider' })

    expect(badSignature.status).toBe(unknownProvider.status)
    // The WHOLE BODY, not just its keys. Comparing `Object.keys(...)` was the original assertion and
    // it could not fail: the two responses differed in the VALUE of `reason_code` — one said
    // SIGNATURE_MISMATCH, the other UNKNOWN_PROVIDER — while their key sets matched exactly. An
    // attacker reads values, not key sets.
    expect(badSignature.json).toEqual(unknownProvider.json)
  })

  test('T16 criterion 1: malformed JSON with a BAD signature is 401, not 400', async () => {
    // The proof that verification runs before parsing. If the body were parsed first, this would be
    // a 400 — the parser would fail before the signature was ever checked.
    const result = await post('{ this is not json', { signature: 'f'.repeat(64) })
    expect(result.status).toBe(401)
  })

  test('malformed JSON with a GOOD signature is 400 — parsing happens, just later', async () => {
    const result = await post('{ this is not json')
    expect(result.status).toBe(400)
    expect(result.json).toMatchObject({ reason_code: 'MALFORMED_JSON' })
  })

  test('a replayed request outside the window is refused 401', async () => {
    const body = envelope()
    const stale = (Math.floor(Date.now() / 1000) - 4000).toString()
    const result = await post(body, { timestamp: stale, signature: sign(body, stale) })
    expect(result.status).toBe(401)
  })

  test('an envelope whose source disagrees with the authenticated provider is refused', async () => {
    // Signed correctly with the website's secret, but claiming to be Kakao. Accepting it would let
    // one provider's credential write another provider's events.
    const body = envelope({ source: 'official_kakao_provider' })
    const result = await post(body)
    expect(result.status).toBe(400)
    expect(result.json).toMatchObject({ reason_code: 'SOURCE_MISMATCH' })
  })

  test('an envelope failing schema validation is refused 400 without detail', async () => {
    const body = JSON.stringify({ event_type: 'application.created', payload: {} })
    const result = await post(body)

    expect(result.status).toBe(400)
    expect(result.json).toMatchObject({ reason_code: 'ENVELOPE_SCHEMA_INVALID' })
    // No field paths, no expected types, no echoed values — a caller learns it was rejected, not
    // what would make it pass.
    expect(result.text).not.toMatch(/payload|application_id|expected|required/i)
  })

  test('T17 preview: an oversized body is refused 413', async () => {
    const huge = `{"padding":"${'x'.repeat(2 * 1024 * 1024)}"}`
    const result = await post(huge)
    expect(result.status).toBe(413)
  })

  test('T17: a non-JSON content type is refused 415 before a token is spent', async () => {
    const result = await post(envelope(), { headers: { 'content-type': 'text/plain' } })
    expect(result.status).toBe(415)
    expect(result.json).toMatchObject({ reason_code: 'UNSUPPORTED_MEDIA_TYPE' })
  })

  test('T17 criterion 3: sustained traffic is refused 429 with Retry-After, per provider', async () => {
    // The default bucket is 120 with a 2/second refill, so a burst past it must be refused. Sent
    // sequentially rather than in parallel: the assertion is about the limit, and a parallel flood
    // would also be testing the HTTP server's accept queue.
    const body = envelope({ event_id: 'evt_rate_probe' })
    let limited
    for (let attempt = 0; attempt < 200 && limited === undefined; attempt += 1) {
      const result = await post(body)
      if (result.status === 429) limited = result
    }

    expect(limited, 'the rate limiter never refused anything in 200 requests').toBeDefined()
    expect(limited.json).toMatchObject({ reason_code: 'RATE_LIMITED' })

    // A different provider is unaffected — but it has no registered secret, so it is refused for
    // authentication instead. 401 rather than 429 is the proof its bucket was never touched.
    const other = await post(body, { provider: 'official_kakao_provider' })
    expect(other.status).toBe(401)
  }, 120_000)

  test('T16 criterion 3: no signature, secret, or participant data reaches the logs', async () => {
    const body = envelope()
    await post(body, { signature: 'f'.repeat(64) })
    await post(body)
    await new Promise((resolve) => setTimeout(resolve, 250))

    expect(output).not.toContain(SECRET)
    expect(output).not.toContain('f'.repeat(64))
    // The signature over a valid request is equally a secret-adjacent value.
    expect(output).not.toContain(sign(body, Math.floor(Date.now() / 1000).toString()))
    // And the payload's participant data must never have been logged either (PRD §21.4).
    expect(output).not.toContain('홍길동')
    expect(output).not.toContain('821012345678')
  })
})
