// Provider ports, real adapters, and the in-repo fakes they are proven against.
//
// SPEC.md §3.1 puts the provider boundary here: a Kakao or Aligo field name appearing in a core
// module is a T6 lint error, and this package is the only place one may exist. Everything a core
// module sees is a §18 PlatformEvent.

export { INBOUND_TRANSLATION_FAILURES } from './ports/inbound.js'
export type { InboundAdapter, InboundDelivery, InboundTranslation, InboundTranslationFailure } from './ports/inbound.js'

export {
  createFakeInboundAdapter,
  fakeWireEvent,
  fakeDeliveriesForEveryEventType,
  fakeDuplicateDelivery,
  fakeOutOfOrderDeliveries,
  fakeUntranslatableDeliveries,
  fakeTranslatedEvents,
} from './fakes/inbound-fake.js'
export type { FakeEventOptions } from './fakes/inbound-fake.js'

export { inboundConformanceChecks } from './conformance/inbound.suite.js'
export type { ConformanceCheck, InboundConformanceFixtures } from './conformance/inbound.suite.js'
