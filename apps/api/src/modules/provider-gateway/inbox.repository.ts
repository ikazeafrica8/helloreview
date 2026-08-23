import { Inject, Injectable } from '@nestjs/common'
import { Pool } from 'pg'
import { POSTGRES_POOL } from '../platform-core/index.js'

// Persisting an inbound event exactly once (PRD §17.3, §22.3, T18).
//
// THE WHOLE DESIGN IS "LET THE DATABASE REFUSE". The obvious implementation — SELECT to see whether
// we have it, then INSERT if not — is wrong in a way that passes every sequential test: two
// concurrent deliveries of a provider's retry both SELECT before either INSERTs, both find nothing,
// and both proceed. The window is small and a provider's retry storm is exactly the condition that
// finds it.
//
// `INSERT ... ON CONFLICT DO NOTHING RETURNING *` collapses the check and the write into one
// statement the database executes atomically. It returns a row when we inserted, and nothing when
// somebody else already had. That empty result IS the duplicate signal — no exception, no second
// guess.
//
// WHY NOT `ON CONFLICT DO UPDATE`. The trick of `DO UPDATE SET source = EXCLUDED.source` to force a
// RETURNING on conflict is tempting and wrong here: it WRITES on every duplicate, which for a
// provider retrying aggressively means unbounded row versions and dead tuples on the hottest table
// in the system, in exchange for saving one SELECT that only runs on the duplicate path.

export type InboxRecord = Readonly<{
  id: string
  source: string
  externalEventId: string
  eventType: string
  payloadHash: string
  status: string
  occurredAt: Date
  receivedAt: Date
  correlationId: string | null
}>

export type InboxInsertResult = Readonly<{
  record: InboxRecord
  /** False when this call inserted the row; true when it was already there. */
  duplicate: boolean
}>

export type NewInboxEvent = Readonly<{
  source: string
  externalEventId: string
  eventType: string
  payloadHash: string
  payload: unknown
  occurredAt: Date
  correlationId?: string | undefined
}>

const COLUMNS = `id, source, external_event_id, event_type, payload_hash, status, occurred_at, received_at, correlation_id`

// Reading a row without asserting a shape onto it.
//
// pg types every column `any`, so `String(value)` would compile on anything — including an object,
// which stringifies to "[object Object]" and would be stored and logged as though it were an id.
// These narrow honestly and throw on a surprise, because a column that is not the type the schema
// says it is means the row is not what this code thinks it is, and continuing would propagate that
// misunderstanding into business state.

const asString = (value: unknown, column: string): string => {
  if (typeof value === 'string') return value
  throw new Error(`event_inbox.${column} was not a string`)
}

const asDate = (value: unknown, column: string): Date => {
  // node-postgres returns timestamptz as a Date. A string is accepted too, because a pool
  // configured with a custom type parser would hand one over and failing there would be gratuitous.
  if (value instanceof Date) return value
  if (typeof value === 'string') return new Date(value)
  throw new Error(`event_inbox.${column} was not a timestamp`)
}

/** Absent stays absent. An unexpected type is treated as absent rather than coerced into nonsense. */
const asNullableString = (value: unknown): string | null => (typeof value === 'string' ? value : null)

const toRecord = (row: Record<string, unknown>): InboxRecord => ({
  id: asString(row.id, 'id'),
  source: asString(row.source, 'source'),
  externalEventId: asString(row.external_event_id, 'external_event_id'),
  eventType: asString(row.event_type, 'event_type'),
  payloadHash: asString(row.payload_hash, 'payload_hash'),
  status: asString(row.status, 'status'),
  occurredAt: asDate(row.occurred_at, 'occurred_at'),
  receivedAt: asDate(row.received_at, 'received_at'),
  correlationId: asNullableString(row.correlation_id),
})

@Injectable()
export class InboxRepository {
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  /**
   * Record an event, or report that we already had it.
   *
   * Never throws on a duplicate. A duplicate is the expected, ordinary case — every webhook
   * provider retries — and modelling the normal path as an exception would mean the accept path's
   * correctness depended on catching the right error class from a driver that has already changed
   * where it puts the SQLSTATE once.
   */
  async record(event: NewInboxEvent): Promise<InboxInsertResult> {
    const inserted = await this.pool.query<Record<string, unknown>>(
      `INSERT INTO event_inbox
         (source, external_event_id, event_type, payload_hash, payload, occurred_at, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (source, external_event_id) DO NOTHING
       RETURNING ${COLUMNS}`,
      [
        event.source,
        event.externalEventId,
        event.eventType,
        event.payloadHash,
        JSON.stringify(event.payload),
        event.occurredAt,
        event.correlationId ?? null,
      ],
    )

    const row = inserted.rows[0]
    if (row !== undefined) return { record: toRecord(row), duplicate: false }

    // Conflict. Read what is already there — §18.2 requires a duplicate to return the EXISTING
    // accepted result, so the prior row's status is the answer, not a freshly invented one.
    const existing = await this.pool.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM event_inbox WHERE source = $1 AND external_event_id = $2`,
      [event.source, event.externalEventId],
    )

    const priorRow = existing.rows[0]
    if (priorRow === undefined) {
      // The insert conflicted and the row is gone: only possible if something deleted it between
      // the two statements. Refusing loudly is right — silently retrying would loop, and inventing
      // a response would claim an acceptance that is not recorded anywhere.
      throw new Error('event_inbox conflict resolved to no row; the inbox is being mutated concurrently')
    }

    return { record: toRecord(priorRow), duplicate: true }
  }
}
