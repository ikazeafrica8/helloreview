import { describe, expect, test, vi } from 'vitest'
import {
  WEBSITE_SOURCE_FAILURES,
  WebsiteSourceError,
  createFakeWebsiteApplicationSource,
} from '../../packages/adapters/src/index.js'
import {
  ReconciliationFailedError,
  ReconciliationPendingError,
  createReconcileApplicationsHandler,
} from '../../apps/worker/src/processors/reconcile-applications.js'

const snapshot = (overrides = {}) => ({
  sourceSystem: 'helloreview_website',
  sourceApplicationId: 'app-unit-1',
  campaignId: 'campaign-unit-1',
  status: 'received',
  applicantName: '테스트 신청자',
  phoneNormalized: '+821012345678',
  submittedAt: new Date('2026-08-24T01:00:00Z'),
  sourceVersion: 1,
  sourceEventId: 'evt-unit-1',
  sourceOccurredAt: new Date('2026-08-24T01:00:01Z'),
  ...overrides,
})

describe('T26 website application source fake', () => {
  test('filters authoritative records and emits schema-validated application events', async () => {
    const source = createFakeWebsiteApplicationSource()
    const current = snapshot()
    source.put(current)
    source.put(snapshot({ sourceApplicationId: 'other', campaignId: 'different-campaign' }))

    const found = await source.listRecentApplications({
      campaignId: current.campaignId,
      submittedSince: new Date('2026-08-24T00:59:00Z'),
    })
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ sourceApplicationId: 'app-unit-1', sourceVersion: 1 })

    const created = source.emitCreated(current)
    expect(created).toMatchObject({
      eventType: 'application.created',
      eventId: 'evt-unit-1',
      source: 'helloreview_website',
      payload: { applicationId: 'app-unit-1', applicationStatus: 'received' },
    })

    const updated = source.emitUpdated(snapshot({ status: 'completed', sourceVersion: 2, sourceEventId: 'evt-unit-2' }))
    expect(updated).toMatchObject({
      eventType: 'application.updated',
      payload: { applicationId: 'app-unit-1', applicationStatus: 'completed', sourceVersion: 2 },
    })
  })

  test('can deterministically simulate a website outage without losing stored records', async () => {
    const source = createFakeWebsiteApplicationSource('helloreview_website', [snapshot()])
    source.failNextRead(WEBSITE_SOURCE_FAILURES.UNAVAILABLE)

    await expect(
      source.listRecentApplications({ campaignId: 'campaign-unit-1', submittedSince: new Date(0) }),
    ).rejects.toMatchObject({
      name: WebsiteSourceError.name,
      reasonCode: WEBSITE_SOURCE_FAILURES.UNAVAILABLE,
    })
    await expect(
      source.listRecentApplications({ campaignId: 'campaign-unit-1', submittedSince: new Date(0) }),
    ).resolves.toHaveLength(1)
  })
})

describe('T27 reconciliation queue processor', () => {
  test('completes terminal outcomes and turns pending into a queue retry', async () => {
    const nextAttemptAt = new Date('2026-08-24T01:01:00Z')
    const attempt = vi
      .fn()
      .mockResolvedValueOnce({ status: 'pending', nextAttemptAt })
      .mockResolvedValueOnce({ status: 'resolved', nextAttemptAt })
    const handler = createReconcileApplicationsHandler({ attempt }, () => new Date('2026-08-24T01:00:00Z'))
    const job = { data: { reconciliationId: 'rec-unit-1' } }

    await expect(handler(job)).rejects.toEqual(new ReconciliationPendingError(nextAttemptAt))
    await expect(handler(job)).resolves.toBeUndefined()
    expect(attempt).toHaveBeenCalledTimes(2)
  })

  test('rejects malformed jobs and surfaces terminal source failure', async () => {
    const nextAttemptAt = new Date('2026-08-24T01:01:00Z')
    const handler = createReconcileApplicationsHandler({
      attempt: vi.fn().mockResolvedValue({ status: 'failed', nextAttemptAt }),
    })

    await expect(handler({ data: {} })).rejects.toThrow('INVALID_RECONCILIATION_JOB_PAYLOAD')
    await expect(handler({ data: { reconciliationId: 'rec-unit-2' } })).rejects.toBeInstanceOf(
      ReconciliationFailedError,
    )
  })
})
