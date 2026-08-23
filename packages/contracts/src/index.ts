// Platform-neutral contracts shared by every deployable.
//
// T14 adds the PRD §18 event envelopes, the typed error hierarchy and the reason-code registries
// here. Today it carries the queue registry, which both the api (producer) and the worker
// (consumer) need.

export { QUEUE_NAMES, ALL_QUEUE_NAMES } from './queues.js'
export type { QueueName } from './queues.js'
