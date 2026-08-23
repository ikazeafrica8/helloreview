// AC-02 — duplicate application-completion webhook (PRD §26.3).
//
//   Given an application-completed event has already been processed
//   When the same source event ID is delivered again
//   Then the event shall be acknowledged as a duplicate
//   And no second state transition shall occur
//   And no second acknowledgment message shall be sent
//
// The scenario verbatim, against the real API over a socket, with a real Postgres and a real Redis.
// Nothing is stubbed: the request is signed the way a provider would sign it, and every assertion
// reads the state that was actually persisted.
//
// WHAT IS AND IS NOT PROVEN TODAY — stated plainly, because an acceptance test that quietly asserts
// less than its Gherkin says is worse than no acceptance test.
//
//   "acknowledged as a duplicate"      PROVEN. The response carries duplicate: true.
//   "no second state transition"       PROVEN AT TODAY'S BOUNDARY. The inbox row IS the platform's
//                                      state for an inbound event until T34 adds workflow
//                                      instances. One row, unchanged, is the whole state.
//   "no second acknowledgment message" PROVEN BY PROXY. Outbound messages arrive with T41's
//                                      outbound_notifications table and T45's sender; today the
//                                      strongest available evidence is that no second processing
//                                      job was enqueued, and nothing downstream can send a message
//                                      it was never asked to send.
//
// The last one is a proxy, and proxies rot. The final test in this file therefore FAILS the moment
// outbound_notifications exists — a forcing function rather than a comment, so this file cannot be
// left asserting less than it claims once the real artifact is available.

import { test, describe, beforeAll, afterAll, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'

const ROOT = dirname(dirname(import.meta.dirname))
const importBuilt = async (relativePath) => import(pathToFileURL(join(ROOT, relativePath)).href)

const PORT = 13097
const BASE = `http://127.0.0.1:${String(PORT)}`
const TEST_DATABASE = 'helloreview_ac02'
const REDIS_TEST_DB = '15'

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

const urlWithPath = (base, path) => {
  const url = new URL(base)
  url.pathname = path
  return url.toString()
}

const testDatabaseUrl = () => urlWithPath(ENV.get('DATABASE_MIGRATION_URL'), `/${TEST_DATABASE}`)
const adminUrl = () => urlWithPath(ENV.get('DATABASE_MIGRATION_URL'), '/postgres')
const testRedisUrl = () => ENV.get('REDIS_URL').replace(/\/\d+$/, `/${REDIS_TEST_DB}`)

const admin = async (sql) => {
  const { createDbClient } = await importBuilt('packages/db/dist/index.js')
  const client = createDbClient(adminUrl(), 1)
  try {
    await client.query(sql)
  } finally {
    await client.close()
  }
}

const query = async (sql) => {
  const { createDbClient } = await importBuilt('packages/db/dist/index.js')
  const client = createDbClient(testDatabaseUrl(), 1)
  try {
    return (await client.query(sql)).rows
  } finally {
    await client.close()
  }
}

/**
 * The §18.5 application-completed event, in wire form.
 *
 * Built from the FAKE ADAPTER's fixtures rather than hand-written here, so this acceptance test and
 * the conformance suite cannot drift apart — and so the event is one a real provider could send.
 */
const applicationCompletedEvent = async (eventId) => {
  const { fakeWireEvent } = await importBuilt('packages/adapters/dist/index.js')
  const { EVENT_TYPES } = await importBuilt('packages/contracts/dist/index.js')
  return JSON.stringify(fakeWireEvent(EVENT_TYPES.APPLICATION_CREATED, 'helloreview_website', { eventId }))
}

const deliver = async (body) => {
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const response = await fetch(`${BASE}/webhooks/helloreview_website`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-helloreview-timestamp': timestamp,
      'x-helloreview-signature': createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex'),
    },
    body,
  })
  const text = await response.text()
  return { status: response.status, json: text === '' ? undefined : JSON.parse(text) }
}

const queuedJobs = async () => {
  const { QUEUE_NAMES } = await importBuilt('packages/contracts/dist/index.js')
  const { waitingJobs } = await importBuilt('packages/testing/dist/index.js')
  return waitingJobs(testRedisUrl(), QUEUE_NAMES.PROCESS_INBOUND_EVENT)
}

let child
let output = ''

describe('AC-02: duplicate application-completion webhook', () => {
  beforeAll(async () => {
    await admin(`DROP DATABASE IF EXISTS ${TEST_DATABASE} WITH (FORCE)`)
    await admin(`CREATE DATABASE ${TEST_DATABASE}`)
    const { applyMigrations } = await importBuilt('packages/db/dist/index.js')
    await applyMigrations(testDatabaseUrl())

    // A clean queue, so "exactly one job" is a statement about this scenario and not about
    // whatever a previous run left behind.
    const { QUEUE_NAMES } = await importBuilt('packages/contracts/dist/index.js')
    const { withQueue } = await importBuilt('packages/testing/dist/index.js')
    await withQueue(testRedisUrl(), QUEUE_NAMES.PROCESS_INBOUND_EVENT, async (queue) => {
      await queue.obliterate({ force: true })
    })

    child = spawn(process.execPath, [join(ROOT, 'apps', 'api', 'dist', 'main.js')], {
      cwd: ROOT,
      env: {
        ...process.env,
        ...Object.fromEntries(ENV),
        API_PORT: String(PORT),
        DATABASE_URL: testDatabaseUrl(),
        REDIS_URL: testRedisUrl(),
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
  }, 120_000)

  afterAll(async () => {
    child?.kill()
    await new Promise((resolve) => setTimeout(resolve, 500))
    await admin(`DROP DATABASE IF EXISTS ${TEST_DATABASE} WITH (FORCE)`).catch(() => undefined)
  })

  test('the scenario, as written', async () => {
    const eventId = 'evt_ac02_application_completed'
    const body = await applicationCompletedEvent(eventId)

    // GIVEN an application-completed event has already been processed
    const first = await deliver(body)
    expect(first.status, `the first delivery must be accepted: ${JSON.stringify(first.json)}`).toBeLessThan(300)
    expect(first.json).toMatchObject({ accepted: true, duplicate: false })

    const stateAfterFirst = await query(
      `SELECT id, source, external_event_id, event_type, payload_hash, status, occurred_at, received_at
         FROM event_inbox ORDER BY received_at`,
    )
    expect(stateAfterFirst).toHaveLength(1)
    const jobsAfterFirst = await queuedJobs()
    expect(jobsAfterFirst).toHaveLength(1)

    // WHEN the same source event ID is delivered again
    const second = await deliver(body)

    // THEN the event shall be acknowledged as a duplicate
    expect(second.status, 'a duplicate is acknowledged, not refused').toBeLessThan(300)
    expect(second.json).toMatchObject({ accepted: true, duplicate: true })
    expect(second.json.event_id).toBe(first.json.event_id)

    // AND no second state transition shall occur
    const stateAfterSecond = await query(
      `SELECT id, source, external_event_id, event_type, payload_hash, status, occurred_at, received_at
         FROM event_inbox ORDER BY received_at`,
    )
    expect(stateAfterSecond).toHaveLength(1)
    // Not merely "one row" — the SAME row, untouched. A duplicate that updated received_at or
    // bumped a status would be a second transition wearing the first one's id.
    expect(stateAfterSecond[0]).toEqual(stateAfterFirst[0])

    // AND no second acknowledgment message shall be sent
    const jobsAfterSecond = await queuedJobs()
    expect(jobsAfterSecond).toHaveLength(1)
    expect(jobsAfterSecond[0].id).toBe(jobsAfterFirst[0].id)
  })

  test('the test fails if the inbox unique constraint is dropped', async () => {
    // T20's own verification step. The scenario above passes for two reasons that look identical
    // from the outside: the constraint refused the duplicate, or the application happened not to
    // insert one. Dropping the constraint distinguishes them — if the scenario still passes
    // without it, then it was never testing the guarantee it claims to test.
    const eventId = 'evt_ac02_constraint_probe'
    const body = await applicationCompletedEvent(eventId)

    await deliver(body)
    const before = await query(`SELECT count(*)::int AS n FROM event_inbox WHERE external_event_id = '${eventId}'`)
    expect(before[0].n).toBe(1)

    await query('ALTER TABLE event_inbox DROP CONSTRAINT event_inbox_source_external_id_key')
    try {
      const duplicate = await deliver(body)
      const after = await query(`SELECT count(*)::int AS n FROM event_inbox WHERE external_event_id = '${eventId}'`)

      // The accept path REFUSES rather than degrading. `ON CONFLICT (source, external_event_id)`
      // names the constraint, so without it Postgres rejects the statement outright ("no unique or
      // exclusion constraint matching the ON CONFLICT specification") instead of inserting a second
      // row. That is a better property than the one this probe was written to check: remove the
      // guarantee and ingestion stops loudly, rather than quietly processing every duplicate twice.
      expect(duplicate.status, 'without the constraint the accept path must fail, not degrade').toBeGreaterThanOrEqual(
        500,
      )
      expect(after[0].n, 'no second row may be written once the constraint is gone').toBe(1)
    } finally {
      await query(
        `DELETE FROM event_inbox WHERE external_event_id = '${eventId}';
         ALTER TABLE event_inbox ADD CONSTRAINT event_inbox_source_external_id_key UNIQUE (source, external_event_id)`,
      )
    }
  })

  test('no participant data reached the logs while all this happened', async () => {
    // The §18.5 fixture carries a name and a phone number. SPEC.md §8 forbids either reaching a
    // log line, and an acceptance test that exercises the full request path is the right place to
    // check it — the unit-level PII matcher cannot see what a running process actually printed.
    expect(output).not.toContain('홍길동')
    expect(output).not.toContain('821012345678')
    expect(output).not.toContain(SECRET)
  })

  test('FORCING FUNCTION: strengthen this file when outbound notifications exist', async () => {
    // "No second acknowledgment message shall be sent" is currently proven by proxy — no second
    // job was enqueued, so nothing downstream was ever asked to send anything. That is the best
    // evidence available until T41 creates outbound_notifications and T45 sends from it.
    //
    // This assertion fails the moment that table appears, which is the point: a proxy left in place
    // after the real artifact exists is an acceptance test quietly asserting less than its Gherkin
    // says. When this fails, replace it with a direct assertion that no second row with purpose
    // APPLICATION_MATCH_STATUS was written for this workflow.
    const tables = await query(
      `SELECT table_name FROM information_schema.tables WHERE table_name = 'outbound_notifications'`,
    )

    expect(
      tables,
      'outbound_notifications now exists — AC-02 must assert on it directly rather than on the ' +
        'absence of a queued job. See the note above this test.',
    ).toHaveLength(0)
  })
})
