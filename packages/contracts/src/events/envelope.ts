// The PRD §18.1 envelope, §18.2 acceptance response, and the event union that binds a payload to
// its type.
//
// The union is DISCRIMINATED on event_type. That is what lets a handler read
// `event.payload.applicationId` after checking `event.eventType === 'application.created'` without
// a cast — and a cast is precisely what @typescript-eslint/no-unsafe-type-assertion forbids,
// correctly, because the value came off the wire.

import { z } from 'zod'
import { identifier, isoTimestamp, version } from './primitives.js'
import {
  applicationCreatedPayload,
  applicationUpdatedPayload,
  selectionUpdatedPayload,
  channelMessageReceivedPayload,
  channelAttachmentReceivedPayload,
  messageDeliveryUpdatedPayload,
  businessApprovalUpdatedPayload,
  reservationSubmittedPayload,
  guidelineDeliveryRequestedPayload,
  humanReviewCreatedPayload,
  humanReviewCompletedPayload,
} from './payloads.js'

/**
 * Every event type the platform accepts, one per PRD §18.5–§18.15.
 *
 * A registry rather than a bare union so the list can be iterated — the conformance suite (T19)
 * must be able to assert that a provider adapter emits all of them.
 */
export const EVENT_TYPES = {
  APPLICATION_CREATED: 'application.created',
  APPLICATION_UPDATED: 'application.updated',
  SELECTION_UPDATED: 'selection.updated',
  CHANNEL_MESSAGE_RECEIVED: 'channel.message.received',
  CHANNEL_ATTACHMENT_RECEIVED: 'channel.attachment.received',
  MESSAGE_DELIVERY_UPDATED: 'message.delivery.updated',
  BUSINESS_APPROVAL_UPDATED: 'business_approval.updated',
  RESERVATION_SUBMITTED: 'reservation.submitted',
  GUIDELINE_DELIVERY_REQUESTED: 'guideline.delivery.requested',
  HUMAN_REVIEW_CREATED: 'human_review.created',
  HUMAN_REVIEW_COMPLETED: 'human_review.completed',
} as const

export type EventType = (typeof EVENT_TYPES)[keyof typeof EVENT_TYPES]

/**
 * The domain shape one event parses into: the §18.1 envelope, camelCased, plus its typed payload.
 *
 * Written out rather than inferred so that `payload` stays narrowed at call sites, which is the
 * entire reason the union exists. See `toDomain` below for why inference alone does not get there.
 */
export interface PlatformEventOf<T extends EventType, P> {
  eventId: string
  eventType: T
  eventVersion: number
  source: string
  occurredAt: string
  receivedAt?: string
  correlationId?: string
  idempotencyKey: string
  payload: P
}

/**
 * The §18.1 envelope fields every event carries, spread into each union member below.
 *
 * `received_at` and `correlation_id` are OPTIONAL because both are stamped by the receiver. A
 * producer that omits them is behaving correctly, and requiring them would reject valid traffic at
 * the edge over fields we are about to write ourselves.
 *
 * `idempotency_key` is required and is the point of the envelope. §17.3 makes
 * UNIQUE(source, external_event_id) the actual idempotency guarantee; this carries the producer's
 * own notion of "the same operation" alongside it.
 */
const ENVELOPE_FIELDS = {
  event_id: identifier,
  event_version: version,
  source: identifier,
  occurred_at: isoTimestamp,
  received_at: isoTimestamp.optional(),
  correlation_id: identifier.optional(),
  idempotency_key: identifier,
}

/** The wire shape one union member parses to, before the snake_case → camelCase transform. */
interface WireEnvelope<T extends EventType, P> {
  event_id: string
  event_type: T
  event_version: number
  source: string
  occurred_at: string
  received_at?: string | undefined
  correlation_id?: string | undefined
  idempotency_key: string
  payload: P
}

/**
 * The shared snake_case → camelCase transform.
 *
 * A standalone generic function rather than a generic schema BUILDER. Zod 4 cannot resolve its
 * optional-key detection through a generic payload schema — `z.strictObject({...FIELDS, payload})`
 * with `payload: P` infers an unresolved mapped type and `raw.payload` stops existing (measured,
 * TS2339). Spreading the fields at each concrete call site keeps Zod's inference on solid ground,
 * and this function absorbs the repetition that would otherwise be eleven copies.
 */
const toDomain = <T extends EventType, P>(raw: WireEnvelope<T, P>): PlatformEventOf<T, P> => ({
  eventId: raw.event_id,
  eventType: raw.event_type,
  eventVersion: raw.event_version,
  source: raw.source,
  occurredAt: raw.occurred_at,
  ...(raw.received_at === undefined ? {} : { receivedAt: raw.received_at }),
  ...(raw.correlation_id === undefined ? {} : { correlationId: raw.correlation_id }),
  idempotencyKey: raw.idempotency_key,
  payload: raw.payload,
})

/**
 * Any event the platform accepts, with its payload narrowed by type.
 *
 * z.union rather than z.discriminatedUnion: each member is a transforming schema (ZodPipe), and
 * discriminatedUnion requires members it can read a literal discriminant off directly. The cost is
 * that a bad payload reports issues from every branch instead of one; the benefit is that the
 * OUTPUT is still a discriminated union, which is what call sites actually need.
 */
export const platformEventSchema = z.union([
  z
    .strictObject({
      ...ENVELOPE_FIELDS,
      event_type: z.literal('application.created'),
      payload: applicationCreatedPayload,
    })
    .transform(toDomain),
  z
    .strictObject({
      ...ENVELOPE_FIELDS,
      event_type: z.literal('application.updated'),
      payload: applicationUpdatedPayload,
    })
    .transform(toDomain),
  z
    .strictObject({ ...ENVELOPE_FIELDS, event_type: z.literal('selection.updated'), payload: selectionUpdatedPayload })
    .transform(toDomain),
  z
    .strictObject({
      ...ENVELOPE_FIELDS,
      event_type: z.literal('channel.message.received'),
      payload: channelMessageReceivedPayload,
    })
    .transform(toDomain),
  z
    .strictObject({
      ...ENVELOPE_FIELDS,
      event_type: z.literal('channel.attachment.received'),
      payload: channelAttachmentReceivedPayload,
    })
    .transform(toDomain),
  z
    .strictObject({
      ...ENVELOPE_FIELDS,
      event_type: z.literal('message.delivery.updated'),
      payload: messageDeliveryUpdatedPayload,
    })
    .transform(toDomain),
  z
    .strictObject({
      ...ENVELOPE_FIELDS,
      event_type: z.literal('business_approval.updated'),
      payload: businessApprovalUpdatedPayload,
    })
    .transform(toDomain),
  z
    .strictObject({
      ...ENVELOPE_FIELDS,
      event_type: z.literal('reservation.submitted'),
      payload: reservationSubmittedPayload,
    })
    .transform(toDomain),
  z
    .strictObject({
      ...ENVELOPE_FIELDS,
      event_type: z.literal('guideline.delivery.requested'),
      payload: guidelineDeliveryRequestedPayload,
    })
    .transform(toDomain),
  z
    .strictObject({
      ...ENVELOPE_FIELDS,
      event_type: z.literal('human_review.created'),
      payload: humanReviewCreatedPayload,
    })
    .transform(toDomain),
  z
    .strictObject({
      ...ENVELOPE_FIELDS,
      event_type: z.literal('human_review.completed'),
      payload: humanReviewCompletedPayload,
    })
    .transform(toDomain),
])

/** A validated event, payload narrowed by `eventType`. The only shape core modules ever see. */
export type PlatformEvent = z.infer<typeof platformEventSchema>

/** Narrow a PlatformEvent to one variant without a cast. */
export type EventOfType<T extends EventType> = Extract<PlatformEvent, { eventType: T }>

/**
 * §18.2 — what the gateway returns once an event is accepted.
 *
 * `duplicate` is the field the whole idempotency spine exists to be able to set truthfully: §18.2
 * says a duplicate returns the EXISTING accepted result rather than reprocessing, so this response
 * is replayed from the inbox row, not recomputed.
 */
export const acceptanceResponseSchema = z.strictObject({
  accepted: z.literal(true),
  event_id: identifier,
  duplicate: z.boolean(),
  correlation_id: identifier.optional(),
  // Constrained rather than free text: an operator reading a response needs these to mean the same
  // thing every time, and a typo'd status is indistinguishable from a new one.
  processing_status: z.enum(['queued', 'processing', 'processed', 'failed']),
})

export type AcceptanceResponse = z.infer<typeof acceptanceResponseSchema>
