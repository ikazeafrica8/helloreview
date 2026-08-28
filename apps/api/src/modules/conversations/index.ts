// The ONLY public surface of conversations (SPEC.md §5).

export { ConversationsModule } from './conversations.module.js'
export { ConversationService } from './conversation.service.js'
export type {
  BindConversationParticipantInput,
  BindConversationWorkflowInput,
  ConversationLifecycleInput,
  ConversationSnapshot,
  ConversationState,
  ObserveConversationInput,
} from './conversation.service.js'
export { InboundMessageService } from './inbound-message.service.js'
export type {
  InboundMessageKind,
  InboundMessageSnapshot,
  RecordInboundMessageInput,
  RecordedInboundMessage,
} from './inbound-message.service.js'
export { SecretCommentEvidenceService } from './secret-comment-evidence.service.js'
export type {
  AppendSecretCommentEvidenceInput,
  SecretCommentEvidenceSnapshot,
  SecretCommentEvidenceStatus,
} from './secret-comment-evidence.service.js'
export { CONVERSATION_ERROR, CONVERSATION_REASON, ConversationServiceError } from './reason-codes.js'
export type { ConversationErrorCode, ConversationReasonCode } from './reason-codes.js'
