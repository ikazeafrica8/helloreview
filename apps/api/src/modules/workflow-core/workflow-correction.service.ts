import { Inject, Injectable } from '@nestjs/common'
import { POSTGRES_POOL } from '@helloreview/db'
import { Pool, type PoolClient } from 'pg'
import { planWorkflowCorrection, type WorkflowCorrectionPlan } from './correction-plan.js'
import {
  StaleWorkflowVersionError,
  WorkflowCorrectionAuthorizationError,
  WorkflowCorrectionRejectedError,
  WorkflowNotFoundError,
} from './errors.js'
import { appendAtomicAudit, appendWorkflowEvent, type WorkflowActorType } from './persistence.js'
import { WORKFLOW_AUDIT_ACTION, WORKFLOW_TRANSITION_REASON } from './reason-codes.js'
import type { WorkflowSnapshot, WorkflowStateChange } from './state-model.js'
import { WORKFLOW_SIDE_EFFECT } from './transition-table.js'
import { WorkflowInstanceService } from './workflow-instance.service.js'
import { WORKFLOW_DIMENSION_COLUMNS, type WorkflowRecord } from './workflow-record.js'

export type ApplyWorkflowCorrectionInput = WorkflowStateChange &
  Readonly<{
    workflowId: string
    expectedVersion: number
    priorEventId: string
    triggeringEventId: string
    actorType: WorkflowActorType
    actorId: string
    authorized: boolean
    reasonCode: string
    correlationId: string
    occurredAt?: Date
  }>

export type WorkflowCorrectionOutcome = Readonly<{
  workflowId: string
  workflowVersion: number
  correctionEventId: string
  supersededEventId: string
  cancelledSideEffectCount: number
  criticalIncidentCreated: boolean
  snapshot: WorkflowSnapshot
}>

export type CurrentWorkflowEvent = Readonly<{
  id: string
  workflowVersion: number
  dimension: string
  eventKind: string
  currentState: string
  targetState: string
  decisionReason: string
  occurredAt: Date
}>

type PriorEvent = Readonly<{
  id: string
  dimension: string
  targetState: string
  result: string
  superseded: boolean
}>

const priorEventFromRow = (row: Record<string, unknown>): PriorEvent => {
  const stringValue = (column: string): string => {
    const value = row[column]
    if (typeof value === 'string') return value
    throw new Error(`correction query returned invalid ${column}`)
  }
  if (typeof row.superseded !== 'boolean') throw new Error('correction query returned invalid superseded flag')
  return {
    id: stringValue('id'),
    dimension: stringValue('dimension'),
    targetState: stringValue('requested_target_state'),
    result: stringValue('result'),
    superseded: row.superseded,
  }
}

@Injectable()
export class WorkflowCorrectionService {
  constructor(
    @Inject(POSTGRES_POOL) private readonly pool: Pool,
    private readonly workflows: WorkflowInstanceService,
  ) {}

  async apply(input: ApplyWorkflowCorrectionInput): Promise<WorkflowCorrectionOutcome> {
    const occurredAt = input.occurredAt ?? new Date()
    const client = await this.pool.connect()
    let failure: Error | undefined
    let outcome: WorkflowCorrectionOutcome | undefined
    try {
      await client.query('BEGIN')
      const workflow = await this.workflows.findByIdWithClient(client, input.workflowId, true)
      if (workflow === undefined) {
        throw new WorkflowNotFoundError('Workflow does not exist', WORKFLOW_TRANSITION_REASON.WORKFLOW_NOT_FOUND)
      }

      if (!input.authorized) {
        await this.auditRejected(
          client,
          workflow,
          input,
          WORKFLOW_TRANSITION_REASON.CORRECTION_NOT_AUTHORIZED,
          occurredAt,
        )
        await client.query('COMMIT')
        failure = new WorkflowCorrectionAuthorizationError(
          'Actor is not authorized to correct workflow history',
          WORKFLOW_TRANSITION_REASON.CORRECTION_NOT_AUTHORIZED,
        )
      } else if (input.expectedVersion !== workflow.version) {
        await this.auditRejected(client, workflow, input, WORKFLOW_TRANSITION_REASON.STALE_VERSION, occurredAt)
        await client.query('COMMIT')
        failure = new StaleWorkflowVersionError('Workflow version is stale', WORKFLOW_TRANSITION_REASON.STALE_VERSION)
      } else {
        const prior = await this.findPriorEvent(client, workflow.id, input.priorEventId)
        const plan = planWorkflowCorrection(workflow.snapshot, input, prior)
        if (!plan.approved) {
          await this.auditRejected(client, workflow, input, plan.reasonCode, occurredAt)
          await client.query('COMMIT')
          failure = new WorkflowCorrectionRejectedError(
            'Correction must supersede the current event and change its state',
            plan.reasonCode,
          )
        } else {
          outcome = await this.persistCorrection(client, workflow, input, plan, occurredAt)
          await client.query('COMMIT')
        }
      }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
    if (failure !== undefined) throw failure
    if (outcome === undefined) throw new Error('workflow correction completed without a result')
    return outcome
  }

  async currentEvents(workflowId: string): Promise<readonly CurrentWorkflowEvent[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT e.id, e.workflow_version, e.dimension, e.event_kind, e.current_state,
              e.requested_target_state, e.decision_reason, e.occurred_at
         FROM workflow_events e
         LEFT JOIN workflow_event_supersessions s ON s.prior_event_id = e.id
        WHERE e.workflow_id = $1 AND s.id IS NULL
        ORDER BY e.workflow_version, e.recorded_at, e.id`,
      [workflowId],
    )
    return result.rows.map((row) => {
      const text = (column: string): string => {
        const value = row[column]
        if (typeof value === 'string') return value
        throw new Error(`workflow history query returned invalid ${column}`)
      }
      if (typeof row.workflow_version !== 'number' || !(row.occurred_at instanceof Date)) {
        throw new Error('workflow history query returned invalid scalar')
      }
      return {
        id: text('id'),
        workflowVersion: row.workflow_version,
        dimension: text('dimension'),
        eventKind: text('event_kind'),
        currentState: text('current_state'),
        targetState: text('requested_target_state'),
        decisionReason: text('decision_reason'),
        occurredAt: row.occurred_at,
      }
    })
  }

  private async persistCorrection(
    client: PoolClient,
    workflow: WorkflowRecord,
    input: ApplyWorkflowCorrectionInput,
    plan: Extract<WorkflowCorrectionPlan, Readonly<{ approved: true }>>,
    occurredAt: Date,
  ): Promise<WorkflowCorrectionOutcome> {
    const columns = WORKFLOW_DIMENSION_COLUMNS[input.dimension]
    const nextVersion = workflow.version + 1

    const update = await client.query(
      `UPDATE workflow_instances
          SET ${columns.state} = $2, ${columns.origin} = GREATEST(${columns.origin}, $3),
              version = $4, updated_at = GREATEST(updated_at, $3)
        WHERE id = $1 AND version = $5`,
      [workflow.id, input.to, occurredAt, nextVersion, workflow.version],
    )
    if (update.rowCount !== 1) throw new Error('locked workflow version changed unexpectedly')

    const correctionEventId = await appendWorkflowEvent(client, {
      workflowId: workflow.id,
      expectedVersion: input.expectedVersion,
      workflowVersion: nextVersion,
      dimension: input.dimension,
      eventKind: 'correction',
      currentState: workflow.snapshot[input.dimension],
      requestedTargetState: input.to,
      triggerCode: 'WORKFLOW_CORRECTION_APPLIED',
      triggeringEventId: input.triggeringEventId,
      actorType: input.actorType,
      actorId: input.actorId,
      preconditions: { authorized: true, superseded_event_id: input.priorEventId },
      decisionReason: input.reasonCode,
      sideEffects: plan.sideEffects,
      occurredAt,
      correlationId: input.correlationId,
      result: 'corrected',
    })
    await client.query(
      `INSERT INTO workflow_event_supersessions (
         workflow_id, prior_event_id, correction_event_id, actor_type, actor_id,
         reason_code, occurred_at, correlation_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        workflow.id,
        input.priorEventId,
        correctionEventId,
        input.actorType,
        input.actorId,
        input.reasonCode,
        occurredAt,
        input.correlationId,
      ],
    )
    const cancelled = await client.query(
      `UPDATE workflow_side_effects
          SET status = 'cancelled', cancellation_reason = $3, invalidated_by_event_id = $2,
              cancelled_at = $4, updated_at = $4
        WHERE workflow_id = $1 AND workflow_event_id <> $2 AND status = 'pending'`,
      [workflow.id, correctionEventId, WORKFLOW_TRANSITION_REASON.SIDE_EFFECT_INVALIDATED, occurredAt],
    )
    await client.query(
      `INSERT INTO workflow_side_effects (
         workflow_id, workflow_event_id, dimension, effect_code, status, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,'pending',$5,$5)`,
      [
        workflow.id,
        correctionEventId,
        input.dimension,
        WORKFLOW_SIDE_EFFECT.REEVALUATE_GUIDELINE_READINESS,
        occurredAt,
      ],
    )

    if (plan.criticalIncidentRequired) {
      await client.query(
        `INSERT INTO workflow_incidents (
           workflow_id, workflow_event_id, severity, reason_code, status, created_at
         ) VALUES ($1,$2,'critical',$3,'open',$4)`,
        [workflow.id, correctionEventId, WORKFLOW_TRANSITION_REASON.DELIVERED_GUIDELINE_INVALIDATED, occurredAt],
      )
      await appendAtomicAudit(client, {
        actorType: input.actorType,
        actorId: input.actorId,
        action: WORKFLOW_AUDIT_ACTION.INCIDENT_CREATED,
        targetType: 'workflow',
        targetId: workflow.id,
        result: 'success',
        reason: WORKFLOW_TRANSITION_REASON.DELIVERED_GUIDELINE_INVALIDATED,
        correlationId: input.correlationId,
        detail: { correction_event_id: correctionEventId },
        occurredAt,
      })
    }
    await appendAtomicAudit(client, {
      actorType: input.actorType,
      actorId: input.actorId,
      action: WORKFLOW_AUDIT_ACTION.CORRECTED,
      targetType: 'workflow',
      targetId: workflow.id,
      result: 'success',
      reason: input.reasonCode,
      correlationId: input.correlationId,
      detail: {
        dimension: input.dimension,
        from: workflow.snapshot[input.dimension],
        to: input.to,
        superseded_event_id: input.priorEventId,
        correction_event_id: correctionEventId,
        workflow_version: nextVersion,
      },
      occurredAt,
    })
    return {
      workflowId: workflow.id,
      workflowVersion: nextVersion,
      correctionEventId,
      supersededEventId: input.priorEventId,
      cancelledSideEffectCount: cancelled.rowCount ?? 0,
      criticalIncidentCreated: plan.criticalIncidentRequired,
      snapshot: plan.nextSnapshot,
    }
  }

  private async findPriorEvent(
    client: PoolClient,
    workflowId: string,
    eventId: string,
  ): Promise<PriorEvent | undefined> {
    const result = await client.query<Record<string, unknown>>(
      `SELECT e.id, e.dimension, e.requested_target_state, e.result, (s.id IS NOT NULL) AS superseded
         FROM workflow_events e
         LEFT JOIN workflow_event_supersessions s ON s.prior_event_id = e.id
        WHERE e.workflow_id = $1 AND e.id = $2
        FOR SHARE OF e`,
      [workflowId, eventId],
    )
    const row = result.rows[0]
    return row === undefined ? undefined : priorEventFromRow(row)
  }

  private auditRejected(
    client: PoolClient,
    workflow: WorkflowRecord,
    input: ApplyWorkflowCorrectionInput,
    reason: string,
    occurredAt: Date,
  ): Promise<void> {
    return appendAtomicAudit(client, {
      actorType: input.actorType,
      actorId: input.actorId,
      action: WORKFLOW_AUDIT_ACTION.CORRECTED,
      targetType: 'workflow',
      targetId: workflow.id,
      result: 'rejected',
      reason,
      correlationId: input.correlationId,
      detail: {
        dimension: input.dimension,
        requested_target: input.to,
        superseded_event_id: input.priorEventId,
        expected_version: input.expectedVersion,
        actual_version: workflow.version,
      },
      occurredAt,
    })
  }
}
