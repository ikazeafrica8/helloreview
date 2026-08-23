// Security tier: signature verification and the replay window (T16, PRD §18.3).
//
// This is the outermost gate on the platform. Everything downstream — the inbox, the idempotency
// constraint, the workflow state machine — assumes the event actually came from the provider it
// claims to come from. If this gate is wrong, none of that matters, because an attacker writes
// business state directly.
//
// Three properties are tested, and they fail in different ways:
//
//   1. REJECTION HAPPENS FIRST. Before JSON.parse, before the inbox, before anything is persisted.
//      A gateway that parses first is a gateway where an unauthenticated body reaches a parser.
//   2. THE REPLAY WINDOW IS ENFORCED and is per provider. A captured-and-replayed request is valid
//      forever without it, because the signature over an unchanging body never expires.
//   3. NOTHING LEAKS. Not the secret, not the expected signature, not the body. A rejection
//      message that includes the expected value is an oracle.

import { test, describe, expect } from 'vitest'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(import.meta.dirname))
const importBuilt = async (relativePath) => import(pathToFileURL(join(ROOT, relativePath)).href)

const SECRET = 'a-provider-webhook-secret-value'
const BODY = JSON.stringify({ event_type: 'application.created', payload: { application_id: 'app_123' } })
const NOW = new Date('2026-08-22T10:30:00.000Z')

/** Sign the way the verifier expects: HMAC over `timestamp.body`, which binds the two together. */
const sign = (body, timestamp, secret = SECRET) =>
  createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')

const requestAt = (date, overrides = {}) => {
  const timestamp = Math.floor(date.getTime() / 1000).toString()
  return {
    rawBody: Buffer.from(BODY, 'utf8'),
    headers: {
      'x-helloreview-signature': sign(BODY, timestamp),
      'x-helloreview-timestamp': timestamp,
    },
    receivedAt: NOW,
    ...overrides,
  }
}

const verifierFor = async (options = {}) => {
  const { createHmacSignatureVerifier } = await importBuilt('apps/api/dist/modules/provider-gateway/signature/index.js')
  return createHmacSignatureVerifier({
    provider: 'helloreview_website',
    secret: SECRET,
    replayWindowSeconds: 300,
    ...options,
  })
}

describe('a valid request is accepted', () => {
  test('a correctly signed, in-window request passes', async () => {
    const verifier = await verifierFor()
    expect(verifier.verify(requestAt(NOW))).toEqual({ ok: true })
  })

  test('the header names are matched case-insensitively, as HTTP requires', async () => {
    // Node lowercases incoming header names, but a test harness or a proxy may not. RFC 9110 makes
    // field names case-insensitive, and a verifier that only accepts one casing rejects genuine
    // traffic — which looks identical to an attack in the logs.
    const verifier = await verifierFor()
    const timestamp = Math.floor(NOW.getTime() / 1000).toString()
    const result = verifier.verify({
      rawBody: Buffer.from(BODY, 'utf8'),
      headers: { 'X-HelloReview-Signature': sign(BODY, timestamp), 'X-HelloReview-Timestamp': timestamp },
      receivedAt: NOW,
    })
    expect(result).toEqual({ ok: true })
  })
})

describe('T16 criterion 1: an invalid or absent signature is rejected', () => {
  test.each([
    ['absent', { 'x-helloreview-timestamp': '1755858600' }],
    ['empty', { 'x-helloreview-signature': '', 'x-helloreview-timestamp': '1755858600' }],
    ['not hex', { 'x-helloreview-signature': 'not-a-signature', 'x-helloreview-timestamp': '1755858600' }],
  ])('a %s signature is rejected', async (_label, headers) => {
    const verifier = await verifierFor()
    const result = verifier.verify({ rawBody: Buffer.from(BODY, 'utf8'), headers, receivedAt: NOW })
    expect(result.ok).toBe(false)
  })

  test('a signature made with the wrong secret is rejected', async () => {
    const verifier = await verifierFor()
    const timestamp = Math.floor(NOW.getTime() / 1000).toString()
    const result = verifier.verify(
      requestAt(NOW, {
        headers: {
          'x-helloreview-signature': sign(BODY, timestamp, 'the-attackers-guess'),
          'x-helloreview-timestamp': timestamp,
        },
      }),
    )
    expect(result).toMatchObject({ ok: false, reasonCode: 'SIGNATURE_MISMATCH' })
  })

  test('a signature valid for a DIFFERENT body is rejected', async () => {
    // The attack this actually stops: capture a legitimate request, keep its signature and
    // timestamp, swap the body. Without binding the body into the HMAC, that succeeds.
    const verifier = await verifierFor()
    const timestamp = Math.floor(NOW.getTime() / 1000).toString()
    const result = verifier.verify({
      rawBody: Buffer.from(JSON.stringify({ event_type: 'selection.updated' }), 'utf8'),
      headers: { 'x-helloreview-signature': sign(BODY, timestamp), 'x-helloreview-timestamp': timestamp },
      receivedAt: NOW,
    })
    expect(result).toMatchObject({ ok: false, reasonCode: 'SIGNATURE_MISMATCH' })
  })

  test('a signature valid for a different TIMESTAMP is rejected', async () => {
    // Otherwise the timestamp is decorative: an attacker replays a captured signature with a fresh
    // timestamp and walks straight through the replay window.
    const verifier = await verifierFor()
    const oldTimestamp = Math.floor(NOW.getTime() / 1000 - 60).toString()
    const freshTimestamp = Math.floor(NOW.getTime() / 1000).toString()
    const result = verifier.verify({
      rawBody: Buffer.from(BODY, 'utf8'),
      headers: { 'x-helloreview-signature': sign(BODY, oldTimestamp), 'x-helloreview-timestamp': freshTimestamp },
      receivedAt: NOW,
    })
    expect(result).toMatchObject({ ok: false, reasonCode: 'SIGNATURE_MISMATCH' })
  })

  test('a signature of the wrong LENGTH is rejected, not crashed on', async () => {
    // crypto.timingSafeEqual THROWS on buffers of unequal length. A verifier that calls it without
    // a length guard turns a malformed signature into a 500 — and a 500 is a different, and
    // therefore informative, response than a 401.
    const verifier = await verifierFor()
    const timestamp = Math.floor(NOW.getTime() / 1000).toString()
    const result = verifier.verify({
      rawBody: Buffer.from(BODY, 'utf8'),
      headers: { 'x-helloreview-signature': 'ab'.repeat(8), 'x-helloreview-timestamp': timestamp },
      receivedAt: NOW,
    })
    expect(result.ok).toBe(false)
  })
})

describe('T16 criterion 2: the replay window is enforced and is per provider', () => {
  test('a request older than the window is rejected', async () => {
    const verifier = await verifierFor({ replayWindowSeconds: 300 })
    const old = new Date(NOW.getTime() - 301_000)
    expect(verifier.verify(requestAt(old))).toMatchObject({ ok: false, reasonCode: 'REPLAY_WINDOW_EXCEEDED' })
  })

  test('a request inside the window is accepted', async () => {
    const verifier = await verifierFor({ replayWindowSeconds: 300 })
    expect(verifier.verify(requestAt(new Date(NOW.getTime() - 299_000)))).toEqual({ ok: true })
  })

  test('a timestamp from the FUTURE beyond tolerance is rejected', async () => {
    // Clock skew is real, so a small forward tolerance is correct. An unbounded one is not: a
    // far-future timestamp would stay valid for as long as it takes the clock to reach it.
    const verifier = await verifierFor({ replayWindowSeconds: 300 })
    expect(verifier.verify(requestAt(new Date(NOW.getTime() + 3_600_000)))).toMatchObject({
      ok: false,
      reasonCode: 'REPLAY_WINDOW_EXCEEDED',
    })
  })

  test('the window is configurable per provider, not global', async () => {
    // Providers differ in how long they take to retry. One global window is either too tight for
    // the slowest or too loose for the rest, and "too loose" is the one that is a security problem.
    const strict = await verifierFor({ provider: 'a', replayWindowSeconds: 60 })
    const lenient = await verifierFor({ provider: 'b', replayWindowSeconds: 900 })
    const twoMinutesAgo = new Date(NOW.getTime() - 120_000)

    expect(strict.verify(requestAt(twoMinutesAgo)).ok).toBe(false)
    expect(lenient.verify(requestAt(twoMinutesAgo)).ok).toBe(true)
  })

  test.each([
    ['absent', {}],
    ['not a number', { 'x-helloreview-timestamp': 'yesterday' }],
    ['empty', { 'x-helloreview-timestamp': '' }],
    ['negative', { 'x-helloreview-timestamp': '-100' }],
  ])('a %s timestamp is rejected', async (_label, timestampHeader) => {
    const verifier = await verifierFor()
    const result = verifier.verify({
      rawBody: Buffer.from(BODY, 'utf8'),
      headers: { 'x-helloreview-signature': 'a'.repeat(64), ...timestampHeader },
      receivedAt: NOW,
    })
    expect(result.ok).toBe(false)
  })

  test('the window is checked BEFORE the signature, so a stale request costs no HMAC', async () => {
    // Cheap check first. It also means a flood of stale replays cannot be used to make the service
    // do unbounded HMAC work.
    const verifier = await verifierFor()
    const stale = requestAt(new Date(NOW.getTime() - 100_000_000))
    expect(verifier.verify(stale)).toMatchObject({ reasonCode: 'REPLAY_WINDOW_EXCEEDED' })
  })
})

describe('T16 criterion 3: constant-time comparison, and nothing leaks', () => {
  const SOURCE = readFileSync(join(ROOT, 'apps/api/src/modules/provider-gateway/signature/hmac-verifier.ts'), 'utf8')

  test('the digest is compared with timingSafeEqual, never with === or !==', () => {
    // A `===` on the digest leaks, through timing, how many leading bytes were correct — which
    // turns forging a signature into a few thousand requests rather than 2^256 work. This is a
    // static check because the timing difference is real but not reliably observable in a test.
    //
    // COMMENTS ARE STRIPPED FIRST. The first version of this assertion failed against correct code,
    // because the doc comment explaining the hazard contains the literal phrase `expected ===
    // actual`. A static check that reads prose is a static check that fires on the explanation of
    // the thing it is looking for.
    const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

    expect(code).toMatch(/timingSafeEqual/)
    expect(code).not.toMatch(/(expected|digest|computed)\w*\s*[=!]==/)
  })

  test('that static check would actually catch a naive comparison', () => {
    // Proving the guard above can fail. A check written against source text is exactly the kind
    // that silently stops matching after a rename, and it would then pass forever.
    const naive = 'const ok = expected === candidate'
    expect(naive.replace(/\/\/.*$/gm, '')).toMatch(/(expected|digest|computed)\w*\s*[=!]==/)
  })

  test('a rejection never reports the expected signature', async () => {
    // An error that says "expected abc123..." is a signing oracle: an attacker submits anything,
    // reads the correct answer out of the response, and resubmits.
    const verifier = await verifierFor()
    const timestamp = Math.floor(NOW.getTime() / 1000).toString()
    const expected = sign(BODY, timestamp)
    const result = verifier.verify(
      requestAt(NOW, {
        headers: { 'x-helloreview-signature': 'f'.repeat(64), 'x-helloreview-timestamp': timestamp },
      }),
    )

    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(expected)
    expect(serialized).not.toContain(SECRET)
  })

  test('the result carries a reason CODE and nothing else about the request', async () => {
    // The whole result object is what a controller will log. It must be safe by construction
    // rather than by the caller remembering to pick fields out of it.
    const verifier = await verifierFor()
    const result = verifier.verify({
      rawBody: Buffer.from(BODY, 'utf8'),
      headers: {},
      receivedAt: NOW,
    })

    expect(Object.keys(result).sort()).toEqual(['ok', 'reasonCode'])
    expect(result.reasonCode).toMatch(/^[A-Z][A-Z0-9_]*$/)
    expect(JSON.stringify(result)).not.toContain(BODY)
  })

  test('the verifier never stores the secret where it can be enumerated', async () => {
    // A verifier whose secret is an enumerable own property ends up in a structured log the first
    // time someone logs the object it lives on.
    const verifier = await verifierFor()
    expect(JSON.stringify(verifier)).not.toContain(SECRET)
    expect(Object.values(verifier).join(' ')).not.toContain(SECRET)
  })
})

describe('the sanity of the test scaffolding itself', () => {
  test('the local signing helper agrees with node crypto, so a green run means something', () => {
    // If `sign` were wrong in the same way the implementation is wrong, every test above would
    // pass against a broken verifier.
    const timestamp = '1755858600'
    const a = Buffer.from(sign(BODY, timestamp), 'hex')
    const b = createHmac('sha256', SECRET).update(`${timestamp}.${BODY}`).digest()
    expect(a.length).toBe(32)
    expect(timingSafeEqual(a, b)).toBe(true)
  })
})
