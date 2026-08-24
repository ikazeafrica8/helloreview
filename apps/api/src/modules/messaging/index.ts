export { MessagingModule } from './messaging.module.js'
export { MessageTemplateRepository, MessageTemplateResolutionError } from './message-template.repository.js'
export type { ResolvedMessageTemplate } from './message-template.repository.js'
export {
  OutboundIntentService,
  OutboundIntentError,
  HUMAN_OWNERSHIP_SYSTEM_NOTICE_ALLOWLIST,
} from './outbound-intent.service.js'
export type {
  EnqueueOutboundIntent,
  EnqueuedOutboundIntent,
  OutboundIntentSource,
  OutboundNotificationStatus,
} from './outbound-intent.service.js'
export { HumanOwnershipService, HumanOwnershipError } from './human-ownership.service.js'
export type { OperatorOwnership, TakeOwnershipInput } from './human-ownership.service.js'
export { renderMessageTemplate, TemplateRenderingError } from './template-renderer.js'
export type { TemplateVariables } from './template-renderer.js'
export { MESSAGING_REASON } from './reason-codes.js'
export type { MessagingReasonCode } from './reason-codes.js'
