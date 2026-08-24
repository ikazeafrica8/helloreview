// The processor registry: one handler per queue.
//
// EMPTY ON PURPOSE. T5 delivers the worker's boot and connection, not provider bindings. A
// capability adds an entry only when every production dependency can be constructed here:
//
//   QUEUE_NAMES.RECONCILE_APPLICATIONS      T27  factory delivered; website read API still open
//   QUEUE_NAMES.SEND_OUTBOUND               T45  transactional outbox delivery
//   QUEUE_NAMES.RECONCILE_DELIVERY          T45  unknown provider delivery status
//   QUEUE_NAMES.AUDIT_GUIDELINE_DELIVERIES  T55  premature-delivery detection
//
// The runtime refuses to bind a queue with no handler rather than binding one that quietly discards
// jobs, so an entry added here is the single step that brings a queue to life.

import type { QueueName } from '@helloreview/contracts'
import type { JobHandler } from '../runtime.js'

export const HANDLERS: Readonly<Partial<Record<QueueName, JobHandler>>> = Object.freeze({})

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
