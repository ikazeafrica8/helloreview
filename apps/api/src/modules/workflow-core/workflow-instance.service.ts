import { Inject, Injectable } from '@nestjs/common'
import { POSTGRES_POOL } from '@helloreview/db'
import { Pool, type PoolClient } from 'pg'
import { WorkflowNotFoundError, WorkflowScopeConflictError } from './errors.js'
import { appendAtomicAudit, appendWorkflowEvent, type WorkflowActorType } from './persistence.js'
import { WORKFLOW_AUDIT_ACTION, WORKFLOW_TRANSITION_REASON } from './reason-codes.js'
import {
  initialWorkflowSnapshot,
  MUTABLE_WORKFLOW_DIMENSIONS,
  type CampaignType,
  type VisitMethod,
  type WorkflowDimension,
  type WorkflowSnapshot,
} from './state-model.js'
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

const campaignType = (value: unknown): CampaignType => {
  if (value === 'shipping' || value === 'payback' || value === 'visit') return value
  throw new Error('workflow creation query returned an invalid campaign type')
}

const visitMethod = (value: unknown): VisitMethod => {
  if (value === 'not_applicable' || value === 'visit_a' || value === 'visit_b' || value === 'visit_c') {
    return value
  }
  throw new Error('workflow creation query returned an invalid visit method')
}

const initializationDimensions: readonly WorkflowDimension[] = [
  'application',
  'selection',
  'campaign_type',
  'visit_method',
  'secret_comment',
  'payback_consent',
  'business_approval',
  'shipping',
  'reservation',
  'guideline',
  'human_handoff',
  'automation_mode',
]

@Injectable()
export class WorkflowInstanceService {
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  async create(input: CreateWorkflowInput): Promise<WorkflowRecord> {
    const occurredAt = input.occurredAt ?? new Date()
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const source = await client.query<Record<string, unknown>>(
        `SELECT a.campaign_id, c.type, c.visit_method
           FROM applications a
           JOIN campaigns c ON c.id = a.campaign_id
          WHERE a.id = $1
          FOR SHARE`,
        [input.applicationId],
      )
      const sourceRow = source.rows[0]
      if (sourceRow === undefined) {
        throw new WorkflowNotFoundError('Application does not exist', WORKFLOW_TRANSITION_REASON.WORKFLOW_NOT_FOUND)
      }
      if (sourceRow.campaign_id !== input.campaignId) {
        throw new WorkflowScopeConflictError(
          'Application does not belong to the requested campaign',
          WORKFLOW_TRANSITION_REASON.WORKFLOW_SCOPE_CONFLICT,
        )
      }

      const snapshot = initialWorkflowSnapshot({
        campaignType: campaignType(sourceRow.type),
        visitMethod: visitMethod(sourceRow.visit_method),
      })
      const inserted = await this.insert(client, input, snapshot, occurredAt)
      const workflow = await this.findByApplicationCampaign(client, input.applicationId, input.campaignId, true)
      if (workflow === undefined) throw new Error('workflow insert was not visible')
      if (workflow.participantId !== input.participantId) {
        throw new WorkflowScopeConflictError(
          'Application is already bound to a different participant workflow',
          WORKFLOW_TRANSITION_REASON.WORKFLOW_SCOPE_CONFLICT,
        )
      }

      if (inserted) {
        for (const dimension of initializationDimensions) {
          await appendWorkflowEvent(client, {
            workflowId: workflow.id,
            expectedVersion: 0,
            workflowVersion: 0,
            dimension,
            eventKind: 'initialized',
            currentState: snapshot[dimension],
            requestedTargetState: snapshot[dimension],
            triggerCode: 'WORKFLOW_INITIALIZED',
            triggeringEventId: input.triggeringEventId,
            actorType: input.actorType,
            actorId: input.actorId,
            preconditions: { application_campaign_bound: true },
            decisionReason: WORKFLOW_TRANSITION_REASON.WORKFLOW_INITIALIZED,
            sideEffects: [],
            occurredAt,
            correlationId: input.correlationId,
            result: 'success',
          })
        }
        await appendAtomicAudit(client, {
          actorType: input.actorType,
          actorId: input.actorId,
          action: WORKFLOW_AUDIT_ACTION.CREATED,
          targetType: 'workflow',
          targetId: workflow.id,
          result: 'success',
          reason: WORKFLOW_TRANSITION_REASON.WORKFLOW_INITIALIZED,
          correlationId: input.correlationId,
          detail: { application_id: input.applicationId, campaign_id: input.campaignId },
          occurredAt,
        })
      }

      await client.query('COMMIT')
      return workflow
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
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

  private async insert(
    client: PoolClient,
    input: CreateWorkflowInput,
    snapshot: WorkflowSnapshot,
    occurredAt: Date,
  ): Promise<boolean> {
    const result = await client.query(
      `INSERT INTO workflow_instances (
         participant_id, application_id, campaign_id,
         application_state, selection_state, campaign_type, visit_method,
         secret_comment_state, payback_consent_state, business_approval_state,
         shipping_state, reservation_state, guideline_state, human_handoff_state,
         automation_mode_state,
         application_origin_at, selection_origin_at, secret_comment_origin_at,
         payback_consent_origin_at, business_approval_origin_at, shipping_origin_at,
         reservation_origin_at, guideline_origin_at, human_handoff_origin_at,
         automation_mode_origin_at, created_at, updated_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
         $16,$16,$16,$16,$16,$16,$16,$16,$16,$16,$16,$16
       ) ON CONFLICT (application_id, campaign_id) DO NOTHING
       RETURNING id`,
      [
        input.participantId,
        input.applicationId,
        input.campaignId,
        snapshot.application,
        snapshot.selection,
        snapshot.campaign_type,
        snapshot.visit_method,
        snapshot.secret_comment,
        snapshot.payback_consent,
        snapshot.business_approval,
        snapshot.shipping,
        snapshot.reservation,
        snapshot.guideline,
        snapshot.human_handoff,
        snapshot.automation_mode,
        occurredAt,
      ],
    )
    return result.rowCount === 1
  }

  private async findByApplicationCampaign(
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
