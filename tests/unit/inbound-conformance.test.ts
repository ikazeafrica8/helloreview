// Unit tier: the inbound conformance suite, run against the fake adapter (T19).
//
// The suite in packages/adapters is framework-free — it returns named checks rather than calling
// `describe` — so this file is the thin adapter between it and Vitest. Every future provider
// adapter gets a file exactly like this one, which is the point: "swap the fake for the real
// Kakao adapter" is only a real claim if both are held to the same executable contract.
//
// There is a second group below that tests the SUITE ITSELF, by feeding it deliberately broken
// adapters. A conformance suite whose checks cannot fail is worse than none: it certifies
// everything, including the adapter that mints its own event ids and destroys idempotency.

import { test, describe, expect } from 'vitest'
import {
  createFakeInboundAdapter,
  fakeDeliveriesForEveryEventType,
  fakeDuplicateDelivery,
  fakeOutOfOrderDeliveries,
  fakeUntranslatableDeliveries,
  inboundConformanceChecks,
  type InboundAdapter,
  type InboundConformanceFixtures,
  type InboundDelivery,
  type InboundTranslation,
} from '../../packages/adapters/src/index.js'
import { EVENT_TYPES } from '../../packages/contracts/src/index.js'

const PROVIDER = 'helloreview_website'

const fixtures = (): InboundConformanceFixtures => ({
  everyEventType: fakeDeliveriesForEveryEventType(PROVIDER),
  duplicate: fakeDuplicateDelivery(PROVIDER),
  outOfOrder: fakeOutOfOrderDeliveries(PROVIDER),
  untranslatable: fakeUntranslatableDeliveries(PROVIDER),
})

describe('T19: the fake inbound adapter passes the conformance suite', () => {
  const adapter = createFakeInboundAdapter(PROVIDER)
  const checks = inboundConformanceChecks(adapter, fixtures())

  test('the suite actually contains checks', () => {
    // Guards the shape of everything below: a suite that returned [] would make every generated
    // case vanish and the file would still report green.
    expect(checks.length).toBeGreaterThanOrEqual(8)
  })

  test.each(checks.map((check) => [check.name, check] as const))('%s', (_name, check) => {
    expect(() => {
      check.run()
    }).not.toThrow()
  })
})

describe('T19 criterion 1: the fake emits every §18 event type', () => {
  const adapter = createFakeInboundAdapter(PROVIDER)

  test('one translated event per registered event type, none missing', () => {
    const produced = new Set(
      fakeDeliveriesForEveryEventType(PROVIDER).flatMap((delivery) => {
        const result = adapter.translate(delivery)
        return result.ok ? [result.event.eventType] : []
      }),
    )

    for (const eventType of Object.values(EVENT_TYPES)) {
      expect(produced.has(eventType), `the fake cannot emit ${eventType}`).toBe(true)
    }
    expect(produced.size).toBe(Object.values(EVENT_TYPES).length)
  })

  test('it emits duplicates — deduplication is the inbox’s job, not the adapter’s', () => {
    const [first, second] = fakeDuplicateDelivery(PROVIDER)
    const a = adapter.translate(first)
    const b = adapter.translate(second)

    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(a.event.eventId).toBe(b.event.eventId)
  })

  test('it emits out-of-order delivery, with occurred_at preserved', () => {
    // FR-MSG-007 depends on this: the platform must be able to see that the event which ARRIVED
    // second actually HAPPENED first.
    const [arrivedFirst, arrivedSecond] = fakeOutOfOrderDeliveries(PROVIDER)
    const a = adapter.translate(arrivedFirst)
    const b = adapter.translate(arrivedSecond)

    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return

    expect(arrivedFirst.receivedAt.getTime()).toBeLessThan(arrivedSecond.receivedAt.getTime())
    expect(new Date(a.event.occurredAt).getTime()).toBeGreaterThan(new Date(b.event.occurredAt).getTime())
  })
})

describe('the conformance suite can actually fail', () => {
  // Each of these is a plausible adapter bug. If the suite passes any of them, the corresponding
  // check is decorative — which is exactly the defect this audit-driven codebase keeps finding.

  /** Wrap the fake, corrupting one property of every successful translation. */
  const corrupted = (corrupt: (translation: InboundTranslation) => InboundTranslation): InboundAdapter => {
    const inner = createFakeInboundAdapter(PROVIDER)
    return Object.freeze({
      provider: inner.provider,
      supportedEventTypes: inner.supportedEventTypes,
      translate: (delivery: InboundDelivery) => corrupt(inner.translate(delivery)),
    })
  }

  const failuresFor = (adapter: InboundAdapter): string[] =>
    inboundConformanceChecks(adapter, fixtures()).flatMap((check) => {
      try {
        check.run()
        return []
      } catch {
        return [check.name]
      }
    })

  test('an adapter that mints its own event ids is REJECTED', () => {
    // The bug that would silently destroy idempotency: every redelivery becomes a new event, the
    // UNIQUE(source, external_event_id) constraint never fires, and duplicates are processed twice.
    let counter = 0
    const failures = failuresFor(
      corrupted((translation) => {
        if (!translation.ok) return translation
        counter += 1
        return { ok: true, event: { ...translation.event, eventId: `minted_${String(counter)}` } }
      }),
    )

    expect(failures).toContain('preserves the provider event id, so idempotency is possible at all')
  })

  test('an adapter that stamps arrival time over occurred_at is REJECTED', () => {
    const failures = failuresFor(
      corrupted((translation) =>
        translation.ok
          ? { ok: true, event: { ...translation.event, occurredAt: '2026-08-22T12:00:00+09:00' } }
          : translation,
      ),
    )

    expect(failures).toContain('preserves occurred_at rather than stamping arrival time')
  })

  test('an adapter that swallows duplicates is REJECTED', () => {
    const seen = new Set<string>()
    const inner = createFakeInboundAdapter(PROVIDER)
    const swallowing: InboundAdapter = Object.freeze({
      provider: inner.provider,
      supportedEventTypes: inner.supportedEventTypes,
      translate: (delivery: InboundDelivery) => {
        const result = inner.translate(delivery)
        if (!result.ok) return result
        if (seen.has(result.event.eventId)) {
          return { ok: false, reasonCode: 'UNRECOGNISED_PAYLOAD' } as const
        }
        seen.add(result.event.eventId)
        return result
      },
    })

    expect(failuresFor(swallowing)).toContain('passes a duplicate through rather than swallowing it')
  })

  test('an adapter that invents an event from an unrecognisable payload is REJECTED', () => {
    const inner = createFakeInboundAdapter(PROVIDER)
    const permissive: InboundAdapter = Object.freeze({
      provider: inner.provider,
      supportedEventTypes: inner.supportedEventTypes,
      translate: (delivery: InboundDelivery) => {
        const result = inner.translate(delivery)
        if (result.ok) return result
        // "Be liberal in what you accept", applied where it does the most damage.
        return inner.translate({ ...delivery, raw: fakeDeliveriesForEveryEventType(PROVIDER)[0]?.raw })
      },
    })

    expect(failuresFor(permissive)).toContain('refuses what it cannot translate instead of inventing an event')
  })

  test('a non-deterministic adapter is REJECTED', () => {
    let counter = 0
    const failures = failuresFor(
      corrupted((translation) => {
        if (!translation.ok) return translation
        counter += 1
        return { ok: true, event: { ...translation.event, eventVersion: counter } }
      }),
    )

    expect(failures).toContain('is deterministic: translating the same delivery twice gives the same event')
  })

  test('an adapter claiming support it does not have is REJECTED', () => {
    const inner = createFakeInboundAdapter(PROVIDER)
    const overclaiming: InboundAdapter = Object.freeze({
      provider: inner.provider,
      supportedEventTypes: inner.supportedEventTypes,
      // Refuses the reservation event while still declaring support for it.
      translate: (delivery: InboundDelivery) => {
        const result = inner.translate(delivery)
        if (result.ok && result.event.eventType === EVENT_TYPES.RESERVATION_SUBMITTED) {
          return { ok: false, reasonCode: 'UNSUPPORTED_EVENT_TYPE' } as const
        }
        return result
      },
    })

    expect(failuresFor(overclaiming)).toContain('translates every event type it declares support for')
  })

  test('the unmodified fake fails NOTHING, so the checks above are not simply always failing', () => {
    expect(failuresFor(createFakeInboundAdapter(PROVIDER))).toEqual([])
  })
})
