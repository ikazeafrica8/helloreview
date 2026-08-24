import type { Job } from 'bullmq'
import type { JobHandler } from '../runtime.js'

export type ReconciliationProcessorOutcome = Readonly<{
  status: 'pending' | 'resolved' | 'no_match' | 'failed'
  nextAttemptAt: Date
}>

export type ApplicationReconciler = Readonly<{
  attempt: (reconciliationId: string, now?: Date) => Promise<ReconciliationProcessorOutcome>
}>

export class ReconciliationPendingError extends Error {
  override readonly name = 'ReconciliationPendingError'
  readonly reasonCode = 'APPLICATION_RECONCILIATION_PENDING'

  constructor(readonly nextAttemptAt: Date) {
    super('Application reconciliation remains inside its retry window')
  }
}

export class ReconciliationFailedError extends Error {
  override readonly name = 'ReconciliationFailedError'
  readonly reasonCode = 'APPLICATION_RECONCILIATION_FAILED'

  constructor() {
    super('Application reconciliation exhausted its retry window after a source failure')
  }
}

const reconciliationIdFrom = (data: unknown): string | undefined => {
  if (typeof data !== 'object' || data === null || !('reconciliationId' in data)) return undefined
  const carrier: Record<string, unknown> = { ...data }
  const value = carrier.reconciliationId
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * BullMQ adapter for T27. Pending outcomes throw so the queue's configured retry/backoff performs
 * the next poll; terminal no-match and resolved outcomes complete exactly once.
 */
export const createReconcileApplicationsHandler =
  (reconciler: ApplicationReconciler, now: () => Date = () => new Date()): JobHandler =>
  async (job: Job): Promise<void> => {
    const data: unknown = job.data
    const reconciliationId = reconciliationIdFrom(data)
    if (reconciliationId === undefined) throw new Error('INVALID_RECONCILIATION_JOB_PAYLOAD')

    const outcome = await reconciler.attempt(reconciliationId, now())
    if (outcome.status === 'pending') throw new ReconciliationPendingError(outcome.nextAttemptAt)
    if (outcome.status === 'failed') throw new ReconciliationFailedError()
  }
