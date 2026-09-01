import type { Queue } from 'bullmq'
import type { DbClient } from '@helloreview/db'
import type { Logger } from '@helloreview/observability'

// The inbox relay: the half of the transactional outbox that makes the other half safe to fail.
//
// WHAT THIS IS, AND WHY IT IS NOT A CLEANUP JOB. PRD FR-MSG-004 requires a transactional outbox for
// outbound messages — "state and send intent commit together". The inbound side has the same shape,
// and only half of it was built:
//
//   - The inbox row IS the intent. `status = 'received'` means, exactly, "this needs processing".
//   - PRD §17.1 makes PostgreSQL the authoritative store. The queue is a DERIVED VIEW of it.
//   - So the `queue.add()` inside the accept path is a LATENCY OPTIMISATION, not the guarantee.
//   - This relay is the guarantee.
//
// Before it existed, the correctness argument rested on "a provider retries a 503" — a claim about
// somebody else's code, which is not a guarantee at all. A row whose enqueue never completed, and
// which nobody retried, stayed invisible forever: no code selected event_inbox by status, so
// nothing would ever have told an operator it was there.
//
// THREE THINGS FALL OUT OF ONE LOOP: recovery (the row gets queued regardless of who retries),
// detection (a repair is logged, which is the alert that did not exist), and the shape §22.3's
// operator-triggered replay will reuse — the same query with a different filter.
//
// IT DELIBERATELY DOES NOT CHANGE `status`. Marking rows as "claimed" before enqueuing would create
// a NEW stranded state — a crash between the mark and the enqueue — which is the exact bug being
// fixed, moved up one level. The row stays `received` until a consumer genuinely processes it, and
// re-enqueueing is harmless because the job id is the row id.

export type InboxRelayOptions = Readonly<{
  db: DbClient
  queue: Queue
  logger: Logger
  /** Only event types whose complete worker handler is currently enabled. */
  eventTypes: readonly string[]
  /**
   * How old a `received` row must be before the relay touches it.
   *
   * MUST exceed the accept path's enqueue timeout, or the relay races a request that is still
   * healthily in flight and does redundant work on every ordinary event. The accept path bounds
   * itself at 5s; a minute leaves ample room and still repairs quickly enough to matter.
   */
  graceMs?: number
  /**
   * Rows per database round trip. NOT a cap on the pass — see `maxPerPass`.
   *
   * The distinction matters, and getting it wrong was a real bug caught by this component's own
   * test: because the relay deliberately does not change `status`, a plain `ORDER BY received_at
   * LIMIT n` returns the SAME oldest rows on every pass. A backlog larger than one batch would have
   * re-enqueued the first n rows forever and never reached the rest. The relay now pages through
   * the eligible set with a keyset cursor.
   */
  batchSize?: number
  /**
   * The most rows one pass will repair before stopping.
   *
   * A pass is bounded so a pathological backlog cannot monopolise the worker. Hitting the cap is
   * LOGGED rather than silent: a truncated sweep that says nothing reads exactly like a clean one.
   */
  maxPerPass?: number
}>

export type RelayOutcome = Readonly<{ scanned: number; enqueued: number }>

const DEFAULT_GRACE_MS = 60_000
const DEFAULT_BATCH_SIZE = 200
const DEFAULT_MAX_PER_PASS = 5_000

const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

/**
 * Enqueue every inbound event that is durably recorded but has no job.
 *
 * Safe to run concurrently with itself and with the accept path. Every enqueue uses the inbox row
 * id as the BullMQ job id, and BullMQ treats a repeat id as a no-op returning the existing job —
 * verified directly rather than assumed. So two relay instances, or a relay racing a provider's
 * retry, converge on exactly one job.
 */
export const relayStrandedEvents = async (options: InboxRelayOptions): Promise<RelayOutcome> => {
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
  const maxPerPass = options.maxPerPass ?? DEFAULT_MAX_PER_PASS
  if (options.eventTypes.length === 0) throw new Error('inbox relay requires at least one enabled event type')

  let scanned = 0
  let enqueued = 0
  // Keyset cursor. Paging by OFFSET would be wrong as well as slow: rows are being inserted while
  // this runs, so an offset silently skips.
  let cursor: string | undefined

  while (scanned < maxPerPass) {
    const { rows } = await options.db.query(
      `SELECT id, event_type, external_event_id, source, correlation_id, received_at
         FROM event_inbox
        WHERE status = 'received'
          AND event_type = ANY($4::text[])
          AND received_at < now() - ($1::bigint * interval '1 millisecond')
          AND ($3::uuid IS NULL OR id > $3::uuid)
        ORDER BY id
        LIMIT $2`,
      [graceMs, Math.min(batchSize, maxPerPass - scanned), cursor ?? null, options.eventTypes],
    )

    if (rows.length === 0) break

    for (const row of rows) {
      scanned += 1
      cursor = asString(row.id) ?? cursor

      const inboxId = asString(row.id)
      const eventType = asString(row.event_type)
      if (inboxId === undefined || eventType === undefined) continue

      await options.queue.add(
        'process-inbound-event',
        {
          inboxId,
          eventType,
          // The correlation id of the request that originally accepted the event, so the repaired
          // work joins that trace rather than starting a new one (§23.1).
          __correlationId: asString(row.correlation_id),
        },
        {
          jobId: inboxId,
          attempts: 5,
          backoff: { type: 'exponential', delay: 1_000 },
          removeOnComplete: { age: 86_400, count: 10_000 },
          removeOnFail: { age: 604_800, count: 10_000 },
        },
      )
      enqueued += 1

      // One line per repair, at WARN. A repair is not routine: it means an accept path failed to
      // enqueue and nothing noticed until now. Logging it is the detection half of this component,
      // and silence here is what let the gap stay invisible.
      const externalEventId = asString(row.external_event_id)
      const source = asString(row.source)
      options.logger.warn('re-queued an inbound event that had no job', {
        operation: 'inbox_relay.repair',
        result: 'repaired',
        reasonCode: 'STRANDED_INBOX_ROW',
        // Spread rather than assigned: under exactOptionalPropertyTypes an optional field may be
        // ABSENT but may not be present-and-undefined, and these come from nullable columns.
        ...(externalEventId === undefined ? {} : { eventId: externalEventId }),
        ...(source === undefined ? {} : { provider: source }),
      })
    }

    if (rows.length < batchSize) break
  }

  if (scanned >= maxPerPass) {
    // NO SILENT TRUNCATION. A capped sweep that says nothing is indistinguishable from a clean one,
    // and the next pass will pick up where this stopped — but only if somebody knows to look.
    options.logger.warn('inbox relay stopped at its per-pass cap; more may remain', {
      operation: 'inbox_relay.pass',
      result: 'truncated',
      reasonCode: 'INBOX_RELAY_PASS_CAPPED',
      count: scanned,
    })
  }

  return { scanned, enqueued }
}

/**
 * Run the relay on a timer until stopped.
 *
 * A plain interval rather than a BullMQ repeatable job, deliberately: this component exists to
 * repair the queue, so scheduling it THROUGH the queue would make its own recovery depend on the
 * thing it recovers. A failed pass is logged and the next one simply tries again — one bad pass
 * must never stop the loop, because that would silently retire the guarantee.
 *
 * Several worker instances may run it at once. That costs a little redundant work and nothing else,
 * because every enqueue is idempotent by job id.
 */
export const startInboxRelay = (options: InboxRelayOptions & { intervalMs?: number }): { stop: () => void } => {
  const intervalMs = options.intervalMs ?? 30_000
  let running = false

  const pass = () => {
    // Never overlap with itself: a slow pass on a large backlog would otherwise stack up.
    if (running) return
    running = true

    relayStrandedEvents(options)
      .then((outcome) => {
        if (outcome.enqueued > 0) {
          options.logger.warn('inbox relay repaired stranded events', {
            operation: 'inbox_relay.pass',
            result: 'repaired',
            count: outcome.enqueued,
          })
        }
      })
      .catch(() => {
        // The error is deliberately not interpolated: a driver failure message can carry the
        // connection string, and that carries a password (PRD §21.4).
        options.logger.error('inbox relay pass failed', {
          operation: 'inbox_relay.pass',
          result: 'error',
          reasonCode: 'INBOX_RELAY_PASS_FAILED',
        })
      })
      .finally(() => {
        running = false
      })
  }

  const timer = setInterval(pass, intervalMs)
  // unref so the relay never by itself keeps the process alive; the worker's own keepAlive owns
  // that decision.
  timer.unref()

  return {
    stop: () => {
      clearInterval(timer)
    },
  }
}
