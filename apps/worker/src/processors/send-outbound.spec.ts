import { describe, expect, test } from 'vitest'
import {
  OutboundProviderTimeoutError,
  type OutboundDeliveryResult,
  type OutboundProvider,
  type OutboundSendResult,
} from '@helloreview/adapters'
import { createOutboundDeliveryProcessor } from './send-outbound.js'
import type { ClaimedOutboundNotification, OutboundNotificationStore } from './outbound-store.js'

const notification: ClaimedOutboundNotification = {
  id: 'notification-1',
  channel: 'KAKAO',
  recipientReference: 'recipient-1',
  purpose: 'SYSTEM_DELAY_NOTICE',
  renderedContent: '지연 안내',
  templateVersion: 1,
  idempotencyKey: 'KAKAO|workflow-1|SYSTEM_DELAY_NOTICE|template-v1',
  retryCount: 0,
}

const providerWith = (
  sendResult: OutboundSendResult | Error = { status: 'accepted', providerMessageId: 'provider-message-1' },
  reconciliationResult: OutboundDeliveryResult | Error = {
    status: 'delivered',
    providerMessageId: 'provider-message-1',
  },
): OutboundProvider => ({
  provider: 'scripted-provider',
  send: () => (sendResult instanceof Error ? Promise.reject(sendResult) : Promise.resolve(sendResult)),
  reconcile: () =>
    reconciliationResult instanceof Error
      ? Promise.reject(reconciliationResult)
      : Promise.resolve(reconciliationResult),
})

const recordingStore = () => {
  const actions: string[] = []
  let sendClaims: readonly ClaimedOutboundNotification[] = [notification]
  let reconciliationClaims: readonly ClaimedOutboundNotification[] = [
    { ...notification, providerMessageId: 'fake-message-1' },
  ]
  const store: OutboundNotificationStore = {
    claimForSend: () => {
      const result = sendClaims
      sendClaims = []
      return Promise.resolve(result)
    },
    claimForReconciliation: () => {
      const result = reconciliationClaims
      reconciliationClaims = []
      return Promise.resolve(result)
    },
    markSending: () => {
      actions.push('sending')
      return Promise.resolve()
    },
    markAccepted: () => {
      actions.push('accepted')
      return Promise.resolve()
    },
    markUnknown: () => {
      actions.push('unknown')
      return Promise.resolve()
    },
    markDelivered: () => {
      actions.push('delivered')
      return Promise.resolve()
    },
    scheduleRetry: () => {
      actions.push('retry')
      return Promise.resolve()
    },
    markFailed: () => {
      actions.push('failed')
      return Promise.resolve()
    },
  }
  return { actions, store }
}

describe('outbound delivery processor', () => {
  test('accepts a send and reconciles it to delivered', async () => {
    const recorded = recordingStore()
    const processor = createOutboundDeliveryProcessor(recorded.store, providerWith(), {
      workerId: 'worker-1',
      reconciliationDelayMs: 0,
    })
    const now = new Date('2026-08-24T12:00:00Z')
    expect(await processor.sendBatch(now)).toBe(1)
    expect(await processor.reconcileBatch(now)).toBe(1)
    expect(await processor.sendBatch(now)).toBe(0)
    expect(await processor.reconcileBatch(now)).toBe(0)
    expect(recorded.actions).toEqual(['sending', 'accepted', 'delivered'])
  })

  test('schedules confirmed failures and unknown delivery without blind resend', async () => {
    const failed = recordingStore()
    const retrying = createOutboundDeliveryProcessor(
      failed.store,
      providerWith({ status: 'failed', failureCode: 'PROVIDER_CONFIRMED_FAILURE' }),
      { workerId: 'worker-2' },
    )
    await retrying.sendBatch(new Date('2026-08-24T12:00:00Z'))
    expect(failed.actions).toEqual(['sending', 'retry'])

    const unknown = recordingStore()
    const reconciling = createOutboundDeliveryProcessor(
      unknown.store,
      providerWith(
        { status: 'unknown', providerMessageId: 'provider-message-1' },
        { status: 'unknown', providerMessageId: 'provider-message-1' },
      ),
      { workerId: 'worker-3' },
    )
    const now = new Date('2026-08-24T12:00:00Z')
    await reconciling.sendBatch(now)
    await reconciling.reconcileBatch(now)
    expect(unknown.actions).toEqual(['sending', 'unknown', 'unknown'])

    const timedOut = recordingStore()
    const timingOut = createOutboundDeliveryProcessor(
      timedOut.store,
      providerWith(new OutboundProviderTimeoutError('provider-message-timeout')),
      { workerId: 'worker-timeout' },
    )
    await timingOut.sendBatch(now)
    expect(timedOut.actions).toEqual(['sending', 'unknown'])
  })

  test('stops after the configured retry limit and propagates non-timeout defects', async () => {
    const exhausted = recordingStore()
    const processor = createOutboundDeliveryProcessor(
      exhausted.store,
      providerWith(
        { status: 'failed', failureCode: 'PROVIDER_CONFIRMED_FAILURE' },
        { status: 'failed', failureCode: 'PROVIDER_CONFIRMED_FAILURE' },
      ),
      { workerId: 'worker-4', maxRetries: 0 },
    )
    const now = new Date('2026-08-24T12:00:00Z')
    await processor.sendBatch(now)
    await processor.reconcileBatch(now)
    expect(exhausted.actions).toEqual(['sending', 'failed', 'failed'])

    const broken = recordingStore()
    const defect = new Error('PROVIDER_DEFECT')
    const defectiveProvider = {
      provider: 'defective',
      send: () => Promise.reject(defect),
      reconcile: () => Promise.reject(defect),
    }
    const defective = createOutboundDeliveryProcessor(broken.store, defectiveProvider, { workerId: 'worker-5' })
    await expect(defective.sendBatch(now)).rejects.toBe(defect)
  })
})
