import { bootstrapApplicationWorkflow } from '@helloreview/workflow-runtime'
import type { ImportedApplicationWorkflowBootstrapper } from './process-inbound-event.js'

/** Worker-facing adapter for the shared, transaction-bound application workflow operation. */
export const applicationImportWorkflowBootstrapper: ImportedApplicationWorkflowBootstrapper = {
  bootstrap: async (tx, input): Promise<void> => {
    await bootstrapApplicationWorkflow(tx, {
      ...input,
      actorType: 'system',
      actorId: 'application-import-bootstrap',
    })
  },
}
