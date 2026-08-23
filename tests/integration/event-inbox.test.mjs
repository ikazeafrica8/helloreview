// Integration tier: the event inbox and the constraint that is the actual idempotency guarantee (T15).
//
// PRD §17.3 lists `UNIQUE(event_inbox.source, event_inbox.external_event_id)` first among the
// required constraints, and the ordering is not accidental. Every other defence against duplicate
// processing — a check-then-insert, a cache, a queue-level dedupe — is advisory: two requests that
// interleave between the check and the insert both pass. Only the database can refuse.
//
// So these tests run against a REAL migrated Postgres, not a mock. A test that asserts a Drizzle
// schema object contains a `unique()` call proves the source code says the right thing; it does not
// prove the constraint reached the database, which is the only place it does any work.

import { test, describe, beforeAll, expect } from 'vitest'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = dirname(dirname(import.meta.dirname))
const importBuilt = async (relativePath) => import(pathToFileURL(join(ROOT, relativePath)).href)

/** A row with every required column, so each test varies only the field it is about. */
const anEvent = (overrides = {}) => ({
  source: 'helloreview_website',
  externalEventId: 'evt_01JEXAMPLE',
  eventType: 'application.created',
  payloadHash: 'a'.repeat(64),
  occurredAt: new Date('2026-08-22T10:30:00+09:00'),
  payload: { application_id: 'app_123' },
  ...overrides,
})

describe('event inbox', () => {
  beforeAll(() => {
    for (const workspace of ['packages/contracts', 'packages/db', 'packages/testing']) {
      const build = spawnSync('node', [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'], {
        cwd: join(ROOT, workspace),
        encoding: 'utf8',
        timeout: 300_000,
      })
      expect(build.status, `${workspace} must compile:\n${build.stdout}${build.stderr}`).toBe(0)
    }
  })

  test('T15 criterion 1: a second insert of the same source and external id is REFUSED by the database', async () => {
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    const { applyMigrations, createDbClient, eventInbox, isUniqueViolation, sqlStateOf, violatedConstraint } =
      await importBuilt('packages/db/dist/index.js')

    await withPostgres(async ({ url }) => {
      await applyMigrations(url)
      const client = createDbClient(url)
      const { db } = client
      try {
        await db.insert(eventInbox).values(anEvent())

        // The same event, delivered twice — a provider retry, which every webhook provider does.
        let rejected
        try {
          await db.insert(eventInbox).values(anEvent())
          rejected = undefined
        } catch (error) {
          rejected = error
        }

        expect(rejected, 'the database accepted a duplicate (source, external_event_id)').toBeDefined()

        // The refusal is NOT on the thrown error. drizzle-orm 0.45 throws DrizzleQueryError, which
        // has no `code` at all — the pg DatabaseError carrying SQLSTATE 23505 is its `cause`.
        // `rejected.code === '23505'` is therefore always false, silently, which would turn every
        // duplicate into a 500. Asserting both spellings here is what pins that down.
        expect(rejected.code, 'the wrapper carries no code — this is why sqlStateOf walks the cause chain').toBe(
          undefined,
        )
        expect(sqlStateOf(rejected)).toBe('23505')
        expect(violatedConstraint(rejected)).toBe('event_inbox_source_external_id_key')

        // What the accept path in T18 actually calls. Naming the constraint matters: a unique
        // violation on some OTHER constraint means something unexpected happened and must not be
        // swallowed as a successful duplicate.
        expect(isUniqueViolation(rejected, 'event_inbox_source_external_id_key')).toBe(true)
        expect(isUniqueViolation(rejected, 'some_other_constraint')).toBe(false)

        const { rows } = await client.query('SELECT count(*)::int AS n FROM event_inbox')
        expect(rows[0].n, 'exactly one row must survive a duplicate delivery').toBe(1)
      } finally {
        await client.close()
      }
    })
  })

  test('the same external id from a DIFFERENT source is a different event', async () => {
    // The constraint is on the PAIR. Two providers each numbering their events from 1 is normal,
    // and a constraint on external_event_id alone would silently drop the second provider's
    // traffic — a failure that looks exactly like successful deduplication.
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    const { applyMigrations, createDbClient, eventInbox } = await importBuilt('packages/db/dist/index.js')

    await withPostgres(async ({ url }) => {
      await applyMigrations(url)
      const client = createDbClient(url)
      const { db } = client
      try {
        await db.insert(eventInbox).values(anEvent({ source: 'helloreview_website' }))
        await db.insert(eventInbox).values(anEvent({ source: 'official_kakao_provider' }))

        const { rows } = await client.query('SELECT count(*)::int AS n FROM event_inbox')
        expect(rows[0].n).toBe(2)
      } finally {
        await client.close()
      }
    })
  })

  test('T15 criterion 2: every column §22.3 replay needs is present and required', async () => {
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    const { applyMigrations, createDbClient } = await importBuilt('packages/db/dist/index.js')

    await withPostgres(async ({ url }) => {
      await applyMigrations(url)
      const client = createDbClient(url)
      try {
        const { rows } = await client.query(
          `SELECT column_name, is_nullable FROM information_schema.columns
            WHERE table_name = 'event_inbox'`,
        )
        const nullable = new Map(rows.map((row) => [row.column_name, row.is_nullable === 'YES']))

        // §22.3: replay must "use the original event ID" and "preserve the original occurred-at
        // time". Both are therefore NOT NULL — a replay that has to invent either is not a replay.
        for (const column of [
          'source',
          'external_event_id',
          'event_type',
          'payload_hash',
          'occurred_at',
          'received_at',
          'status',
        ]) {
          expect(nullable.has(column), `event_inbox is missing ${column}`).toBe(true)
          expect(nullable.get(column), `${column} must be NOT NULL`).toBe(false)
        }

        // Nullable by nature: unknown until the event has been worked.
        for (const column of ['processed_at', 'last_error_reason']) {
          expect(nullable.has(column), `event_inbox is missing ${column}`).toBe(true)
          expect(nullable.get(column), `${column} must be nullable — it is unknown on arrival`).toBe(true)
        }
      } finally {
        await client.close()
      }
    })
  })

  test('T15 criterion 3: a failed event stays queryable for replay, with its attempt history', async () => {
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    const { applyMigrations, createDbClient, eventInbox, eq } = await importBuilt('packages/db/dist/index.js')

    await withPostgres(async ({ url }) => {
      await applyMigrations(url)
      const client = createDbClient(url)
      const { db } = client
      try {
        await db.insert(eventInbox).values(anEvent({ externalEventId: 'evt_fails' }))

        // Processing fails. §22.4 sends it to the dead-letter queue after the retry limit, but the
        // ROW must remain — a failed event that is deleted cannot be replayed, and §22.3 requires
        // replay of "unprocessed inbound events".
        await db
          .update(eventInbox)
          .set({ status: 'failed', attemptCount: 3, lastErrorReason: 'DOWNSTREAM_UNAVAILABLE' })
          .where(eq(eventInbox.externalEventId, 'evt_fails'))

        const failed = await db.select().from(eventInbox).where(eq(eventInbox.status, 'failed'))

        expect(failed).toHaveLength(1)
        expect(failed[0].attemptCount).toBe(3)
        expect(failed[0].lastErrorReason).toBe('DOWNSTREAM_UNAVAILABLE')
        // The original occurred-at survives the failure, which is what makes a replay faithful.
        expect(failed[0].occurredAt.toISOString()).toBe(new Date('2026-08-22T10:30:00+09:00').toISOString())
      } finally {
        await client.close()
      }
    })
  })

  test('the status column rejects a value outside the modelled set', async () => {
    // An enum rather than free text. A typo'd status is indistinguishable from a new one, and the
    // replay query selects BY status — so a row with status 'faild' is invisible to replay forever.
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    const { applyMigrations, createDbClient } = await importBuilt('packages/db/dist/index.js')

    await withPostgres(async ({ url }) => {
      await applyMigrations(url)
      const client = createDbClient(url)
      try {
        await expect(
          client.query(
            `INSERT INTO event_inbox (source, external_event_id, event_type, payload_hash, occurred_at, status)
             VALUES ('s', 'e', 'application.created', repeat('a', 64), now(), 'faild')`,
          ),
        ).rejects.toThrow()
      } finally {
        await client.close()
      }
    })
  })

  test('the replay query is indexed, because it runs over the whole table', async () => {
    // Selecting failed events is the replay path's only entry point (§22.3). Without an index it is
    // a sequential scan over every event the platform has ever received — fine at 100 rows, and the
    // kind of thing nobody notices until it is not.
    const { withPostgres } = await importBuilt('packages/testing/dist/index.js')
    const { applyMigrations, createDbClient } = await importBuilt('packages/db/dist/index.js')

    await withPostgres(async ({ url }) => {
      await applyMigrations(url)
      const client = createDbClient(url)
      try {
        const { rows } = await client.query(`SELECT indexdef FROM pg_indexes WHERE tablename = 'event_inbox'`)
        const definitions = rows.map((row) => row.indexdef).join('\n')
        expect(definitions, 'event_inbox needs an index on status for the replay query').toMatch(/\(status/)
      } finally {
        await client.close()
      }
    })
  })
})
