import { EVENT_TYPES, type EventType } from '@helloreview/contracts'
import { INBOUND_TRANSLATION_FAILURES, type InboundAdapter, type InboundDelivery } from '../ports/inbound.js'

// The inbound adapter conformance suite (T19, PRD §33.3).
//
// AN INTERFACE CONSTRAINS SHAPES; THIS CONSTRAINS BEHAVIOUR. TypeScript can insist an adapter has a
// `translate` method returning the right union. It cannot insist that the method preserves the
// provider's event id, or that it refuses a payload it does not understand rather than inventing
// one, or that it passes a duplicate through instead of helpfully swallowing it. Those are the
// obligations that actually matter, and they only exist if they are executable.
//
// EVERY ADAPTER RUNS THIS — the fake today, the Kakao and Aligo adapters when their contracts are
// known. That is what makes "swap the fake for the real thing" a real claim rather than a hope.
//
// IT IS ALSO THE §33.3 CAPABILITY CHECKLIST. Each obligation below is a question the provider has
// to answer before an adapter can be written: do you send a stable event id? do you retry? does
// your timestamp mean when it happened or when you sent it? An adapter that cannot pass a check
// marks a gap in the integration, not a gap in this suite.
//
// FRAMEWORK-FREE ON PURPOSE. This file returns a list of named checks rather than calling
// `describe`/`it`, so packages/adapters needs no test-runner dependency and the suite can be run
// from the unit tier, the integration tier, or a future contract-verification job without change.

export type ConformanceCheck = Readonly<{
  name: string
  /** Throws with a specific message on failure; returns nothing on success. */
  run: () => void
}>

/** The §18 registry, read once. Used to assert a translated event type is a real one. */
const knownEventTypes: readonly EventType[] = Object.values(EVENT_TYPES)

const fail = (message: string): never => {
  throw new Error(message)
}

const expectTrue = (condition: boolean, message: string): void => {
  if (!condition) fail(message)
}

export type InboundConformanceFixtures = Readonly<{
  /** One delivery per event type the adapter claims to support. */
  everyEventType: readonly InboundDelivery[]
  /** The same event twice, byte-identical. */
  duplicate: readonly [InboundDelivery, InboundDelivery]
  /** Two deliveries whose `occurred_at` order is the reverse of their arrival order. */
  outOfOrder: readonly [InboundDelivery, InboundDelivery]
  /** Payloads that must be refused. */
  untranslatable: readonly Readonly<{ label: string; delivery: InboundDelivery }>[]
}>

/**
 * Build the conformance checks for one adapter.
 *
 * The fixtures are supplied by the adapter's own package, because only it knows what its provider's
 * wire format looks like. The OBLIGATIONS are fixed here, which is the whole point: an adapter
 * cannot weaken a check by supplying an easier fixture.
 */
export const inboundConformanceChecks = (
  adapter: InboundAdapter,
  fixtures: InboundConformanceFixtures,
): readonly ConformanceCheck[] => [
  {
    name: 'declares at least one supported event type',
    run: () => {
      expectTrue(
        adapter.supportedEventTypes.length > 0,
        'an adapter that supports no event types cannot receive anything',
      )
    },
  },

  {
    name: 'translates every event type it declares support for',
    run: () => {
      const translated = new Set<EventType>()

      for (const delivery of fixtures.everyEventType) {
        const result = adapter.translate(delivery)
        if (result.ok) translated.add(result.event.eventType)
      }

      const missing = adapter.supportedEventTypes.filter((eventType) => !translated.has(eventType))
      expectTrue(
        missing.length === 0,
        `adapter declares support for ${missing.join(', ')} but produced no such event from its own fixtures`,
      )
    },
  },

  {
    name: 'every translated event carries a complete §18.1 envelope',
    run: () => {
      // The port's TYPE says PlatformEvent. This checks the VALUE actually is one — an adapter that
      // hand-built an object and cast it satisfies the compiler and fails here.
      //
      // The invariants are checked FIELD BY FIELD rather than by re-parsing through
      // platformEventSchema, and that is deliberate. The schema transforms snake_case to camelCase,
      // so a round trip would need the transform reversed; and because it is a z.union, a failure
      // reports issues from all eleven branches at once, which makes "was this rejected for a
      // reason I care about?" unanswerable. Measured — the first version of this check failed
      // against the correct fake.
      for (const delivery of fixtures.everyEventType) {
        const result = adapter.translate(delivery)
        if (!result.ok) continue

        const { event } = result
        const where = `translated ${event.eventType}`

        expectTrue(typeof event.eventId === 'string' && event.eventId.length > 0, `${where} has no event id`)
        expectTrue(
          knownEventTypes.some((known) => known === event.eventType),
          `${where} has an event type outside the §18 registry`,
        )
        expectTrue(
          Number.isSafeInteger(event.eventVersion) && event.eventVersion > 0,
          `${where} has a non-positive event version`,
        )
        expectTrue(typeof event.source === 'string' && event.source.length > 0, `${where} has no source`)
        expectTrue(
          typeof event.idempotencyKey === 'string' && event.idempotencyKey.length > 0,
          `${where} has no idempotency key`,
        )
        expectTrue(
          !Number.isNaN(new Date(event.occurredAt).getTime()),
          `${where} has an occurred_at that is not a usable timestamp`,
        )
        // Not `typeof payload === 'object'` — the type already guarantees that, so the check would
        // be vacuous. An EMPTY payload is the real signal: it means the translation produced an
        // envelope and dropped everything the event was actually about.
        expectTrue(Object.keys(event.payload).length > 0, `${where} produced an empty payload`)
      }
    },
  },

  {
    name: 'preserves the provider event id, so idempotency is possible at all',
    run: () => {
      // §17.3's UNIQUE(source, external_event_id) is the platform's idempotency guarantee. An
      // adapter that minted its own id would make every redelivery look like a new event, and the
      // constraint would never fire.
      for (const delivery of fixtures.everyEventType) {
        const result = adapter.translate(delivery)
        if (!result.ok) continue

        const carrier: Record<string, unknown> =
          typeof delivery.raw === 'object' && delivery.raw !== null ? { ...delivery.raw } : {}
        const wireId = carrier.event_id
        if (typeof wireId !== 'string') continue

        expectTrue(
          result.event.eventId === wireId,
          `adapter changed the event id from "${wireId}" to "${result.event.eventId}"; ` +
            'redeliveries would no longer be recognised as duplicates',
        )
      }
    },
  },

  {
    name: 'preserves occurred_at rather than stamping arrival time',
    run: () => {
      // FR-MSG-007 requires a delayed event not to reverse a newer state. That decision is made by
      // comparing occurred_at. An adapter that overwrote it with receivedAt would make the
      // requirement unimplementable, and the symptom would be a stale event winning silently.
      const [first, second] = fixtures.outOfOrder
      const a = adapter.translate(first)
      const b = adapter.translate(second)

      expectTrue(a.ok && b.ok, 'the out-of-order fixtures must both translate')
      if (!a.ok || !b.ok) return

      expectTrue(
        new Date(a.event.occurredAt).getTime() > new Date(b.event.occurredAt).getTime(),
        'the delivery that arrived FIRST carries the LATER occurred_at, and translation must preserve ' +
          'that — the adapter appears to be stamping arrival time',
      )
      expectTrue(
        new Date(a.event.occurredAt).getTime() !== first.receivedAt.getTime(),
        'occurred_at equals receivedAt, which means the provider timestamp was discarded',
      )
    },
  },

  {
    name: 'passes a duplicate through rather than swallowing it',
    run: () => {
      // Deduplication belongs to the inbox, which is the only component that can do it correctly —
      // it has the unique constraint. An adapter that "helpfully" suppressed a repeat would hide
      // the duplicate from the one component built to handle it, and the platform would lose the
      // ability to answer "did we already process this?".
      const [first, second] = fixtures.duplicate
      const a = adapter.translate(first)
      const b = adapter.translate(second)

      expectTrue(a.ok, 'the first delivery of the duplicate pair must translate')
      expectTrue(b.ok, 'the SECOND delivery must translate too — deduplication is the inbox’s job')
      if (!a.ok || !b.ok) return

      expectTrue(
        a.event.eventId === b.event.eventId,
        'a redelivery must translate to the SAME event id, or the inbox cannot recognise it',
      )
    },
  },

  {
    name: 'is deterministic: translating the same delivery twice gives the same event',
    run: () => {
      // Non-determinism here — a generated id, a clock read — defeats the payload hash and makes a
      // redelivery indistinguishable from a changed one.
      const [delivery] = fixtures.everyEventType
      if (delivery === undefined) return

      const a = adapter.translate(delivery)
      const b = adapter.translate(delivery)
      expectTrue(a.ok && b.ok, 'the first fixture must translate')
      if (!a.ok || !b.ok) return

      expectTrue(
        JSON.stringify(a.event) === JSON.stringify(b.event),
        'translating the same delivery twice produced different events; the adapter is not pure',
      )
    },
  },

  {
    name: 'refuses what it cannot translate instead of inventing an event',
    run: () => {
      for (const { label, delivery } of fixtures.untranslatable) {
        const result = adapter.translate(delivery)
        expectTrue(!result.ok, `${label} must be refused, not translated into an event`)
        if (result.ok) continue

        expectTrue(
          Object.values(INBOUND_TRANSLATION_FAILURES).some((known) => known === result.reasonCode),
          `${label} was refused with an unregistered reason code "${result.reasonCode}"`,
        )
      }
    },
  },

  {
    name: 'reports the provider it speaks for, and stamps it on what it produces',
    run: () => {
      expectTrue(adapter.provider.length > 0, 'an adapter must name its provider')

      for (const delivery of fixtures.everyEventType) {
        const result = adapter.translate(delivery)
        if (!result.ok) continue
        expectTrue(
          result.event.source.length > 0,
          'a translated event must carry a source; the inbox constraint is on (source, event id)',
        )
      }
    },
  },
]
