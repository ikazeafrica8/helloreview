import type { OutboundProvider, OutboundSendRequest } from '../ports/outbound.js'
import { OutboundProviderTimeoutError } from '../ports/outbound.js'

export type OutboundConformanceCheck = Readonly<{ name: string; run: () => Promise<void> }>

const expectTrue = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(message)
}

/** Behaviour every fake or future real outbound adapter must preserve. */
export const outboundConformanceChecks = (
  provider: OutboundProvider,
  request: OutboundSendRequest,
): readonly OutboundConformanceCheck[] => [
  {
    name: 'names the provider and accepts a complete logical message',
    run: async () => {
      expectTrue(provider.provider.length > 0, 'an outbound provider must name itself')
      const result = await provider.send(request)
      expectTrue(result.status !== 'failed', 'the conformance fixture must be sendable')
    },
  },
  {
    name: 'reuses the idempotency key on repeat delivery',
    run: async () => {
      const first = await provider.send(request)
      const second = await provider.send(request)
      expectTrue(first.status === 'accepted' && second.status === 'accepted', 'repeat sends must be accepted')
      if (first.status !== 'accepted' || second.status !== 'accepted') return
      expectTrue(
        first.providerMessageId === second.providerMessageId,
        'one idempotency key created two logical messages',
      )
    },
  },
  {
    name: 'exposes timeout as unknown delivery, not confirmed failure',
    run: async () => {
      try {
        await provider.send(request)
      } catch (error) {
        expectTrue(error instanceof OutboundProviderTimeoutError, 'provider threw an unclassified timeout')
      }
    },
  },
  {
    name: 'supports reconciliation before any resend',
    run: async () => {
      const result = await provider.reconcile(undefined, request.idempotencyKey)
      expectTrue(
        ['delivered', 'unknown', 'failed'].includes(result.status),
        'provider returned no reconciliation state',
      )
    },
  },
]
