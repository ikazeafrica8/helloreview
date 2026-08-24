import type {
  OutboundDeliveryResult,
  OutboundProvider,
  OutboundSendRequest,
  OutboundSendResult,
} from '../ports/outbound.js'
import { OutboundProviderTimeoutError } from '../ports/outbound.js'

export type FakeSendBehavior = 'accepted' | 'failed' | 'unknown' | 'timeout'
export type FakeReconcileBehavior = 'delivered' | 'failed' | 'unknown'

export type FakeOutboundProvider = OutboundProvider &
  Readonly<{
    attempts: readonly OutboundSendRequest[]
    logicalMessageCount: () => number
  }>

export type FakeOutboundProviderOptions = Readonly<{
  sendPlan?: readonly FakeSendBehavior[]
  reconcilePlan?: readonly FakeReconcileBehavior[]
}>

interface LogicalMessage {
  providerMessageId: string
}

/** Deterministic provider fake with programmable failure, timeout, and unknown-delivery paths. */
export const createFakeOutboundProvider = (options: FakeOutboundProviderOptions = {}): FakeOutboundProvider => {
  const attempts: OutboundSendRequest[] = []
  const logicalMessages = new Map<string, LogicalMessage>()
  const sendPlan = [...(options.sendPlan ?? [])]
  const reconcilePlan = [...(options.reconcilePlan ?? [])]
  let sequence = 0

  const logicalMessage = (idempotencyKey: string): LogicalMessage => {
    const existing = logicalMessages.get(idempotencyKey)
    if (existing !== undefined) return existing
    sequence += 1
    const created = { providerMessageId: `fake-message-${String(sequence)}` }
    logicalMessages.set(idempotencyKey, created)
    return created
  }

  const send = (request: OutboundSendRequest): Promise<OutboundSendResult> => {
    attempts.push(request)
    const behavior = sendPlan.shift() ?? 'accepted'
    if (behavior === 'failed') return Promise.resolve({ status: 'failed', failureCode: 'FAKE_CONFIRMED_FAILURE' })

    const message = logicalMessage(request.idempotencyKey)
    if (behavior === 'timeout') return Promise.reject(new OutboundProviderTimeoutError(message.providerMessageId))
    if (behavior === 'unknown')
      return Promise.resolve({ status: 'unknown', providerMessageId: message.providerMessageId })
    return Promise.resolve({ status: 'accepted', providerMessageId: message.providerMessageId })
  }

  const reconcile = (
    providerMessageId: string | undefined,
    idempotencyKey: string,
  ): Promise<OutboundDeliveryResult> => {
    const behavior = reconcilePlan.shift() ?? 'delivered'
    const known = logicalMessages.get(idempotencyKey)
    const stableProviderMessageId = providerMessageId ?? known?.providerMessageId
    if (behavior === 'unknown') {
      return Promise.resolve({
        status: 'unknown',
        ...(stableProviderMessageId === undefined ? {} : { providerMessageId: stableProviderMessageId }),
      })
    }
    if (behavior === 'failed') {
      return Promise.resolve({
        status: 'failed',
        ...(stableProviderMessageId === undefined ? {} : { providerMessageId: stableProviderMessageId }),
        failureCode: 'FAKE_CONFIRMED_FAILURE',
      })
    }
    return Promise.resolve({
      status: 'delivered',
      providerMessageId: stableProviderMessageId ?? logicalMessage(idempotencyKey).providerMessageId,
    })
  }

  return Object.freeze({
    provider: 'fake-outbound',
    send,
    reconcile,
    attempts,
    logicalMessageCount: () => logicalMessages.size,
  })
}
