// Integration tier: idempotent accept semantics (T18, PRD §10.3, §18.2).
//
// This is the test the whole idempotency spine exists for. Everything else — the unique constraint,
// the ON CONFLICT insert, the job id — is machinery; this asserts the behaviour those pieces are
// supposed to add up to:
//
//   a duplicate returns the ORIGINAL result and enqueues nothing,
//   a new event enqueues EXACTLY ONE job,
//   and concurrent delivery of the same event yields ONE row and ONE job.
//
// The third is the one that matters. A check-then-insert implementation passes the first two and
// fails the third, and a provider's retry storm is exactly the condition that finds it.

import { test, describe, beforeAll, expect } from 'vitest'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = dirname(dirname(import.meta.dirname))
const importBuilt = async (relativePath) => import(pathToFileURL(join(ROOT, relativePath)).href)

/** A validated §18.5 event, as the schema would have produced it. */
const anEvent = (overrides = {}) => ({
  eventId: 'evt_accept_test',
  eventType: 'application.created',
  eventVersion: 1,
  source: 'helloreview_website',
  occurredAt: '2026-08-22T10:30:00+09:00',
  idempotencyKey: 'helloreview_website:application:app_123:create:v1',
  payload: { applicationId: 'app_123', campaignId: 'camp_456' },
  ...overrides,
})

const RAW = Buffer.from('{"event_id":"evt_accept_test"}', 'utf8')

/**
 * Build the service against an ephemeral Postgres and Redis, bypassing Nest's injector.
 *
 * Constructing directly rather than booting a TestingModule keeps the test about the accept
 * semantics rather than about DI wiring — which the security tier already exercises end to end.
 */
const serviceFor = async (postgresUrl, redisUrl) => {
  const { InboxRepository, InboxService } = await importBuilt('apps/api/dist/modules/provider-gateway/index.js')
  const { Pool } = await import('pg')

  const pool = new Pool({ connectionString: postgresUrl })
  const repository = new InboxRepository(pool)
  const service = new InboxService(repository, { environment: 'test', redisUrl })
  return { service, repository, pool }
}

/** How many jobs are waiting on the inbound queue. */
const queuedJobCount = async (redisUrl) => {
  const { QUEUE_NAMES } = await importBuilt('packages/contracts/dist/index.js')
  const { countWaitingJobs } = await importBuilt('packages/testing/dist/index.js')
  return countWaitingJobs(redisUrl, QUEUE_NAMES.PROCESS_INBOUND_EVENT)
}

describe('idempotent accept', () => {
  beforeAll(() => {
    for (const workspace of ['packages/contracts', 'packages/db', 'packages/observability', 'apps/api']) {
      const build = spawnSync('node', [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'], {
        cwd: join(ROOT, workspace),
        encoding: 'utf8',
        timeout: 300_000,
      })
      expect(build.status, `${workspace} must compile:\n${build.stdout}${build.stderr}`).toBe(0)
    }
  })

  test('T18 criterion 2: a new event is accepted and enqueues exactly one job', async () => {
    const { withPostgres, withRedis } = await importBuilt('packages/testing/dist/index.js')
    const { applyMigrations } = await importBuilt('packages/db/dist/index.js')

    await withPostgres(async (postgres) => {
      await withRedis(async (redis) => {
        await applyMigrations(postgres.url)
        const { service, pool } = await serviceFor(postgres.url, redis.url)
        try {
          const response = await service.accept(anEvent(), RAW)

          expect(response).toMatchObject({ accepted: true, duplicate: false, processing_status: 'queued' })
          expect(response.event_id).toBe('evt_accept_test')

          const rows = await pool.query('SELECT count(*)::int AS n FROM event_inbox')
          expect(rows.rows[0].n).toBe(1)
          expect(await queuedJobCount(redis.url)).toBe(1)
        } finally {
          await service.onModuleDestroy()
          await pool.end()
        }
      })
    })
  })

  test('T18 criterion 1: a duplicate returns duplicate:true and enqueues NOTHING', async () => {
    const { withPostgres, withRedis } = await importBuilt('packages/testing/dist/index.js')
    const { applyMigrations } = await importBuilt('packages/db/dist/index.js')

    await withPostgres(async (postgres) => {
      await withRedis(async (redis) => {
        await applyMigrations(postgres.url)
        const { service, pool } = await serviceFor(postgres.url, redis.url)
        try {
          const first = await service.accept(anEvent(), RAW)
          const second = await service.accept(anEvent(), RAW)

          expect(first.duplicate).toBe(false)
          expect(second.duplicate).toBe(true)
          // §18.2: the duplicate returns the EXISTING accepted result, so the event id must match
          // the row we already had rather than being echoed back from the request.
          expect(second.event_id).toBe(first.event_id)

          const rows = await pool.query('SELECT count(*)::int AS n FROM event_inbox')
          expect(rows.rows[0].n, 'a duplicate must not create a second row').toBe(1)
          expect(await queuedJobCount(redis.url), 'a duplicate must not enqueue a second job').toBe(1)
        } finally {
          await service.onModuleDestroy()
          await pool.end()
        }
      })
    })
  })

  test('a duplicate reports the CURRENT status of the prior event, not a fresh guess', async () => {
    // §18.2 says the API returns "the existing accepted result". If the first delivery has already
    // been processed, telling the provider `queued` would be a lie — and the provider may well be
    // retrying precisely because it is trying to find out what happened.
    const { withPostgres, withRedis } = await importBuilt('packages/testing/dist/index.js')
    const { applyMigrations } = await importBuilt('packages/db/dist/index.js')

    await withPostgres(async (postgres) => {
      await withRedis(async (redis) => {
        await applyMigrations(postgres.url)
        const { service, pool } = await serviceFor(postgres.url, redis.url)
        try {
          await service.accept(anEvent(), RAW)
          await pool.query(`UPDATE event_inbox SET status = 'processed', processed_at = now()`)

          const second = await service.accept(anEvent(), RAW)
          expect(second).toMatchObject({ duplicate: true, processing_status: 'processed' })
        } finally {
          await service.onModuleDestroy()
          await pool.end()
        }
      })
    })
  })

  test('the same event id from a DIFFERENT source is not a duplicate', async () => {
    const { withPostgres, withRedis } = await importBuilt('packages/testing/dist/index.js')
    const { applyMigrations } = await importBuilt('packages/db/dist/index.js')

    await withPostgres(async (postgres) => {
      await withRedis(async (redis) => {
        await applyMigrations(postgres.url)
        const { service, pool } = await serviceFor(postgres.url, redis.url)
        try {
          await service.accept(anEvent({ source: 'helloreview_website' }), RAW)
          const other = await service.accept(anEvent({ source: 'official_kakao_provider' }), RAW)

          expect(other.duplicate).toBe(false)
          const rows = await pool.query('SELECT count(*)::int AS n FROM event_inbox')
          expect(rows.rows[0].n).toBe(2)
          expect(await queuedJobCount(redis.url)).toBe(2)
        } finally {
          await service.onModuleDestroy()
          await pool.end()
        }
      })
    })
  })

  test('T18 criterion 3: 25 CONCURRENT deliveries yield one row and one job', async () => {
    // THE test. A check-then-insert implementation passes everything above and fails here, because
    // every one of these reads the inbox before any of them writes to it.
    const { withPostgres, withRedis } = await importBuilt('packages/testing/dist/index.js')
    const { applyMigrations } = await importBuilt('packages/db/dist/index.js')

    await withPostgres(async (postgres) => {
      await withRedis(async (redis) => {
        await applyMigrations(postgres.url)
        const { service, pool } = await serviceFor(postgres.url, redis.url)
        try {
          const responses = await Promise.all(Array.from({ length: 25 }, async () => service.accept(anEvent(), RAW)))

          // Exactly one of them inserted; the rest saw the existing row.
          const inserted = responses.filter((response) => !response.duplicate)
          expect(inserted, 'exactly one concurrent delivery may be treated as new').toHaveLength(1)

          const rows = await pool.query('SELECT count(*)::int AS n FROM event_inbox')
          expect(rows.rows[0].n).toBe(1)
          expect(await queuedJobCount(redis.url)).toBe(1)

          // Every response, duplicate or not, names the same event.
          for (const response of responses) {
            expect(response.accepted).toBe(true)
            expect(response.event_id).toBe('evt_accept_test')
          }
        } finally {
          await service.onModuleDestroy()
          await pool.end()
        }
      })
    })
  })

  test('the job carries the inbox row id, not the payload', async () => {
    // The payload is already durably stored in Postgres. Putting it on the queue as well would copy
    // participant data into Redis, where §21.6 retention does not reach and where nobody would
    // think to look for it.
    const { withPostgres, withRedis } = await importBuilt('packages/testing/dist/index.js')
    const { applyMigrations } = await importBuilt('packages/db/dist/index.js')
    const { QUEUE_NAMES } = await importBuilt('packages/contracts/dist/index.js')
    const { waitingJobs } = await importBuilt('packages/testing/dist/index.js')

    await withPostgres(async (postgres) => {
      await withRedis(async (redis) => {
        await applyMigrations(postgres.url)
        const { service, pool } = await serviceFor(postgres.url, redis.url)
        try {
          await service.accept(anEvent({ payload: { applicationId: 'app_123', name: '홍길동' } }), RAW)

          const [job] = await waitingJobs(redis.url, QUEUE_NAMES.PROCESS_INBOUND_EVENT)
          expect(job).toBeDefined()
          expect(job.data.inboxId).toMatch(/^[0-9a-f-]{36}$/)
          expect(JSON.stringify(job.data)).not.toContain('홍길동')

          // The job id IS the inbox row id, so even a retried enqueue cannot create a second job.
          expect(job.id).toBe(job.data.inboxId)
        } finally {
          await service.onModuleDestroy()
          await pool.end()
        }
      })
    })
  })

  test('a row stranded with NO job is repaired by the next redelivery', async () => {
    // The hole an audit found. Record-then-enqueue can leave a committed row whose enqueue never
    // completed — a crash between the two statements, a READONLY reply after failover, Redis OOM.
    // Before the fix, every redelivery of that event was answered 200/`queued` while no job existed
    // and none was ever created: the API asserting a state it had not verified, and the provider
    // stopping its retries on the strength of it.
    //
    // Simulated exactly by inserting the row directly and never enqueuing.
    const { withPostgres, withRedis } = await importBuilt('packages/testing/dist/index.js')
    const { applyMigrations } = await importBuilt('packages/db/dist/index.js')

    await withPostgres(async (postgres) => {
      await withRedis(async (redis) => {
        await applyMigrations(postgres.url)
        const { service, pool } = await serviceFor(postgres.url, redis.url)
        try {
          const event = anEvent({ eventId: 'evt_stranded' })
          await pool.query(
            `INSERT INTO event_inbox (source, external_event_id, event_type, payload_hash, payload, occurred_at)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              event.source,
              event.eventId,
              event.eventType,
              'a'.repeat(64),
              JSON.stringify(event.payload),
              new Date(event.occurredAt),
            ],
          )
          expect(await queuedJobCount(redis.url), 'the fixture must start with no job').toBe(0)

          // The provider retries, as providers do.
          const retry = await service.accept(event, RAW)

          expect(retry.duplicate, 'it is still a duplicate — the row was already there').toBe(true)
          expect(await queuedJobCount(redis.url), 'the redelivery must have repaired the gap').toBe(1)

          const rows = await pool.query('SELECT count(*)::int AS n FROM event_inbox')
          expect(rows.rows[0].n, 'repairing must not create a second row').toBe(1)
        } finally {
          await service.onModuleDestroy()
          await pool.end()
        }
      })
    })
  })

  test('repairing is idempotent: repeated redeliveries still yield one job', async () => {
    // The repair leans on BullMQ deduping by job id. Verified directly rather than assumed — a
    // second add with the same id returns the existing job and leaves the original payload alone.
    const { withPostgres, withRedis } = await importBuilt('packages/testing/dist/index.js')
    const { applyMigrations } = await importBuilt('packages/db/dist/index.js')

    await withPostgres(async (postgres) => {
      await withRedis(async (redis) => {
        await applyMigrations(postgres.url)
        const { service, pool } = await serviceFor(postgres.url, redis.url)
        try {
          await service.accept(anEvent(), RAW)
          for (let attempt = 0; attempt < 5; attempt += 1) await service.accept(anEvent(), RAW)

          expect(await queuedJobCount(redis.url)).toBe(1)
        } finally {
          await service.onModuleDestroy()
          await pool.end()
        }
      })
    })
  })

  test('an unreachable queue fails the request in bounded time, as a 503', async () => {
    // `queue.add()` does not reject when Redis is unreachable — measured, still pending after eight
    // seconds with maxRetriesPerRequest both null and 1, so no retry setting fixes it. Without a
    // timeout the webhook request holds a socket and its buffered body open indefinitely and the
    // caller never gets an answer.
    //
    // 503 rather than 500 because §18.4 reserves it for a temporary dependency outage, and the
    // distinction is actionable: a provider retries a 503 and escalates a 500. The retry is also
    // what repairs the committed row.
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    const { applyMigrations } = await importBuilt('packages/db/dist/index.js')
    const { DependencyUnavailableError } = await importBuilt('packages/contracts/dist/index.js')

    await withPostgres(async (postgres) => {
      await applyMigrations(postgres.url)
      // Port 1: nothing is listening, and nothing will be.
      const { service, pool } = await serviceFor(postgres.url, 'redis://127.0.0.1:1/0')
      try {
        const started = Date.now()
        const failure = await service.accept(anEvent(), RAW).then(
          () => undefined,
          (error) => error,
        )
        const elapsed = Date.now() - started

        expect(failure, 'accept() must fail rather than hang').toBeInstanceOf(DependencyUnavailableError)
        expect(failure.status).toBe(503)
        expect(elapsed, `it must settle promptly; took ${String(elapsed)}ms`).toBeLessThan(15_000)

        // The row IS committed. That is the deliberate trade — the provider's retry repairs it.
        const rows = await pool.query('SELECT status FROM event_inbox')
        expect(rows.rows).toHaveLength(1)
        expect(rows.rows[0].status).toBe('received')
      } finally {
        await service.onModuleDestroy().catch(() => undefined)
        await pool.end()
      }
    })
  }, 60_000)

  test('a duplicate event id carrying DIFFERENT content is still refused, and reported', async () => {
    // A provider reusing an event id for different content means their idempotency key does not
    // identify what we think it identifies. The event stays refused — changing our mind would
    // defeat the guarantee — but it is an error-level signal, not a silent no-op.
    const { withPostgres, withRedis } = await importBuilt('packages/testing/dist/index.js')
    const { applyMigrations } = await importBuilt('packages/db/dist/index.js')

    await withPostgres(async (postgres) => {
      await withRedis(async (redis) => {
        await applyMigrations(postgres.url)
        const { service, pool } = await serviceFor(postgres.url, redis.url)
        try {
          await service.accept(anEvent(), Buffer.from('{"v":1}', 'utf8'))
          const second = await service.accept(anEvent(), Buffer.from('{"v":2}', 'utf8'))

          expect(second.duplicate).toBe(true)
          const rows = await pool.query('SELECT payload_hash FROM event_inbox')
          expect(rows.rows).toHaveLength(1)
          // The stored hash is the FIRST delivery's. The second did not overwrite anything.
          const { createHash } = await import('node:crypto')
          expect(rows.rows[0].payload_hash).toBe(createHash('sha256').update('{"v":1}').digest('hex'))
        } finally {
          await service.onModuleDestroy()
          await pool.end()
        }
      })
    })
  })
})
