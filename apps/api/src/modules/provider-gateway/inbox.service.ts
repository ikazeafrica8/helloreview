import { createHash } from 'node:crypto'
import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common'
import { Queue } from 'bullmq'
import { QUEUE_NAMES, type AcceptanceResponse, type PlatformEvent } from '@helloreview/contracts'
import { createLogger, currentCorrelationId, type Logger } from '@helloreview/observability'
import { APP_CONFIG, type ApiConfig } from '../platform-core/index.js'
import { InboxRepository } from './inbox.repository.js'

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
//   That is RECOVERABLE: §22.3's replay path selects exactly those rows, which is why the status
//   column and its index exist.
//
//   Enqueue-then-record can fail after the enqueue, leaving a job for an event with no inbox row —
//   which will be processed with nothing to make it idempotent, and cannot be detected because
//   there is no record saying it happened.
//
// One of those failure modes leaves evidence. The other loses it. This is not a two-phase commit
// and does not pretend to be; it is a deliberate choice of which way to fail.

@Injectable()
export class InboxService implements OnModuleDestroy {
  private readonly logger: Logger
  private readonly queue: Queue

  constructor(
    private readonly repository: InboxRepository,
    @Inject(APP_CONFIG) config: ApiConfig,
  ) {
    this.logger = createLogger({ module: 'provider-gateway', environment: config.environment })

    const url = new URL(config.redisUrl)
    const database = url.pathname.replace(/^\//, '')
    // Connection OPTIONS, not an instance: BullMQ closes connections it created and never one it
    // was handed, so passing an instance leaks a socket on every close (measured in T5).
    this.queue = new Queue(QUEUE_NAMES.PROCESS_INBOUND_EVENT, {
      connection: {
        host: url.hostname,
        port: url.port === '' ? 6379 : Number(url.port),
        ...(url.username === '' ? {} : { username: decodeURIComponent(url.username) }),
        ...(url.password === '' ? {} : { password: decodeURIComponent(url.password) }),
        ...(database === '' ? {} : { db: Number(database) }),
        maxRetriesPerRequest: null,
      },
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

      return this.response(record.externalEventId, true, record.status, correlationId)
    }

    // New. Exactly one job, carrying the inbox row id rather than the payload: the payload is
    // already durably stored, and putting it on the queue too would duplicate participant data
    // into Redis, where §21.6 retention does not reach.
    await this.queue.add(
      'process-inbound-event',
      { inboxId: record.id, eventType: record.eventType, __correlationId: correlationId },
      {
        // The inbox row id is the job id, so even a retry of THIS enqueue cannot create a second
        // job. Belt and braces: the unique constraint already stopped a second row existing.
        jobId: record.id,
        attempts: 5,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: { age: 86_400, count: 10_000 },
        removeOnFail: false,
      },
    )

    this.logger.info('event accepted', {
      operation: 'provider_gateway.accept',
      result: 'ok',
      provider: event.source,
      eventId: event.eventId,
    })

    return this.response(record.externalEventId, false, record.status, correlationId)
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
