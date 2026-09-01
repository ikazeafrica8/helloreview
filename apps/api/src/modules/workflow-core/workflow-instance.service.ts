import { Inject, Injectable } from '@nestjs/common'
import { bindDbTransaction, POSTGRES_POOL } from '@helloreview/db'
import {
  WORKFLOW_BOOTSTRAP_REASON,
  WorkflowBootstrapError,
  createApplicationWorkflow,
  type WorkflowActorType,
} from '@helloreview/workflow-runtime'
import { Pool, type PoolClient } from 'pg'
import { WorkflowNotFoundError, WorkflowScopeConflictError } from './errors.js'
import { WORKFLOW_TRANSITION_REASON } from './reason-codes.js'
import { MUTABLE_WORKFLOW_DIMENSIONS } from './state-model.js'
import { WORKFLOW_SELECT_COLUMNS, workflowRecordFromRow, type WorkflowRecord } from './workflow-record.js'

export type CreateWorkflowInput = Readonly<{
  participantId: string
  applicationId: string
  campaignId: string
  actorType: WorkflowActorType
  actorId: string
  triggeringEventId: string
  correlationId: string
  occurredAt?: Date
}>

const translateBootstrapError = (error: unknown): never => {
  if (!(error instanceof WorkflowBootstrapError)) throw error
  if (error.reasonCode === WORKFLOW_BOOTSTRAP_REASON.APPLICATION_NOT_FOUND) {
    throw new WorkflowNotFoundError('Application does not exist', WORKFLOW_TRANSITION_REASON.WORKFLOW_NOT_FOUND)
  }
  throw new WorkflowScopeConflictError(
    'Application cannot be bound to the requested workflow scope',
    WORKFLOW_TRANSITION_REASON.WORKFLOW_SCOPE_CONFLICT,
  )
}

@Injectable()
export class WorkflowInstanceService {
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  async create(input: CreateWorkflowInput): Promise<WorkflowRecord> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const workflow = await this.createWithClient(client, input)
      await client.query('COMMIT')
      return workflow
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async createWithClient(client: PoolClient, input: CreateWorkflowInput): Promise<WorkflowRecord> {
    const occurredAt = input.occurredAt ?? new Date()
    try {
      await createApplicationWorkflow(bindDbTransaction(client), { ...input, occurredAt })
    } catch (error) {
      translateBootstrapError(error)
    }
    const workflow = await this.findByApplicationCampaignWithClient(client, input.applicationId, input.campaignId, true)
    if (workflow === undefined) throw new Error('workflow insert was not visible')
    return workflow
  }

  async findById(workflowId: string): Promise<WorkflowRecord | undefined> {
    const client = await this.pool.connect()
    try {
      return await this.findByIdWithClient(client, workflowId, false)
    } finally {
      client.release()
    }
  }

  async findByIdWithClient(client: PoolClient, workflowId: string, lock: boolean): Promise<WorkflowRecord | undefined> {
    const result = await client.query<Record<string, unknown>>(
      `SELECT ${WORKFLOW_SELECT_COLUMNS}
         FROM workflow_instances w
         JOIN campaigns c ON c.id = w.campaign_id
        WHERE w.id = $1${lock ? ' FOR UPDATE OF w' : ''}`,
      [workflowId],
    )
    const row = result.rows[0]
    return row === undefined ? undefined : workflowRecordFromRow(row)
  }

  async findByApplicationCampaignWithClient(
    client: PoolClient,
    applicationId: string,
    campaignId: string,
    lock: boolean,
  ): Promise<WorkflowRecord | undefined> {
    const result = await client.query<Record<string, unknown>>(
      `SELECT ${WORKFLOW_SELECT_COLUMNS}
         FROM workflow_instances w
         JOIN campaigns c ON c.id = w.campaign_id
        WHERE w.application_id = $1 AND w.campaign_id = $2${lock ? ' FOR UPDATE OF w' : ''}`,
      [applicationId, campaignId],
    )
    const row = result.rows[0]
    return row === undefined ? undefined : workflowRecordFromRow(row)
  }
}

// A single source of truth for the projection clocks used by schema/transition reviews.
export const WORKFLOW_ORIGIN_DIMENSIONS = MUTABLE_WORKFLOW_DIMENSIONS
