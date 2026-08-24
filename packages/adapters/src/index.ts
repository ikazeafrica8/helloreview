// Provider ports, real adapters, and the in-repo fakes they are proven against.
//
// SPEC.md §3.1 puts the provider boundary here: this package is the only place a Kakao or Aligo
// field name may exist, and everything a core module sees is a §18 PlatformEvent.
//
// Lint enforces the IMPORT half of that — no deep imports past this index, no fakes in application
// code. It does not enforce the DECLARATION half; see ports/inbound.ts for what that means.

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

export { WEBSITE_APPLICATION_STATUSES, WEBSITE_SOURCE_FAILURES, WebsiteSourceError } from './ports/website.js'
export type {
  WebsiteApplicationStatus,
  WebsiteApplicationSnapshot,
  UnversionedWebsiteApplicationSnapshot,
  WebsiteApplicationQuery,
  WebsiteApplicationSource,
  WebsiteSourceFailure,
} from './ports/website.js'

export { createFakeWebsiteApplicationSource } from './fakes/website-fake.js'
export type { FakeWebsiteApplicationSource } from './fakes/website-fake.js'

export { inboundConformanceChecks } from './conformance/inbound.suite.js'
export type { ConformanceCheck, InboundConformanceFixtures } from './conformance/inbound.suite.js'
