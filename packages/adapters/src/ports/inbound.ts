import type { PlatformEvent, EventType } from '@helloreview/contracts'

// The platform-neutral inbound port (SPEC.md §3.1, T19).
//
// EVERY provider — the website, the Kakao dealer, Aligo — arrives through this interface, and
// nothing behind it ever sees a provider's own field names. That is the boundary SPEC.md §3.1 draws
// and the T6 lint rule enforces: a Kakao-shaped type appearing in a core module is a lint error.
//
// WHY A PORT RATHER THAN A CLIENT PER PROVIDER. PRD §18 is explicit that its contracts "are not
// claims about actual Kakao, Aligo, Naver, or website payloads" — every scheme here is unverified,
// and §33.3 is a list of questions still to be asked of the dealer. Code written against a guess
// about one provider would have to be unpicked when the answer arrives. Code written against this
// port needs a new adapter and nothing else.
//
// THE CONFORMANCE SUITE IS THE REAL CONTRACT. An interface only constrains shapes; it cannot say
// that a translation preserves an event id, or that a duplicate is passed through rather than
// swallowed. The suite beside this file states those obligations as executable tests, and every
// adapter — the fake included — must pass it. It doubles as the §33.3 capability checklist: each
// assertion is a question the dealer has to answer.

/**
 * A message as it left the provider, before any interpretation.
 *
 * `raw` is deliberately `unknown`. An adapter's whole job is to turn this into a PlatformEvent, and
 * typing it as anything else would let a provider's shape leak past the boundary — which is what
 * this port exists to prevent.
 */
export type InboundDelivery = Readonly<{
  /** The provider that sent it, matching the §18.1 `source` value. */
  provider: string
  /** Whatever arrived. Never inspected outside an adapter. */
  raw: unknown
  /** When the platform received it, as opposed to when the provider says it happened. */
  receivedAt: Date
}>

/** Why an adapter could not translate a delivery. SCREAMING_SNAKE (SPEC.md §6). */
export const INBOUND_TRANSLATION_FAILURES = {
  /** The provider sent something this adapter does not recognise as an event at all. */
  UNRECOGNISED_PAYLOAD: 'UNRECOGNISED_PAYLOAD',
  /** Recognised, but for an event type the platform does not model. */
  UNSUPPORTED_EVENT_TYPE: 'UNSUPPORTED_EVENT_TYPE',
  /** Recognised and modelled, but the translated result fails the §18 schema. */
  TRANSLATION_INVALID: 'TRANSLATION_INVALID',
} as const

export type InboundTranslationFailure = (typeof INBOUND_TRANSLATION_FAILURES)[keyof typeof INBOUND_TRANSLATION_FAILURES]

/**
 * The outcome of translating one delivery.
 *
 * A result union rather than an exception. Translation failure is an ORDINARY event — providers
 * send keepalives, unmodelled notification types, and malformed retries — and modelling the routine
 * case as an exception makes the caller's correctness depend on catching the right class, which is
 * how a keepalive ends up in a dead-letter queue.
 */
export type InboundTranslation =
  Readonly<{ ok: true; event: PlatformEvent }> | Readonly<{ ok: false; reasonCode: InboundTranslationFailure }>

export type InboundAdapter = Readonly<{
  /** The §18.1 `source` value events from this adapter carry. */
  provider: string

  /**
   * Which event types this adapter can produce.
   *
   * Declared rather than discovered, so the conformance suite can assert that an adapter actually
   * emits everything it claims — and so an operator can answer "can we receive reservations from
   * this provider yet?" without reading the implementation.
   */
  supportedEventTypes: readonly EventType[]

  /**
   * Translate one delivery into a platform event.
   *
   * PURE with respect to the platform: it must not write to a database, enqueue anything, or call
   * back out to the provider. Translation happens at the edge, before the idempotency check, so an
   * adapter with side effects would perform them again on every duplicate delivery.
   */
  translate: (delivery: InboundDelivery) => InboundTranslation
}>
