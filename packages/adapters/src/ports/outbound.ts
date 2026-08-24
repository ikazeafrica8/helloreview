import type { OutboundChannel } from '@helloreview/contracts'

export type OutboundSendRequest = Readonly<{
  notificationId: string
  channel: OutboundChannel
  recipientReference: string
  purpose: string
  renderedContent: string
  templateVersion: number
  providerTemplateCode?: string
  /** The canonical deduplication key is also the provider idempotency key. */
  idempotencyKey: string
}>

export type OutboundSendResult =
  | Readonly<{ status: 'accepted'; providerMessageId: string }>
  | Readonly<{ status: 'unknown'; providerMessageId?: string }>
  | Readonly<{ status: 'failed'; failureCode: string }>

export type OutboundDeliveryResult =
  | Readonly<{ status: 'delivered'; providerMessageId: string }>
  | Readonly<{ status: 'unknown'; providerMessageId?: string }>
  | Readonly<{ status: 'failed'; providerMessageId?: string; failureCode: string }>

export type OutboundProvider = Readonly<{
  provider: string
  send: (request: OutboundSendRequest) => Promise<OutboundSendResult>
  reconcile: (providerMessageId: string | undefined, idempotencyKey: string) => Promise<OutboundDeliveryResult>
}>

/** A timeout means delivery is unknown, never that sending definitely failed. */
export class OutboundProviderTimeoutError extends Error {
  override readonly name = 'OutboundProviderTimeoutError'

  constructor(readonly providerMessageId?: string) {
    super('outbound provider timed out with delivery status unknown')
  }
}
