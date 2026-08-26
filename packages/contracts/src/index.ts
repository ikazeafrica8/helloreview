// Platform-neutral contracts shared by every deployable.
//
// This package is the only place a provider's wire format is named. Everything downstream sees the
// parsed domain shape, which is what SPEC.md §3.1 means by the adapters boundary — a Kakao field
// name appearing in a core module is a lint error (T6), and this is the file that makes that
// achievable rather than merely required.

export { QUEUE_NAMES, ALL_QUEUE_NAMES } from './queues.js'
export type { QueueName } from './queues.js'

// PRD §18 events.
export { platformEventSchema, acceptanceResponseSchema, EVENT_TYPES } from './events/envelope.js'
export type { PlatformEvent, EventOfType, EventType, AcceptanceResponse } from './events/envelope.js'

// PRD §18.4 error model.
export {
  ContractError,
  InvalidEnvelopeError,
  UnauthenticatedError,
  ForbiddenError,
  StaleVersionError,
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
  UnprocessableCommandError,
  RateLimitedError,
  DependencyUnavailableError,
} from './errors.js'
export type { ContractErrorStatus } from './errors.js'

// FR-MSG-002 message purpose codes.
export {
  MESSAGE_PURPOSES,
  ALL_MESSAGE_PURPOSES,
  PARAMETERISED_PURPOSES,
  PARAMETERISED_TEMPLATE_PURPOSES,
  PURPOSE_PARAMETER_SEPARATOR,
  isMessagePurpose,
  composePurpose,
  purposeStem,
  isWellFormedPurposeCode,
  isWellFormedTemplatePurposeCode,
} from './purposes.js'
export type { MessagePurpose } from './purposes.js'

// PRD §17.4 canonical outbound idempotency identity.
export { OUTBOUND_CHANNELS, buildDedupeKey } from './dedupe-key.js'
export type { DedupeKeyInput, OutboundChannel } from './dedupe-key.js'

// T103 canonical administrative authorization vocabulary.
export { ADMIN_ACTIONS } from './admin-actions.js'
export type { AdminAction } from './admin-actions.js'

export {
  AI_TASKS,
  AI_INTENT_CODES,
  AI_PROTECTED_STATE_BOUNDARY,
  aiRequestSchema,
  aiIntentEvidenceSchema,
  aiDateTimeEvidenceSchema,
  aiAdvisoryEvidenceSchema,
  aiEvidenceSchema,
  aiResultSchema,
} from './ai.js'
export type {
  AiTask,
  AiIntentCode,
  AiRequest,
  AiIntentEvidence,
  AiDateTimeEvidence,
  AiAdvisoryEvidence,
  AiEvidence,
  AiResult,
  AiProtectedStateBoundary,
} from './ai.js'
