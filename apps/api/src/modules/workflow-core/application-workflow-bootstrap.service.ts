import { Inject, Injectable } from '@nestjs/common'
import { bindDbTransaction, POSTGRES_POOL } from '@helloreview/db'
import {
  WORKFLOW_BOOTSTRAP_REASON,
  WorkflowBootstrapError,
  bootstrapApplicationWorkflow,
} from '@helloreview/workflow-runtime'
import { WorkflowNotFoundError, WorkflowScopeConflictError } from './errors.js'
import { WORKFLOW_TRANSITION_REASON } from './reason-codes.js'
import { WorkflowInstanceService } from './workflow-instance.service.js'
import type { WorkflowRecord } from './workflow-record.js'
import type { Pool } from 'pg'

export type BootstrapApplicationWorkflowInput = Readonly<{
  applicationId: string
  participantId?: string
  triggeringEventId: string
  correlationId: string
  occurredAt?: Date
}>

export type BootstrapApplicationWorkflowOutcome = Readonly<{
  workflow: WorkflowRecord
  created: boolean
}>

/** Replay-safe bridge from an authoritative website application to one campaign workflow. */
@Injectable()
export class ApplicationWorkflowBootstrapService {
  constructor(
    @Inject(POSTGRES_POOL) private readonly pool: Pool,
    private readonly workflows: WorkflowInstanceService,
  ) {}

  async bootstrap(input: BootstrapApplicationWorkflowInput): Promise<BootstrapApplicationWorkflowOutcome> {
    const occurredAt = input.occurredAt ?? new Date()
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await bootstrapApplicationWorkflow(bindDbTransaction(client), {
        applicationId: input.applicationId,
        ...(input.participantId === undefined ? {} : { participantId: input.participantId }),
        actorType: 'system',
        actorId: 'application-import-bootstrap',
        triggeringEventId: input.triggeringEventId,
        correlationId: input.correlationId,
        occurredAt,
      })
      const workflow = await this.workflows.findByApplicationCampaignWithClient(
        client,
        result.applicationId,
        result.campaignId,
        true,
      )
      if (workflow === undefined) throw new Error('workflow bootstrap result was not visible')
      await client.query('COMMIT')
      return { workflow, created: result.created }
    } catch (error) {
      await client.query('ROLLBACK')
      if (error instanceof WorkflowBootstrapError) {
        if (error.reasonCode === WORKFLOW_BOOTSTRAP_REASON.APPLICATION_NOT_FOUND) {
          throw new WorkflowNotFoundError('Application does not exist', WORKFLOW_TRANSITION_REASON.WORKFLOW_NOT_FOUND)
        }
        throw new WorkflowScopeConflictError(
          'Application cannot be bound to the requested workflow scope',
          WORKFLOW_TRANSITION_REASON.WORKFLOW_SCOPE_CONFLICT,
        )
      }
      throw error
    } finally {
      client.release()
    }
  }
}
