// Integration tier: the inbox relay (PRD §22.3, FR-MSG-004 applied inbound).
//
// This component is the correctness guarantee for the whole accept path, so it is tested against a
// real Postgres and a real Redis. What it must do:
//
//   - Re-queue a durably-recorded event that has no job, WITHOUT anyone retrying it.
//   - Leave a healthy in-flight accept alone, rather than racing it.
//   - Be safe to run twice, and safe to run beside itself.
//   - Say so when it repairs something — the detection half. Before the relay existed nothing in
//     the system would ever have told an operator a row was stranded.

import { test, describe, beforeAll, expect } from 'vitest'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = dirname(dirname(import.meta.dirname))
const importBuilt = async (relativePath) => import(pathToFileURL(join(ROOT, relativePath)).href)

/** A logger that records rather than prints, so the alert can be asserted on. */
const recordingLogger = () => {
  const entries = []
  const at = (level) => (message, context) => entries.push({ level, message, context })
  return {
    entries,
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    fatal: at('fatal'),
    child: () => recordingLogger(),
  }
}

/**
 * Insert a row exactly as a crashed accept path would leave it: committed, no job.
 *
 * `receivedAtOffsetMs` ages the row so the grace period can be exercised in both directions
 * without sleeping.
 */
const strandRow = async (
  client,
  { externalEventId, receivedAtOffsetMs = -120_000, eventType = 'application.import.completed' },
) => {
  const { rows } = await client.query(
    `INSERT INTO event_inbox
       (source, external_event_id, event_type, payload_hash, payload, occurred_at, received_at, correlation_id)
     VALUES ($1, $2, $3, $4, $5, now(), now() + ($6::bigint * interval '1 millisecond'), $7)
     RETURNING id`,
    [
      'helloreview_website',
      externalEventId,
      eventType,
      'a'.repeat(64),
      JSON.stringify({ applicationId: 'app_1' }),
      receivedAtOffsetMs,
      'cor_original_request',
    ],
  )
  return String(rows[0].id)
}

/**
 * Run `body` with a relay wired to an ephemeral Postgres and Redis.
 *
 * The queue comes from packages/testing's `withQueue` rather than `new Queue(...)` here: bullmq
 * resolves only from a workspace that depends on it, and tests/ does not — the same wall that put
 * createDbClient in packages/db. Building one more ad-hoc connection block would also be a fourth
 * copy of the URL-to-options mapping, which is already one too many.
 */
const withRelay = async (postgresUrl, redisUrl, body) => {
  const { createDbClient } = await importBuilt('packages/db/dist/index.js')
  const { relayStrandedEvents } = await importBuilt('apps/worker/dist/relay/inbox-relay.js')
  const { QUEUE_NAMES } = await importBuilt('packages/contracts/dist/index.js')
  const { withQueue } = await importBuilt('packages/testing/dist/index.js')

  const db = createDbClient(postgresUrl, 2)
  const logger = recordingLogger()

  try {
    return await withQueue(redisUrl, QUEUE_NAMES.PROCESS_INBOUND_EVENT, async (queue) =>
      body({
        db,
        queue,
        logger,
        run: async (options = {}) =>
          relayStrandedEvents({
            db,
            queue,
            logger,
            eventTypes: ['application.import.completed'],
            ...options,
          }),
      }),
    )
  } finally {
    await db.close()
  }
}

describe('inbox relay', () => {
  beforeAll(() => {
    for (const workspace of ['packages/contracts', 'packages/db', 'packages/observability', 'apps/worker']) {
      const build = spawnSync('node', [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'], {
        cwd: join(ROOT, workspace),
        encoding: 'utf8',
        timeout: 300_000,
      })
      expect(build.status, `${workspace} must compile:\n${build.stdout}${build.stderr}`).toBe(0)
    }
  })

  test('re-queues a stranded event that nobody retried', async () => {
    // The hole this component exists to close. Before it, a row whose enqueue never completed and
    // which no provider retried stayed invisible forever — nothing anywhere selected event_inbox by
    // status, so no operator would ever have learned it was there.
    const { withPostgres, withRedis } = await importBuilt('packages/testing/dist/index.js')
    const { applyMigrations, createDbClient } = await importBuilt('packages/db/dist/index.js')

    await withPostgres(async (postgres) => {
      await withRedis(async (redis) => {
        await applyMigrations(postgres.url)
        const seed = createDbClient(postgres.url, 1)
        const id = await strandRow(seed, { externalEventId: 'evt_stranded' })
        await seed.close()

        await withRelay(postgres.url, redis.url, async (relay) => {
          expect(await relay.queue.getWaitingCount(), 'the fixture must start with no job').toBe(0)

          const outcome = await relay.run()

          expect(outcome).toEqual({ scanned: 1, enqueued: 1 })
          expect(await relay.queue.getWaitingCount()).toBe(1)

          // The job id IS the row id, which is what makes re-running safe.
          const [job] = await relay.queue.getWaiting()
          expect(job.id).toBe(id)
          expect(job.data.inboxId).toBe(id)
          // The repaired work joins the original request's trace rather than starting a new one.
          expect(job.data.__correlationId).toBe('cor_original_request')
        })
      })
    })
  })

  test('running it twice still yields ONE job', async () => {
    // Idempotent by job id — the same property the accept path's repair relies on. Without it a
    // relay on a timer would multiply every stranded row by the number of passes.
    const { withPostgres, withRedis } = await importBuilt('packages/testing/dist/index.js')
    const { applyMigrations, createDbClient } = await importBuilt('packages/db/dist/index.js')

    await withPostgres(async (postgres) => {
      await withRedis(async (redis) => {
        await applyMigrations(postgres.url)
        const seed = createDbClient(postgres.url, 1)
        await strandRow(seed, { externalEventId: 'evt_twice' })
        await seed.close()

        await withRelay(postgres.url, redis.url, async (relay) => {
          await relay.run()
          await relay.run()
          await relay.run()

          expect(await relay.queue.getWaitingCount()).toBe(1)
        })
      })
    })
  })

  test('a row still inside the grace period is LEFT ALONE', async () => {
    // The relay must not race a healthy accept. A row seconds old is almost certainly an in-flight
    // request whose enqueue is about to succeed; touching it would mean doing redundant work on
    // every ordinary event rather than only on failures.
    const { withPostgres, withRedis } = await importBuilt('packages/testing/dist/index.js')
    const { applyMigrations, createDbClient } = await importBuilt('packages/db/dist/index.js')

    await withPostgres(async (postgres) => {
      await withRedis(async (redis) => {
        await applyMigrations(postgres.url)
        const seed = createDbClient(postgres.url, 1)
        // Received just now.
        await strandRow(seed, { externalEventId: 'evt_fresh', receivedAtOffsetMs: 0 })
        await seed.close()

        await withRelay(postgres.url, redis.url, async (relay) => {
          const outcome = await relay.run({ graceMs: 60_000 })

          expect(outcome).toEqual({ scanned: 0, enqueued: 0 })
          expect(await relay.queue.getWaitingCount()).toBe(0)
        })
      })
    })
  })

  test('leaves an unapproved external event stored without repeatedly re-queueing it', async () => {
    const { withPostgres, withRedis } = await importBuilt('packages/testing/dist/index.js')
    const { applyMigrations, createDbClient } = await importBuilt('packages/db/dist/index.js')

    await withPostgres(async (postgres) => {
      await withRedis(async (redis) => {
        await applyMigrations(postgres.url)
        const seed = createDbClient(postgres.url, 1)
        await strandRow(seed, { externalEventId: 'evt_approved_import' })
        const externalId = await strandRow(seed, {
          externalEventId: 'evt_external_deferred',
          eventType: 'kakao.message.received',
        })
        await seed.close()

        await withRelay(postgres.url, redis.url, async (relay) => {
          expect(await relay.run()).toEqual({ scanned: 1, enqueued: 1 })
          expect(await relay.queue.getWaitingCount()).toBe(1)

          const verify = createDbClient(postgres.url, 1)
          const stored = await verify.query(`SELECT status FROM event_inbox WHERE id = $1`, [externalId])
          await verify.close()
          expect(stored.rows[0]).toEqual({ status: 'received' })
        })
      })
    })
  })

  test('only `received` rows are touched — never processed, failed or dead-lettered ones', async () => {
    // Re-queueing a processed event would re-run its side effects, which §22.3 forbids ("not repeat
    // completed side effects"). Failed and dead-lettered rows belong to the operator-triggered
    // replay path, which applies its own authorization and audit record.
    const { withPostgres, withRedis } = await importBuilt('packages/testing/dist/index.js')
    const { applyMigrations, createDbClient } = await importBuilt('packages/db/dist/index.js')

    await withPostgres(async (postgres) => {
      await withRedis(async (redis) => {
        await applyMigrations(postgres.url)
        const seed = createDbClient(postgres.url, 1)
        for (const [eventId, status] of [
          ['evt_processed', 'processed'],
          ['evt_failed', 'failed'],
          ['evt_dead', 'dead_lettered'],
          ['evt_processing', 'processing'],
        ]) {
          const id = await strandRow(seed, { externalEventId: eventId })
          await seed.query(`UPDATE event_inbox SET status = $1 WHERE id = $2`, [status, id])
        }
        await strandRow(seed, { externalEventId: 'evt_received' })
        await seed.close()

        await withRelay(postgres.url, redis.url, async (relay) => {
          const outcome = await relay.run()

          expect(outcome).toEqual({ scanned: 1, enqueued: 1 })
          const [job] = await relay.queue.getWaiting()
          expect(job.data.inboxId).toBeDefined()
        })
      })
    })
  })

  test('a repair is REPORTED — this is the detection half, and it is asserted', async () => {
    // A silent repair would hide a failing accept path indefinitely. The alert is the reason this
    // component is worth more than a manual query, so it is checked rather than assumed — the
    // Phase 2 audit found three separate "and says so" tests whose only assertion was the decision.
    const { withPostgres, withRedis } = await importBuilt('packages/testing/dist/index.js')
    const { applyMigrations, createDbClient } = await importBuilt('packages/db/dist/index.js')

    await withPostgres(async (postgres) => {
      await withRedis(async (redis) => {
        await applyMigrations(postgres.url)
        const seed = createDbClient(postgres.url, 1)
        await strandRow(seed, { externalEventId: 'evt_reported' })
        await seed.close()

        await withRelay(postgres.url, redis.url, async (relay) => {
          await relay.run()

          const repair = relay.logger.entries.find((entry) => entry.context?.operation === 'inbox_relay.repair')
          expect(repair, 'a repair must be logged').toBeDefined()
          expect(repair.level, 'a repair is not routine — it means an accept path failed').toBe('warn')
          expect(repair.context).toMatchObject({
            result: 'repaired',
            reasonCode: 'STRANDED_INBOX_ROW',
            eventId: 'evt_reported',
            provider: 'helloreview_website',
          })
        })
      })
    })
  })

  test('a backlog larger than one batch DRAINS, rather than re-scanning the same rows', async () => {
    // THE BUG THIS TEST FOUND. The relay deliberately does not change `status`, so a plain
    // `ORDER BY received_at LIMIT n` returns the same oldest rows on every pass — the first version
    // re-enqueued rows 1-2 forever and never reached 3-5. It now pages with a keyset cursor, so
    // `batchSize` is the size of a database round trip and not a cap on the pass.
    const { withPostgres, withRedis } = await importBuilt('packages/testing/dist/index.js')
    const { applyMigrations, createDbClient } = await importBuilt('packages/db/dist/index.js')

    await withPostgres(async (postgres) => {
      await withRedis(async (redis) => {
        await applyMigrations(postgres.url)
        const seed = createDbClient(postgres.url, 1)
        for (let n = 0; n < 5; n += 1) await strandRow(seed, { externalEventId: `evt_batch_${String(n)}` })
        await seed.close()

        await withRelay(postgres.url, redis.url, async (relay) => {
          // One pass, paging two at a time, reaches all five.
          expect(await relay.run({ batchSize: 2 })).toEqual({ scanned: 5, enqueued: 5 })
          expect(await relay.queue.getWaitingCount()).toBe(5)

          // And is still idempotent when it runs again.
          await relay.run({ batchSize: 2 })
          expect(await relay.queue.getWaitingCount()).toBe(5)
        })
      })
    })
  })

  test('a pass stops at its cap and SAYS SO, rather than truncating silently', async () => {
    // A capped sweep that logs nothing is indistinguishable from a clean one. The next pass will
    // pick up where this stopped — but only if somebody knows there is more.
    const { withPostgres, withRedis } = await importBuilt('packages/testing/dist/index.js')
    const { applyMigrations, createDbClient } = await importBuilt('packages/db/dist/index.js')

    await withPostgres(async (postgres) => {
      await withRedis(async (redis) => {
        await applyMigrations(postgres.url)
        const seed = createDbClient(postgres.url, 1)
        for (let n = 0; n < 5; n += 1) await strandRow(seed, { externalEventId: `evt_cap_${String(n)}` })
        await seed.close()

        await withRelay(postgres.url, redis.url, async (relay) => {
          const outcome = await relay.run({ batchSize: 2, maxPerPass: 3 })

          expect(outcome.scanned).toBe(3)
          const truncation = relay.logger.entries.find((entry) => entry.context?.result === 'truncated')
          expect(truncation, 'hitting the cap must be reported').toBeDefined()
          expect(truncation.context).toMatchObject({ reasonCode: 'INBOX_RELAY_PASS_CAPPED', count: 3 })
        })
      })
    })
  })

  test('an empty inbox is a no-op that logs nothing', async () => {
    // The ordinary case, which is almost every pass. A relay that logged on every quiet pass would
    // bury the one line that matters.
    const { withPostgres, withRedis } = await importBuilt('packages/testing/dist/index.js')
    const { applyMigrations } = await importBuilt('packages/db/dist/index.js')

    await withPostgres(async (postgres) => {
      await withRedis(async (redis) => {
        await applyMigrations(postgres.url)
        await withRelay(postgres.url, redis.url, async (relay) => {
          expect(await relay.run()).toEqual({ scanned: 0, enqueued: 0 })
          expect(relay.logger.entries).toHaveLength(0)
        })
      })
    })
  })
})
