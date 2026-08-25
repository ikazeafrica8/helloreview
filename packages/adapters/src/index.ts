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

export { OutboundProviderTimeoutError } from './ports/outbound.js'
export type {
  OutboundDeliveryResult,
  OutboundProvider,
  OutboundSendRequest,
  OutboundSendResult,
} from './ports/outbound.js'
export { createFakeOutboundProvider } from './fakes/outbound-fake.js'
export type {
  FakeOutboundProvider,
  FakeOutboundProviderOptions,
  FakeReconcileBehavior,
  FakeSendBehavior,
} from './fakes/outbound-fake.js'
export { outboundConformanceChecks } from './conformance/outbound.suite.js'
export type { OutboundConformanceCheck } from './conformance/outbound.suite.js'

export { ATTACHMENT_STORAGE, ATTACHMENT_STORAGE_FAILURE, AttachmentStorageError } from './ports/attachment-storage.js'
export type {
  AttachmentObjectRequest,
  AttachmentStorage,
  AttachmentStorageFailureCode,
  PutEncryptedAttachmentRequest,
  ReadSignedAttachmentRequest,
  SignAttachmentReadRequest,
  SignedAttachmentRead,
  StoredAttachment,
} from './ports/attachment-storage.js'
export { createFakeAttachmentStorage } from './fakes/attachment-storage-fake.js'
export type { FakeAttachmentStorage } from './fakes/attachment-storage-fake.js'
export { createS3CompatibleAttachmentStorage } from './s3/s3-compatible-attachment-storage.js'
export type { S3CompatibleAttachmentStorageConfig } from './s3/s3-compatible-attachment-storage.js'
export { attachmentStorageConformanceChecks } from './conformance/attachment-storage.suite.js'
export type { AttachmentStorageConformanceCheck } from './conformance/attachment-storage.suite.js'

export { MALWARE_SCANNER, createUnavailableMalwareScanner } from './ports/malware-scanner.js'
export type { MalwareScanner, MalwareScanRequest, MalwareScanResult } from './ports/malware-scanner.js'
export { createFakeMalwareScanner } from './fakes/malware-scanner-fake.js'
export type { FakeMalwareScanner } from './fakes/malware-scanner-fake.js'

export { AI_PROVIDER_CASCADE } from './ports/ai-text-provider.js'
export type { AiTextProvider } from './ports/ai-text-provider.js'
export { createFakeAiTextProvider, createUnavailableAiTextProvider } from './fakes/ai-text-provider-fake.js'
export type { FakeAiProvider, FakeAiProviderStep } from './fakes/ai-text-provider-fake.js'
