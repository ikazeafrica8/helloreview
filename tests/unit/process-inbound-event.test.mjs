import { describe, expect, test, vi } from 'vitest'
import {
  INBOUND_DISPATCH_REASON,
  InboundDispatchError,
  assertInboundHandlerCoverage,
  createApplicationImportCompletedHandler,
  createProcessInboundEventHandler,
} from '../../apps/worker/dist/processors/index.js'

const inboxId = '11111111-1111-4111-8111-111111111111'
const batchId = '22222222-2222-4222-8222-222222222222'
const applicationId = '33333333-3333-4333-8333-333333333333'
const occurredAt = new Date('2026-08-24T01:00:00Z')

const harness = ({
  payload,
  attemptCount = 0,
  status = 'received',
  eventType = 'application.import.completed',
} = {}) => {
  const state = {
    id: inboxId,
    event_type: eventType,
    payload: payload ?? {
      batchId,
      sourceSystem: 'helloreview_website',
      applicationIds: [applicationId, applicationId],
    },
    occurred_at: occurredAt,
    correlation_id: 'correlation-import',
    status,
    attempt_count: attemptCount,
    last_error_reason: null,
    processed_at: null,
  }
  const queries = []
  const tx = {
    query: async (sql, values = []) => {
      queries.push({ sql, values })
      if (sql.includes('SELECT id, event_type')) return { rows: [{ ...state }] }
      if (sql.includes("SET status = 'processing'")) {
        state.status = 'processing'
        state.attempt_count = values[1]
        state.last_error_reason = null
        return { rows: [] }
      }
      if (sql.includes("SET status = 'processed'")) {
        state.status = 'processed'
        state.processed_at = values[1]
        state.last_error_reason = null
        return { rows: [] }
      }
      if (sql.includes('SET status = $2')) {
        state.status = values[1]
        state.attempt_count = values[2]
        state.last_error_reason = values[3]
        state.processed_at = values[4]
        return { rows: [] }
      }
      throw new Error(`unexpected query: ${sql}`)
    },
  }
  return {
    state,
    queries,
    db: { transaction: async (operation) => operation(tx) },
  }
}

describe('durable inbound event dispatcher', () => {
  test('bootstraps each imported application once and marks a replay as already processed', async () => {
    const testHarness = harness()
    const bootstrap = vi.fn(async () => undefined)
    const importHandler = createApplicationImportCompletedHandler({ bootstrap })
    const processor = createProcessInboundEventHandler({
      db: testHarness.db,
      handlers: { 'application.import.completed': importHandler },
      now: () => new Date('2026-08-24T01:05:00Z'),
    })
    const job = { data: { inboxId, eventType: 'application.import.completed' } }

    await processor(job)
    await processor(job)

    expect(bootstrap).toHaveBeenCalledTimes(1)
    expect(bootstrap.mock.calls[0][1]).toMatchObject({
      applicationId,
      triggeringEventId: inboxId,
      correlationId: 'correlation-import',
      occurredAt,
    })
    expect(testHarness.state).toMatchObject({ status: 'processed', attempt_count: 1, last_error_reason: null })
  })

  test('commits retry evidence, then dead-letters without repeating after the terminal attempt', async () => {
    const testHarness = harness()
    const handler = vi.fn(async () => {
      throw Object.assign(new Error('private diagnostic not persisted'), { reasonCode: 'BOOTSTRAP_TEMPORARY' })
    })
    const processor = createProcessInboundEventHandler({
      db: testHarness.db,
      handlers: { 'application.import.completed': handler },
      maxAttempts: 2,
      now: () => new Date('2026-08-24T01:05:00Z'),
    })
    const job = { data: { inboxId, eventType: 'application.import.completed' } }

    await expect(processor(job)).rejects.toMatchObject({ reasonCode: 'BOOTSTRAP_TEMPORARY', terminal: false })
    expect(testHarness.state).toMatchObject({
      status: 'failed',
      attempt_count: 1,
      last_error_reason: 'BOOTSTRAP_TEMPORARY',
    })
    await processor(job)
    await processor(job)
    expect(testHarness.state).toMatchObject({
      status: 'dead_lettered',
      attempt_count: 2,
      last_error_reason: 'BOOTSTRAP_TEMPORARY',
    })
    expect(handler).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(testHarness.queries)).not.toContain('private diagnostic')
  })

  test('rejects a mismatched queue hint without invoking the domain handler', async () => {
    const testHarness = harness()
    const handler = vi.fn(async () => undefined)
    const processor = createProcessInboundEventHandler({
      db: testHarness.db,
      handlers: { 'application.import.completed': handler },
      maxAttempts: 1,
    })
    await processor({ data: { inboxId, eventType: 'application.updated' } })
    expect(handler).not.toHaveBeenCalled()
    expect(testHarness.state).toMatchObject({
      status: 'dead_lettered',
      last_error_reason: INBOUND_DISPATCH_REASON.EVENT_TYPE_MISMATCH,
    })
  })

  test('leaves an unapproved external event received without invoking or dead-lettering it', async () => {
    const externalEventType = 'kakao.message.received'
    const testHarness = harness({ eventType: externalEventType })
    const handler = vi.fn(async () => undefined)
    const processor = createProcessInboundEventHandler({
      db: testHarness.db,
      handlers: { 'application.import.completed': handler },
      maxAttempts: 1,
    })

    await processor({ data: { inboxId, eventType: externalEventType } })

    expect(handler).not.toHaveBeenCalled()
    expect(testHarness.state).toMatchObject({
      status: 'received',
      attempt_count: 0,
      last_error_reason: null,
      processed_at: null,
    })
  })

  test('fails startup when an approved handler is missing or an AI/OCR event is registered', () => {
    expect(() => assertInboundHandlerCoverage({})).toThrowError(InboundDispatchError)
    expect(() =>
      assertInboundHandlerCoverage({
        'application.import.completed': async () => undefined,
        'ai.protected.command': async () => undefined,
      }),
    ).toThrowError(expect.objectContaining({ reasonCode: INBOUND_DISPATCH_REASON.PROTECTED_AI_EVENT_REJECTED }))
  })

  test('invalid minimized import payload retries through a reason code without bootstrapping', async () => {
    const testHarness = harness({ payload: { batchId, sourceSystem: 'helloreview_website', applicationIds: ['bad'] } })
    const bootstrap = vi.fn(async () => undefined)
    const processor = createProcessInboundEventHandler({
      db: testHarness.db,
      handlers: { 'application.import.completed': createApplicationImportCompletedHandler({ bootstrap }) },
    })
    await expect(processor({ data: { inboxId } })).rejects.toMatchObject({
      reasonCode: INBOUND_DISPATCH_REASON.INVALID_IMPORT_PAYLOAD,
    })
    expect(bootstrap).not.toHaveBeenCalled()
  })
})
