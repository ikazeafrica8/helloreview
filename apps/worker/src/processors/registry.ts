import { QUEUE_NAMES, type QueueName } from '@helloreview/contracts'
import type { DbClient } from '@helloreview/db'
import type { JobHandler } from '../runtime.js'
import { applicationImportWorkflowBootstrapper } from './application-import-workflow-bootstrapper.js'
import {
  createApplicationImportCompletedHandler,
  createProcessInboundEventHandler,
  type InboundEventHandlers,
} from './process-inbound-event.js'

/**
 * Construct only processors whose complete dependency boundary is available at worker startup.
 *
 * This is intentionally a factory rather than a module-level object: the inbound dispatcher and
 * its domain operation must share the worker's database transaction. Provider adapters, AI/OCR,
 * outbound delivery and workflow-side-effect scheduling remain disabled.
 */
export const createWorkerHandlers = (
  db: Pick<DbClient, 'transaction'>,
): Readonly<Partial<Record<QueueName, JobHandler>>> => {
  const inboundHandlers: InboundEventHandlers = {
    'application.import.completed': createApplicationImportCompletedHandler(applicationImportWorkflowBootstrapper),
  }
  const handlers: Partial<Record<QueueName, JobHandler>> = {
    [QUEUE_NAMES.PROCESS_INBOUND_EVENT]: createProcessInboundEventHandler({ db, handlers: inboundHandlers }),
  }
  return Object.freeze(handlers)
}
