import { OutboundProviderTimeoutError, type OutboundProvider } from '@helloreview/adapters'
import type { ClaimedOutboundNotification, OutboundNotificationStore } from './outbound-store.js'

export type OutboundProcessorOptions = Readonly<{
  workerId: string
  batchSize?: number
  maxRetries?: number
  retryDelayMs?: number
  reconciliationDelayMs?: number
}>

export type OutboundDeliveryProcessor = Readonly<{
  sendBatch: (now: Date) => Promise<number>
  reconcileBatch: (now: Date) => Promise<number>
}>

const addMilliseconds = (date: Date, milliseconds: number): Date => new Date(date.getTime() + milliseconds)

/** Polling worker for the PostgreSQL transactional outbox. */
export const createOutboundDeliveryProcessor = (
  store: OutboundNotificationStore,
  provider: OutboundProvider,
  options: OutboundProcessorOptions,
): OutboundDeliveryProcessor => {
  const batchSize = options.batchSize ?? 25
  const maxRetries = options.maxRetries ?? 3
  const retryDelayMs = options.retryDelayMs ?? 60_000
  const reconciliationDelayMs = options.reconciliationDelayMs ?? 30_000

  const retryOrFail = async (
    notification: ClaimedOutboundNotification,
    failureCode: string,
    now: Date,
  ): Promise<void> => {
    if (notification.retryCount >= maxRetries) {
      await store.markFailed(notification, options.workerId, failureCode, now)
      return
    }
    await store.scheduleRetry(notification, options.workerId, failureCode, addMilliseconds(now, retryDelayMs), now)
  }

  const sendOne = async (notification: ClaimedOutboundNotification, now: Date): Promise<void> => {
    await store.markSending(notification, options.workerId, now)
    try {
      const outcome = await provider.send({
        notificationId: notification.id,
        channel: notification.channel,
        recipientReference: notification.recipientReference,
        purpose: notification.purpose,
        renderedContent: notification.renderedContent,
        templateVersion: notification.templateVersion,
        ...(notification.providerTemplateCode === undefined
          ? {}
          : { providerTemplateCode: notification.providerTemplateCode }),
        idempotencyKey: notification.idempotencyKey,
      })
      if (outcome.status === 'accepted') {
        await store.markAccepted(
          notification,
          options.workerId,
          provider.provider,
          outcome.providerMessageId,
          addMilliseconds(now, reconciliationDelayMs),
          now,
        )
      } else if (outcome.status === 'unknown') {
        await store.markUnknown(
          notification,
          options.workerId,
          provider.provider,
          outcome.providerMessageId,
          addMilliseconds(now, reconciliationDelayMs),
          now,
        )
      } else {
        await retryOrFail(notification, outcome.failureCode, now)
      }
    } catch (error) {
      if (!(error instanceof OutboundProviderTimeoutError)) throw error
      await store.markUnknown(
        notification,
        options.workerId,
        provider.provider,
        error.providerMessageId,
        addMilliseconds(now, reconciliationDelayMs),
        now,
      )
    }
  }

  const reconcileOne = async (notification: ClaimedOutboundNotification, now: Date): Promise<void> => {
    const outcome = await provider.reconcile(notification.providerMessageId, notification.idempotencyKey)
    if (outcome.status === 'delivered') {
      await store.markDelivered(notification, options.workerId, provider.provider, outcome.providerMessageId, now)
    } else if (outcome.status === 'unknown') {
      await store.markUnknown(
        notification,
        options.workerId,
        provider.provider,
        outcome.providerMessageId,
        addMilliseconds(now, reconciliationDelayMs),
        now,
      )
    } else {
      await retryOrFail(notification, outcome.failureCode, now)
    }
  }

  return {
    sendBatch: async (now) => {
      const claimed = await store.claimForSend(options.workerId, now, batchSize)
      await Promise.all(claimed.map(async (notification) => sendOne(notification, now)))
      return claimed.length
    },
    reconcileBatch: async (now) => {
      const claimed = await store.claimForReconciliation(options.workerId, now, batchSize)
      await Promise.all(claimed.map(async (notification) => reconcileOne(notification, now)))
      return claimed.length
    },
  }
}
