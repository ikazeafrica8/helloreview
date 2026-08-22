// The single registry of durable queue names.
//
// WHY HERE AND NOT apps/worker. tasks/todo.md put this in apps/worker/src/queues.ts, but the worker
// is only the consumer. The api is the PRODUCER — T43's transactional outbox enqueues from inside
// the same transaction as the state change — and apps/api cannot import from apps/worker. A name
// known to only one side of a queue is not a contract, so it belongs in the package both depend on.
//
// A queue name is a wire identifier: renaming one strands every job already in Redis under the old
// key. Treat these as append-only, and migrate deliberately if one ever has to change.
//
// The `queueNames` selector in eslint.config.js rejects a string literal passed to `new Queue(...)`
// or `new Worker(...)`, so the only way to name a queue is through this object.

export const QUEUE_NAMES = {
  /** Reconcile website applications when an event never arrived (T27, FR-APP-005). */
  RECONCILE_APPLICATIONS: 'reconcile-applications',
  /** Deliver notification intents committed by the transactional outbox (T45, FR-MSG-004). */
  SEND_OUTBOUND: 'send-outbound',
  /** Chase provider delivery results that are still unknown (T45, FR-MSG-009). */
  RECONCILE_DELIVERY: 'reconcile-delivery',
  /** Independently re-check delivered guidelines against the readiness gate (T55, FR-GDL-006). */
  AUDIT_GUIDELINE_DELIVERIES: 'audit-guideline-deliveries',
} as const

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES]

/** Every registered queue name. The worker binds one processor per entry. */
export const ALL_QUEUE_NAMES: readonly QueueName[] = Object.freeze(Object.values(QUEUE_NAMES))
