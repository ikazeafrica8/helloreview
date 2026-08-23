import { EVENT_TYPES, platformEventSchema, type EventType, type PlatformEvent } from '@helloreview/contracts'
import {
  INBOUND_TRANSLATION_FAILURES,
  type InboundAdapter,
  type InboundDelivery,
  type InboundTranslation,
} from '../ports/inbound.js'

// A fake inbound provider that can emit every §18 event on demand (T19).
//
// NOT A MOCK. A mock returns whatever a test told it to and proves only that the caller called it.
// This translates real wire-shaped payloads through the real §18 schemas, so an event it produces
// has been validated by exactly the code that validates a genuine one. When the Kakao adapter
// lands, both pass the same conformance suite and the difference between them is only the
// translation.
//
// WHAT IT IS FOR, in order of importance:
//
//   1. The whole platform can be exercised end to end before any provider contract is signed. PRD
//      §33.3 is still a list of questions for the dealer; nothing downstream should be blocked on
//      the answers.
//   2. It emits the cases a real provider WILL send and a hand-written test usually will not:
//      duplicates, out-of-order delivery, and unrecognised payloads.
//   3. It is the reference implementation of the port, so a real adapter has something to be
//      compared against rather than only a description to be written from.

/** The §18 wire examples, keyed by event type. These are the shapes a provider actually sends. */
const WIRE_PAYLOADS: Readonly<Record<EventType, Readonly<Record<string, unknown>>>> = {
  [EVENT_TYPES.APPLICATION_CREATED]: {
    application_id: 'app_123',
    campaign_id: 'camp_456',
    application_status: 'completed',
    application_source: 'website',
    applicant: { name: '홍길동', phone_normalized: '+821012345678', blog_url: 'https://example.invalid/blog' },
    submitted_at: '2026-08-22T10:30:00+09:00',
  },
  [EVENT_TYPES.APPLICATION_UPDATED]: {
    application_id: 'app_123',
    changed_fields: ['application_status'],
    application_status: 'cancelled',
    source_version: 7,
  },
  [EVENT_TYPES.SELECTION_UPDATED]: {
    application_id: 'app_123',
    campaign_id: 'camp_456',
    selection_result: 'manually_selected',
    decision_id: 'sel_789',
    decision_reason_code: 'OPERATOR_APPROVED',
    rule_version: 'selection-v3',
  },
  [EVENT_TYPES.CHANNEL_MESSAGE_RECEIVED]: {
    provider: 'official_kakao_provider',
    external_message_id: 'provider-message-123',
    external_conversation_id: 'provider-conversation-456',
    external_user_id: 'provider-user-789',
    message_type: 'text',
    text: '신청 완료했습니다',
    sent_at: '2026-08-22T11:00:00+09:00',
  },
  [EVENT_TYPES.CHANNEL_ATTACHMENT_RECEIVED]: {
    provider: 'official_kakao_provider',
    external_message_id: 'provider-message-124',
    external_conversation_id: 'provider-conversation-456',
    attachment_type: 'image',
    provider_attachment_reference: 'opaque-reference',
    declared_mime_type: 'image/jpeg',
    declared_size_bytes: 345_678,
  },
  [EVENT_TYPES.MESSAGE_DELIVERY_UPDATED]: {
    provider: 'aligo',
    provider_message_id: 'aligo-message-123',
    internal_notification_id: 'not_456',
    delivery_status: 'delivered',
    delivered_at: '2026-08-22T11:02:00+09:00',
    provider_status_code: 'NORMALIZED_PROVIDER_CODE',
  },
  [EVENT_TYPES.BUSINESS_APPROVAL_UPDATED]: {
    workflow_id: 'wf_123',
    campaign_id: 'camp_456',
    approval_state: 'approved',
    approval_version: 2,
    approved_by: 'operator_789',
    approved_at: '2026-08-22T13:00:00+09:00',
    expires_at: '2026-08-29T23:59:59+09:00',
  },
  [EVENT_TYPES.RESERVATION_SUBMITTED]: {
    workflow_id: 'wf_123',
    submission_type: 'screenshot',
    attachment_id: 'att_456',
    participant_message_id: 'msg_789',
    reservation_version: 1,
  },
  [EVENT_TYPES.GUIDELINE_DELIVERY_REQUESTED]: {
    workflow_id: 'wf_123',
    guideline_version: 'guideline-v4',
    triggering_event_id: 'evt_456',
    requested_reason: 'READINESS_PREDICATE_PASSED',
  },
  [EVENT_TYPES.HUMAN_REVIEW_CREATED]: {
    workflow_id: 'wf_123',
    reason_code: 'IDENTITY_AMBIGUOUS',
    priority: 'high',
    automation_paused: true,
    source_event_id: 'evt_456',
  },
  [EVENT_TYPES.HUMAN_REVIEW_COMPLETED]: {
    task_id: 'task_123',
    workflow_id: 'wf_456',
    resolution_code: 'IDENTITY_CONFIRMED',
    operator_id: 'operator_789',
    return_to_automation: true,
    resolution_reason: 'Application ID verified through approved process',
  },
}

export type FakeEventOptions = Readonly<{
  eventId?: string
  occurredAt?: string
  eventVersion?: number
  /** Replace individual payload fields, for a test that needs a specific value. */
  payload?: Readonly<Record<string, unknown>>
}>

const ALL_EVENT_TYPES: readonly EventType[] = Object.freeze(Object.values(EVENT_TYPES))

/**
 * A wire-shaped §18.1 envelope for `eventType`.
 *
 * Returns the SNAKE_CASE form a provider sends, not the parsed domain form — the point of the fake
 * is to exercise the translation, and handing back an already-translated object would skip it.
 */
export const fakeWireEvent = (
  eventType: EventType,
  provider = 'helloreview_website',
  options: FakeEventOptions = {},
): Record<string, unknown> => ({
  event_id: options.eventId ?? `evt_fake_${eventType.replace(/\./g, '_')}`,
  event_type: eventType,
  event_version: options.eventVersion ?? 1,
  source: provider,
  occurred_at: options.occurredAt ?? '2026-08-22T10:30:00+09:00',
  idempotency_key: `${provider}:${eventType}:${options.eventId ?? 'default'}:v1`,
  payload: { ...WIRE_PAYLOADS[eventType], ...options.payload },
})

/**
 * Build the fake adapter.
 *
 * Translation is the real §18 schema parse. That is what makes this a fake rather than a stub: a
 * payload it cannot produce a valid event from is REFUSED, exactly as a real adapter's would be.
 */
export const createFakeInboundAdapter = (provider = 'helloreview_website'): InboundAdapter => {
  const translate = (delivery: InboundDelivery): InboundTranslation => {
    if (typeof delivery.raw !== 'object' || delivery.raw === null) {
      return { ok: false, reasonCode: INBOUND_TRANSLATION_FAILURES.UNRECOGNISED_PAYLOAD }
    }

    const carrier: Record<string, unknown> = { ...delivery.raw }
    const eventType = carrier.event_type

    if (typeof eventType !== 'string') {
      return { ok: false, reasonCode: INBOUND_TRANSLATION_FAILURES.UNRECOGNISED_PAYLOAD }
    }
    // A predicate, not a cast: the value came off the wire, and asserting it into the union is
    // exactly what no-unsafe-type-assertion forbids.
    if (!ALL_EVENT_TYPES.some((known) => known === eventType)) {
      return { ok: false, reasonCode: INBOUND_TRANSLATION_FAILURES.UNSUPPORTED_EVENT_TYPE }
    }

    const parsed = platformEventSchema.safeParse(delivery.raw)
    if (!parsed.success) {
      return { ok: false, reasonCode: INBOUND_TRANSLATION_FAILURES.TRANSLATION_INVALID }
    }

    return { ok: true, event: parsed.data }
  }

  return Object.freeze({ provider, supportedEventTypes: ALL_EVENT_TYPES, translate })
}

/**
 * One delivery per §18 event type, in registry order.
 *
 * The conformance suite uses this to assert an adapter emits everything it claims to support.
 */
export const fakeDeliveriesForEveryEventType = (
  provider = 'helloreview_website',
  receivedAt = new Date('2026-08-22T10:30:01+09:00'),
): readonly InboundDelivery[] =>
  ALL_EVENT_TYPES.map((eventType) => ({
    provider,
    raw: fakeWireEvent(eventType, provider),
    receivedAt,
  }))

/**
 * The same event delivered twice — a provider retry, which every provider does.
 *
 * Byte-identical on purpose. The adapter must translate both; deduplication is the INBOX's job, and
 * an adapter that silently swallowed the second would hide the duplicate from the one component
 * built to handle it.
 */
export const fakeDuplicateDelivery = (
  provider = 'helloreview_website',
  eventId = 'evt_fake_duplicate',
): readonly [InboundDelivery, InboundDelivery] => {
  const raw = fakeWireEvent(EVENT_TYPES.APPLICATION_CREATED, provider, { eventId })
  const receivedAt = new Date('2026-08-22T10:30:01+09:00')
  return [
    { provider, raw, receivedAt },
    { provider, raw, receivedAt: new Date(receivedAt.getTime() + 30_000) },
  ]
}

/**
 * Two events delivered in the wrong order: the later `occurred_at` arrives first.
 *
 * FR-MSG-007 requires that a delayed event cannot reverse a newer valid state. The adapter's job is
 * only to preserve `occurred_at` faithfully so the ordering decision is POSSIBLE downstream — an
 * adapter that stamped arrival time over it would make that requirement unimplementable.
 */
export const fakeOutOfOrderDeliveries = (
  provider = 'helloreview_website',
): readonly [InboundDelivery, InboundDelivery] => {
  const receivedAt = new Date('2026-08-22T12:00:00+09:00')
  return [
    {
      provider,
      raw: fakeWireEvent(EVENT_TYPES.APPLICATION_UPDATED, provider, {
        eventId: 'evt_fake_newer',
        occurredAt: '2026-08-22T11:00:00+09:00',
        payload: { source_version: 9 },
      }),
      receivedAt,
    },
    {
      provider,
      raw: fakeWireEvent(EVENT_TYPES.APPLICATION_UPDATED, provider, {
        eventId: 'evt_fake_older',
        occurredAt: '2026-08-22T10:00:00+09:00',
        payload: { source_version: 4 },
      }),
      receivedAt: new Date(receivedAt.getTime() + 1_000),
    },
  ]
}

/** Payloads no adapter should accept. Each must be REFUSED, not translated into something. */
export const fakeUntranslatableDeliveries = (
  provider = 'helloreview_website',
): readonly Readonly<{ label: string; delivery: InboundDelivery }>[] => {
  const receivedAt = new Date('2026-08-22T10:30:01+09:00')
  return [
    { label: 'a string body', delivery: { provider, raw: 'not an object', receivedAt } },
    { label: 'null', delivery: { provider, raw: null, receivedAt } },
    { label: 'an empty object', delivery: { provider, raw: {}, receivedAt } },
    {
      label: 'an unmodelled event type',
      delivery: {
        provider,
        raw: { ...fakeWireEvent(EVENT_TYPES.APPLICATION_CREATED, provider), event_type: 'provider.keepalive' },
        receivedAt,
      },
    },
    {
      label: 'a modelled type with a payload that does not match it',
      delivery: {
        provider,
        raw: { ...fakeWireEvent(EVENT_TYPES.APPLICATION_CREATED, provider), payload: { nothing: 'relevant' } },
        receivedAt,
      },
    },
  ]
}

/** Every event the fake can produce, already translated. Convenience for downstream fixtures. */
export const fakeTranslatedEvents = (provider = 'helloreview_website'): readonly PlatformEvent[] => {
  const adapter = createFakeInboundAdapter(provider)
  return fakeDeliveriesForEveryEventType(provider).flatMap((delivery) => {
    const result = adapter.translate(delivery)
    return result.ok ? [result.event] : []
  })
}
