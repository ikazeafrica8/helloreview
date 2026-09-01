// The processor registry exports one dependency-bound handler factory per enabled queue.
//
// T5 delivered the worker's boot and connection without provider bindings. T138 now enables only
// the approved internal application-import event. External provider events remain durably received
// until their complete participant journeys and adapters are approved:
//
//   QUEUE_NAMES.RECONCILE_APPLICATIONS      T27  factory delivered; website read API still open
//   QUEUE_NAMES.SEND_OUTBOUND               T45  transactional outbox delivery
//   QUEUE_NAMES.RECONCILE_DELIVERY          T45  unknown provider delivery status
//   QUEUE_NAMES.AUDIT_GUIDELINE_DELIVERIES  T55  premature-delivery detection
//
// The runtime refuses to bind a queue with no handler rather than binding one that quietly discards
// jobs, so adding a dependency-bound entry remains the single step that brings a queue to life.

export { createWorkerHandlers } from './registry.js'

// T27 supplies the processor factory, but the concrete handler cannot be bound here until the
// website's real read API exists. Binding the fake in application code is prohibited; tests and a
// future production adapter both inject the same narrow ApplicationReconciler port.
export {
  createReconcileApplicationsHandler,
  ReconciliationPendingError,
  ReconciliationFailedError,
} from './reconcile-applications.js'
export type { ApplicationReconciler, ReconciliationProcessorOutcome } from './reconcile-applications.js'
export { createOutboundDeliveryProcessor } from './send-outbound.js'
export type { OutboundDeliveryProcessor, OutboundProcessorOptions } from './send-outbound.js'
export { createOutboundNotificationStore } from './outbound-store.js'
export type { ClaimedOutboundNotification, OutboundNotificationStore } from './outbound-store.js'
export { createAuditGuidelineDeliveriesHandler } from './audit-guideline-deliveries.js'
export type { GuidelineDeliveryAuditor } from './audit-guideline-deliveries.js'
export {
  APPROVED_INTERNAL_EVENT_TYPES,
  INBOUND_DISPATCH_REASON,
  InboundDispatchError,
  assertInboundHandlerCoverage,
  createApplicationImportCompletedHandler,
  createProcessInboundEventHandler,
} from './process-inbound-event.js'
export type {
  ApprovedInternalEventType,
  ImportedApplicationWorkflowBootstrapper,
  InboundEventContext,
  InboundEventHandler,
  InboundEventHandlers,
} from './process-inbound-event.js'
export { applicationImportWorkflowBootstrapper } from './application-import-workflow-bootstrapper.js'
export {
  WORKFLOW_SIDE_EFFECT_DISPATCH_REASON,
  WorkflowSideEffectDispatchError,
  assertWorkflowSideEffectHandlerCoverage,
  createWorkflowSideEffectDispatcher,
} from './workflow-side-effects.js'
export type {
  ClaimedWorkflowSideEffect,
  WorkflowSideEffectDispatchResult,
  WorkflowSideEffectDispatcher,
  WorkflowSideEffectHandler,
  WorkflowSideEffectHandlerOutcome,
  WorkflowSideEffectHandlers,
} from './workflow-side-effects.js'
export {
  DIRECT_APPLICATION_IDENTITY_REASON,
  DirectApplicationIdentityError,
  createDirectApplicationIdentityHandler,
  createDirectApplicationSideEffectHandlers,
} from './direct-application-identity.js'
export {
  MANUAL_SELECTION_RECOMMENDATION_REASON,
  ManualSelectionRecommendationError,
  createManualSelectionRecommendationHandler,
  createManualSelectionRecommendationSideEffectHandlers,
} from './manual-selection-recommendation.js'
