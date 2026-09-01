import type { Job } from 'bullmq'
import type { DbClient, DbTransaction } from '@helloreview/db'
import type { JobHandler } from '../runtime.js'

export const APPROVED_INTERNAL_EVENT_TYPES = ['application.import.completed'] as const

export type ApprovedInternalEventType = (typeof APPROVED_INTERNAL_EVENT_TYPES)[number]

export const INBOUND_DISPATCH_REASON = {
  INVALID_JOB_PAYLOAD: 'INBOUND_EVENT_INVALID_JOB_PAYLOAD',
  EVENT_NOT_FOUND: 'INBOUND_EVENT_NOT_FOUND',
  EVENT_TYPE_MISMATCH: 'INBOUND_EVENT_TYPE_MISMATCH',
  HANDLER_MISSING: 'INBOUND_EVENT_HANDLER_MISSING',
  HANDLER_FAILED: 'INBOUND_EVENT_HANDLER_FAILED',
  PROTECTED_AI_EVENT_REJECTED: 'INBOUND_EVENT_PROTECTED_AI_EVENT_REJECTED',
  INVALID_IMPORT_PAYLOAD: 'INBOUND_EVENT_INVALID_IMPORT_PAYLOAD',
} as const

export type InboundDispatchReason = (typeof INBOUND_DISPATCH_REASON)[keyof typeof INBOUND_DISPATCH_REASON]

export type InboundEventContext = Readonly<{
  inboxId: string
  eventType: ApprovedInternalEventType
  payload: unknown
  occurredAt: Date
  correlationId?: string
  attemptCount: number
  tx: DbTransaction
}>

export type InboundEventHandler = (context: InboundEventContext) => Promise<void>

export type InboundEventHandlers = Readonly<Partial<Record<ApprovedInternalEventType, InboundEventHandler>>>

export type ImportedApplicationWorkflowBootstrapper = Readonly<{
  bootstrap: (
    tx: DbTransaction,
    input: Readonly<{
      applicationId: string
      triggeringEventId: string
      correlationId: string
      occurredAt: Date
    }>,
  ) => Promise<void>
}>

type InboxRecord = Readonly<{
  id: string
  eventType: string
  payload: unknown
  occurredAt: Date
  correlationId?: string
  status: 'received' | 'processing' | 'processed' | 'failed' | 'dead_lettered'
  attemptCount: number
}>

type DispatchFailure = Readonly<{ error: Error; terminal: boolean }>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const REASON_CODE = /^[A-Z][A-Z0-9_]*$/
const MAX_ATTEMPTS = 5

const stringColumn = (row: Record<string, unknown>, column: string): string => {
  const value = row[column]
  if (typeof value === 'string') return value
  throw new Error(`inbound dispatcher query returned an invalid ${column}`)
}

const dateColumn = (row: Record<string, unknown>, column: string): Date => {
  const value = row[column]
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value
  throw new Error(`inbound dispatcher query returned an invalid ${column}`)
}

const integerColumn = (row: Record<string, unknown>, column: string): number => {
  const value = Number(row[column])
  if (Number.isSafeInteger(value) && value >= 0) return value
  throw new Error(`inbound dispatcher query returned an invalid ${column}`)
}

const inboxStatus = (row: Record<string, unknown>): InboxRecord['status'] => {
  const value = row.status
  if (
    value === 'received' ||
    value === 'processing' ||
    value === 'processed' ||
    value === 'failed' ||
    value === 'dead_lettered'
  ) {
    return value
  }
  throw new Error('inbound dispatcher query returned an invalid status')
}

const inboxRecord = (row: Record<string, unknown>): InboxRecord => {
  const correlationId = row.correlation_id
  if (correlationId !== null && typeof correlationId !== 'string') {
    throw new Error('inbound dispatcher query returned an invalid correlation_id')
  }
  return {
    id: stringColumn(row, 'id'),
    eventType: stringColumn(row, 'event_type'),
    payload: row.payload,
    occurredAt: dateColumn(row, 'occurred_at'),
    ...(correlationId === null ? {} : { correlationId }),
    status: inboxStatus(row),
    attemptCount: integerColumn(row, 'attempt_count'),
  }
}

const jobIdentity = (data: unknown): Readonly<{ inboxId: string; eventType?: string }> | undefined => {
  if (typeof data !== 'object' || data === null || !('inboxId' in data)) return undefined
  const carrier: Record<string, unknown> = { ...data }
  const inboxId = carrier.inboxId
  const eventType = carrier.eventType
  if (typeof inboxId !== 'string' || !UUID.test(inboxId)) return undefined
  if (eventType !== undefined && typeof eventType !== 'string') return undefined
  return { inboxId, ...(eventType === undefined ? {} : { eventType }) }
}

const approvedEventType = (value: string): ApprovedInternalEventType | undefined =>
  APPROVED_INTERNAL_EVENT_TYPES.find((candidate) => candidate === value)

const failureReason = (error: unknown): string => {
  if (typeof error !== 'object' || error === null || !('reasonCode' in error)) {
    return INBOUND_DISPATCH_REASON.HANDLER_FAILED
  }
  const carrier: Record<string, unknown> = { ...error }
  const reasonCode = carrier.reasonCode
  return typeof reasonCode === 'string' && REASON_CODE.test(reasonCode)
    ? reasonCode
    : INBOUND_DISPATCH_REASON.HANDLER_FAILED
}

export class InboundDispatchError extends Error {
  override readonly name = 'InboundDispatchError'

  constructor(
    readonly reasonCode: string,
    readonly terminal: boolean,
  ) {
    super(`Inbound event dispatch failed: ${reasonCode}`)
  }
}

export const assertInboundHandlerCoverage = (handlers: InboundEventHandlers): void => {
  for (const eventType of APPROVED_INTERNAL_EVENT_TYPES) {
    if (handlers[eventType] === undefined) {
      throw new InboundDispatchError(INBOUND_DISPATCH_REASON.HANDLER_MISSING, true)
    }
  }
  for (const eventType of Object.keys(handlers)) {
    if (eventType.startsWith('ai.') || eventType.startsWith('ocr.')) {
      throw new InboundDispatchError(INBOUND_DISPATCH_REASON.PROTECTED_AI_EVENT_REJECTED, true)
    }
  }
}

export const createProcessInboundEventHandler = (
  options: Readonly<{
    db: Pick<DbClient, 'transaction'>
    handlers: InboundEventHandlers
    now?: () => Date
    maxAttempts?: number
  }>,
): JobHandler => {
  assertInboundHandlerCoverage(options.handlers)
  const now = options.now ?? (() => new Date())
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('inbound dispatcher maxAttempts must be a positive integer')
  }

  return async (job: Job): Promise<void> => {
    const data: unknown = job.data
    const identity = jobIdentity(data)
    if (identity === undefined) {
      throw new InboundDispatchError(INBOUND_DISPATCH_REASON.INVALID_JOB_PAYLOAD, true)
    }

    const failure = await options.db.transaction<DispatchFailure | undefined>(async (tx) => {
      const selected = await tx.query(
        `SELECT id, event_type, payload, occurred_at, correlation_id, status, attempt_count
           FROM event_inbox
          WHERE id = $1
          FOR UPDATE`,
        [identity.inboxId],
      )
      const row = selected.rows[0]
      if (row === undefined) {
        return {
          error: new InboundDispatchError(INBOUND_DISPATCH_REASON.EVENT_NOT_FOUND, true),
          terminal: true,
        }
      }
      const event = inboxRecord(row)
      if (event.status === 'processed' || event.status === 'dead_lettered') return undefined

      const attemptCount = event.attemptCount + 1
      const terminal = attemptCount >= maxAttempts
      const fail = async (error: Error, reasonCode: string): Promise<DispatchFailure> => {
        await tx.query(
          `UPDATE event_inbox
              SET status = $2,
                  attempt_count = $3,
                  last_error_reason = $4,
                  processed_at = CASE WHEN $2 = 'dead_lettered' THEN $5 ELSE NULL END
            WHERE id = $1`,
          [event.id, terminal ? 'dead_lettered' : 'failed', attemptCount, reasonCode, now()],
        )
        return { error, terminal }
      }

      if (identity.eventType !== undefined && identity.eventType !== event.eventType) {
        return fail(
          new InboundDispatchError(INBOUND_DISPATCH_REASON.EVENT_TYPE_MISMATCH, terminal),
          INBOUND_DISPATCH_REASON.EVENT_TYPE_MISMATCH,
        )
      }
      const eventType = approvedEventType(event.eventType)
      if (eventType === undefined) {
        // External Kakao/Aligo/provider events already share this durable inbox and queue, but their
        // participant journeys are not approved yet. A bound import processor must not turn that
        // expected backlog into failures or dead letters. Leave the authoritative row `received`;
        // the relay is filtered to approved event types and will pick it up when its handler is
        // deliberately added to this registry.
        return undefined
      }
      const handler = options.handlers[eventType]
      if (handler === undefined) {
        return fail(
          new InboundDispatchError(INBOUND_DISPATCH_REASON.HANDLER_MISSING, terminal),
          INBOUND_DISPATCH_REASON.HANDLER_MISSING,
        )
      }

      await tx.query(
        `UPDATE event_inbox
            SET status = 'processing', attempt_count = $2, last_error_reason = NULL, processed_at = NULL
          WHERE id = $1`,
        [event.id, attemptCount],
      )
      try {
        await handler({
          inboxId: event.id,
          eventType,
          payload: event.payload,
          occurredAt: event.occurredAt,
          ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }),
          attemptCount,
          tx,
        })
      } catch (error) {
        const reasonCode = failureReason(error)
        return fail(new InboundDispatchError(reasonCode, terminal), reasonCode)
      }

      await tx.query(
        `UPDATE event_inbox
            SET status = 'processed', processed_at = $2, last_error_reason = NULL
          WHERE id = $1`,
        [event.id, now()],
      )
      return undefined
    })

    if (failure !== undefined && !failure.terminal) throw failure.error
  }
}

const importPayload = (
  payload: unknown,
): Readonly<{ batchId: string; sourceSystem: string; applicationIds: readonly string[] }> | undefined => {
  if (typeof payload !== 'object' || payload === null) return undefined
  const carrier: Record<string, unknown> = { ...payload }
  const batchId = carrier.batchId
  const sourceSystem = carrier.sourceSystem
  const applicationIds = carrier.applicationIds
  if (
    typeof batchId !== 'string' ||
    !UUID.test(batchId) ||
    typeof sourceSystem !== 'string' ||
    !/^[a-z][a-z0-9_.-]{2,63}$/.test(sourceSystem) ||
    !Array.isArray(applicationIds) ||
    !applicationIds.every((applicationId) => typeof applicationId === 'string' && UUID.test(applicationId))
  ) {
    return undefined
  }
  return { batchId, sourceSystem, applicationIds: [...new Set(applicationIds)] }
}

export const createApplicationImportCompletedHandler =
  (bootstrapper: ImportedApplicationWorkflowBootstrapper): InboundEventHandler =>
  async (context): Promise<void> => {
    const payload = importPayload(context.payload)
    if (payload === undefined) {
      throw new InboundDispatchError(INBOUND_DISPATCH_REASON.INVALID_IMPORT_PAYLOAD, false)
    }
    const correlationId = context.correlationId ?? `application-import:${payload.batchId}`
    for (const applicationId of payload.applicationIds) {
      await bootstrapper.bootstrap(context.tx, {
        applicationId,
        triggeringEventId: context.inboxId,
        correlationId,
        occurredAt: context.occurredAt,
      })
    }
  }
