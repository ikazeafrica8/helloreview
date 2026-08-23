// The processor registry: one handler per queue.
//
// EMPTY ON PURPOSE. T5 delivers the worker's boot and connection, not its jobs. Later tasks add
// entries here, each alongside the module that owns the work:
//
//   QUEUE_NAMES.RECONCILE_APPLICATIONS      T27  application-sync reconciliation
//   QUEUE_NAMES.SEND_OUTBOUND               T45  transactional outbox delivery
//   QUEUE_NAMES.RECONCILE_DELIVERY          T45  unknown provider delivery status
//   QUEUE_NAMES.AUDIT_GUIDELINE_DELIVERIES  T55  premature-delivery detection
//
// The runtime refuses to bind a queue with no handler rather than binding one that quietly discards
// jobs, so an entry added here is the single step that brings a queue to life.

import type { QueueName } from '@helloreview/contracts'
import type { JobHandler } from '../runtime.js'

export const HANDLERS: Readonly<Partial<Record<QueueName, JobHandler>>> = Object.freeze({})
