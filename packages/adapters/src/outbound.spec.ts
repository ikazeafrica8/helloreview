import { describe, expect, test } from 'vitest'
import { MESSAGE_PURPOSES, OUTBOUND_CHANNELS } from '@helloreview/contracts'
import { outboundConformanceChecks } from './conformance/outbound.suite.js'
import { createFakeOutboundProvider } from './fakes/outbound-fake.js'
import { OutboundProviderTimeoutError, type OutboundSendRequest } from './ports/outbound.js'

const request: OutboundSendRequest = {
  notificationId: 'notification_1',
  channel: OUTBOUND_CHANNELS.KAKAO,
  recipientReference: 'channel_identity_1',
  purpose: MESSAGE_PURPOSES.SYSTEM_DELAY_NOTICE,
  renderedContent: '처리가 지연되고 있습니다.',
  templateVersion: 1,
  idempotencyKey: 'KAKAO|wf_1|SYSTEM_DELAY_NOTICE|template_v1',
}

describe('outbound provider fake and conformance', () => {
  test('passes the shared adapter conformance suite', async () => {
    const provider = createFakeOutboundProvider()
    for (const check of outboundConformanceChecks(provider, request)) await check.run()
  })

  test('a timeout and retry reuse one provider logical message', async () => {
    const provider = createFakeOutboundProvider({ sendPlan: ['timeout', 'accepted'] })
    await expect(provider.send(request)).rejects.toBeInstanceOf(OutboundProviderTimeoutError)
    const retried = await provider.send(request)
    expect(retried).toEqual({ status: 'accepted', providerMessageId: 'fake-message-1' })
    expect(provider.logicalMessageCount()).toBe(1)
    expect(provider.attempts.map((attempt) => attempt.idempotencyKey)).toEqual([
      request.idempotencyKey,
      request.idempotencyKey,
    ])
  })

  test('simulates confirmed failure and every reconciliation outcome', async () => {
    const provider = createFakeOutboundProvider({
      sendPlan: ['failed', 'unknown'],
      reconcilePlan: ['unknown', 'failed', 'delivered'],
    })
    expect(await provider.send(request)).toEqual({ status: 'failed', failureCode: 'FAKE_CONFIRMED_FAILURE' })
    expect(await provider.send(request)).toEqual({ status: 'unknown', providerMessageId: 'fake-message-1' })
    expect(await provider.reconcile(undefined, request.idempotencyKey)).toEqual({
      status: 'unknown',
      providerMessageId: 'fake-message-1',
    })
    expect(await provider.reconcile(undefined, request.idempotencyKey)).toEqual({
      status: 'failed',
      providerMessageId: 'fake-message-1',
      failureCode: 'FAKE_CONFIRMED_FAILURE',
    })
    expect(await provider.reconcile(undefined, 'new-key')).toEqual({
      status: 'delivered',
      providerMessageId: 'fake-message-2',
    })
  })
})
