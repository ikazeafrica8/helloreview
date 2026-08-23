import { createHash } from 'node:crypto'
import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common'
import { Queue } from 'bullmq'
import {
  DependencyUnavailableError,
  QUEUE_NAMES,
  type AcceptanceResponse,
  type PlatformEvent,
} from '@helloreview/contracts'
import { createLogger, currentCorrelationId, type Logger } from '@helloreview/observability'
import { redisConnectionOptions } from '@helloreview/config'
import { APP_CONFIG, type ApiConfig } from '../platform-core/index.js'
import { InboxRepository, type InboxRecord } from './inbox.repository.js'

// The accept path (PRD §10.3, §18.2, T18).
//
// The gateway's contract is narrow on purpose: an accepted event is DURABLY RECORDED and QUEUED,
// and nothing else. No business rule runs here. That keeps the webhook response fast, and — more
// importantly — makes processing retryable independently of the provider's delivery attempt, which
// is what lets a failure be replayed (§22.3) rather than lost.
//
// ORDER: RECORD, THEN ENQUEUE. Never the reverse, and the asymmetry is deliberate.
//
//   Record-then-enqueue can fail after the insert, leaving a row at status `received` with no job.
//   That is REPAIRABLE — see the duplicate path in accept(), which re-issues the enqueue.
//
//   Enqueue-then-record can fail after the enqueue, leaving a job for an event with no inbox row —
//   which will be processed with nothing to make it idempotent, and cannot be detected because
//   there is no record saying it happened.
//
// One of those failure modes leaves evidence. The other loses it. This is not a two-phase commit
// and does not pretend to be; it is a deliberate choice of which way to fail.
//
// WHAT REPAIRS THE GAP, precisely. An earlier version of this comment said the gap was recoverable
// because "§22.3's replay path selects exactly those rows". THAT PATH DOES NOT EXIST — no code
// anywhere selects event_inbox by status, and no task schedules one. The claim was doing the work
// of a mechanism while none was implemented, which meant a row committed with no job stayed that
// way forever while every redelivery was answered `queued`.
//
// The repair is now in this file: on a duplicate whose stored status is still `received`, accept()
// re-issues the enqueue with the row id as the job id. BullMQ dedupes on job id — verified: a
// second add with the same id returns the existing job and leaves the original payload untouched —
// so the call is a no-op when the job is there and closes the hole when it is not. A provider's
// ordinary retry is therefore what heals it, with no operator involvement.
//
// A bulk replay for rows no provider ever retries is still worth having, and is recorded as a task
// in tasks/todo.md rather than asserted here as though it existed.

/**
 * How long an enqueue may take before the request is failed with a 503.
 *
 * Short on purpose. The row is already committed by this point, so giving up early costs nothing
 * that a provider retry does not repair — while waiting costs a held socket and a caller with no
 * answer.
 */
const ENQUEUE_TIMEOUT_MS = 5_000

@Injectable()
export class InboxService implements OnModuleDestroy {
  private readonly logger: Logger
  private readonly queue: Queue

  constructor(
    private readonly repository: InboxRepository,
    @Inject(APP_CONFIG) config: ApiConfig,
  ) {
    this.logger = createLogger({ module: 'provider-gateway', environment: config.environment })

    // Connection OPTIONS, not an instance: BullMQ closes connections it created and never one it
    // was handed, so passing an instance leaks a socket on every close (measured in T5).
    //
    // Built by the shared helper rather than by hand. Three hand-rolled copies of this mapping all
    // silently dropped TLS, so `rediss://` would have connected in plaintext — see
    // packages/config/src/redis-connection.ts. A producer is non-blocking, so it does NOT get
    // maxRetriesPerRequest: null.
    this.queue = new Queue(QUEUE_NAMES.PROCESS_INBOUND_EVENT, {
      connection: redisConnectionOptions(config.redisUrl),
    })
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close()
  }

  /**
   * The SHA-256 of the raw request body, hex.
   *
   * Over the RAW bytes, not the parsed object: re-serialising reorders keys, so a hash of the
   * parsed form would differ between two byte-identical deliveries and be useless for the one
   * question it exists to answer.
   */
  static payloadHash(rawBody: Buffer): string {
    return createHash('sha256').update(rawBody).digest('hex')
  }

  /**
   * Accept an authenticated, validated event.
   *
   * Returns the §18.2 acceptance response. For a duplicate that is the EXISTING result — the prior
   * row's processing status — rather than a fresh claim, because the caller is entitled to know
   * what actually became of the event they sent, not merely that we have seen it.
   */
  async accept(event: PlatformEvent, rawBody: Buffer): Promise<AcceptanceResponse> {
    const correlationId = currentCorrelationId()
    const payloadHash = InboxService.payloadHash(rawBody)

    const { record, duplicate } = await this.repository.record({
      source: event.source,
      externalEventId: event.eventId,
      eventType: event.eventType,
      payloadHash,
      payload: event.payload,
      occurredAt: new Date(event.occurredAt),
      correlationId,
    })

    if (duplicate) {
      // A provider reusing an event id for DIFFERENT content is a provider bug, and an important
      // one: it means their idempotency key does not identify what we think it identifies. The
      // event is still refused as a duplicate — changing our mind would defeat the guarantee — but
      // it must not pass silently.
      if (record.payloadHash !== payloadHash) {
        this.logger.error('duplicate event id delivered with different content', {
          operation: 'provider_gateway.accept',
          result: 'conflict',
          reasonCode: 'DUPLICATE_EVENT_ID_CONTENT_MISMATCH',
          provider: event.source,
          eventId: event.eventId,
        })
      } else {
        this.logger.info('duplicate event ignored', {
          operation: 'provider_gateway.accept',
          result: 'duplicate',
          provider: event.source,
          eventId: event.eventId,
        })
      }

      // REPAIR THE GAP. If the row is still `received`, either its job is queued and this is an
      // ordinary retry, or the original enqueue never completed and the row has been stranded.
      // From here the two are indistinguishable, and that is fine: BullMQ dedupes on job id, so
      // re-issuing is a no-op in the first case and the fix in the second.
      //
      // Without this, a row committed with no job stays that way forever while every redelivery is
      // answered `queued` — the API asserting a state it never verified, and the provider stopping
      // its retries on the strength of it.
      if (record.status === 'received') await this.enqueue(record, correlationId)

      return this.response(record.externalEventId, true, record.status, correlationId)
    }

    await this.enqueue(record, correlationId)

    this.logger.info('event accepted', {
      operation: 'provider_gateway.accept',
      result: 'ok',
      provider: event.source,
      eventId: event.eventId,
    })

    return this.response(record.externalEventId, false, record.status, correlationId)
  }

  /**
   * Queue the row for processing, bounded in time.
   *
   * THE TIMEOUT IS THE POINT. `queue.add()` does not reject when Redis is unreachable — it waits
   * for a connection that may never come. Measured against an unreachable port: still pending after
   * eight seconds with `maxRetriesPerRequest` set to null AND to 1, so this is not a retry-setting
   * problem and cannot be fixed by one. Without a bound the webhook request holds a socket and its
   * buffered body open indefinitely, returns nothing, and the provider's own timeout is the only
   * thing that ends it.
   *
   * Failure is reported as 503, not 500. §18.4 reserves 503 for "temporary dependency or service
   * outage", which is exactly this, and the distinction matters to the caller: a provider retries a
   * 503 and escalates a 500. The inbox row is already committed at that point, so the retry is also
   * what repairs it.
   *
   * The job carries the inbox row id rather than the payload. The payload is already durably in
   * Postgres, and copying it onto the queue would put participant data in Redis, where §21.6
   * retention does not reach.
   */
  private async enqueue(record: InboxRecord, correlationId: string | undefined): Promise<void> {
    let timer: NodeJS.Timeout | undefined

    const add = this.queue.add(
      'process-inbound-event',
      { inboxId: record.id, eventType: record.eventType, __correlationId: correlationId },
      {
        // The inbox row id is the job id. That is what makes the repair above safe, and it means a
        // retry of this very call cannot create a second job.
        jobId: record.id,
        attempts: 5,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: { age: 86_400, count: 10_000 },
        // Bounded, unlike `false`. A failed job kept forever grows the queue without limit, and the
        // dead-letter window that matters for §22.4 is days, not indefinitely.
        removeOnFail: { age: 604_800, count: 10_000 },
      },
    )

    // The loser of the race must not become an unhandled rejection and take the process down.
    add.catch(() => undefined)

    try {
      await Promise.race([
        add,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error('enqueue timed out'))
          }, ENQUEUE_TIMEOUT_MS)
        }),
      ])
    } catch {
      // The error is deliberately not interpolated: an ioredis failure message can carry the
      // connection string, and that carries a password (PRD §21.4).
      this.logger.error('could not queue an accepted event', {
        operation: 'provider_gateway.enqueue',
        result: 'error',
        reasonCode: 'QUEUE_UNAVAILABLE',
        eventId: record.externalEventId,
      })
      throw new DependencyUnavailableError('could not queue the event for processing', 'QUEUE_UNAVAILABLE')
    } finally {
      clearTimeout(timer)
    }
  }

  private response(
    eventId: string,
    duplicate: boolean,
    status: string,
    correlationId: string | undefined,
  ): AcceptanceResponse {
    // The inbox status vocabulary is wider than §18.2's: `received` and `dead_lettered` have no
    // wire equivalent. Mapping rather than passing through keeps the public contract stable while
    // the internal lifecycle grows.
    const processingStatus =
      status === 'processed'
        ? 'processed'
        : status === 'failed' || status === 'dead_lettered'
          ? 'failed'
          : status === 'processing'
            ? 'processing'
            : 'queued'

    return {
      accepted: true,
      event_id: eventId,
      duplicate,
      ...(correlationId === undefined ? {} : { correlation_id: correlationId }),
      processing_status: processingStatus,
    }
  }
}
