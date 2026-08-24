import { Inject, Injectable } from '@nestjs/common'
import { POSTGRES_POOL } from '@helloreview/db'
import { Pool, type PoolClient } from 'pg'
import { AutomationPauseService, type AutomationPauseRecord } from './automation-pause.service.js'
import {
  AutomationPausedError,
  StaleWorkflowEventError,
  StaleWorkflowVersionError,
  WorkflowNotFoundError,
  WorkflowTransitionRejectedError,
} from './errors.js'
import { appendAtomicAudit, appendWorkflowEvent, type WorkflowActorType } from './persistence.js'
import { WORKFLOW_AUDIT_ACTION, WORKFLOW_TRANSITION_REASON } from './reason-codes.js'
import type { WorkflowSnapshot } from './state-model.js'
import {
  planWorkflowTransition,
  type WorkflowGuardResults,
  type WorkflowTransitionPlan,
  type WorkflowTransitionRequest,
} from './transition-table.js'
import { WorkflowInstanceService } from './workflow-instance.service.js'
import { WORKFLOW_DIMENSION_COLUMNS, type WorkflowRecord } from './workflow-record.js'

export type ApplyWorkflowTransitionInput = WorkflowTransitionRequest &
  Readonly<{
    workflowId: string
    expectedVersion: number
    triggeringEventId: string
    actorType: WorkflowActorType
    actorId: string
    preconditionCodes: readonly string[]
    guardResults: WorkflowGuardResults
    ruleVersion?: string
    decisionReason?: string
    correlationId: string
    occurredAt: Date
    automated: boolean
    essential?: boolean
    redeliveryAuthorized?: boolean
    identityMatchCategory?: 'verified' | 'strong_match' | 'weak_match' | 'ambiguous' | 'no_match'
  }>

export type WorkflowTransitionOutcome = Readonly<{
  workflowId: string
  workflowVersion: number
  eventId: string
  transitionId: string
  snapshot: WorkflowSnapshot
  sideEffects: readonly string[]
}>

type Rejection = Readonly<{
  reasonCode: string
  transitionId: string | null
  metricKind: 'illegal_transition' | 'guard_rejection' | 'stale_event' | 'stale_version' | 'automation_pause'
  retainedForReplay: boolean
  failedGuard?: string | null
  activePauseIds?: readonly string[]
}>

@Injectable()
export class WorkflowTransitionService {
  constructor(
    @Inject(POSTGRES_POOL) private readonly pool: Pool,
    private readonly workflows: WorkflowInstanceService,
    private readonly pauses: AutomationPauseService,
  ) {}

  async apply(input: ApplyWorkflowTransitionInput): Promise<WorkflowTransitionOutcome> {
    const client = await this.pool.connect()
    let failure: Error | undefined
    let outcome: WorkflowTransitionOutcome | undefined
    try {
      await client.query('BEGIN')
      const workflow = await this.workflows.findByIdWithClient(client, input.workflowId, true)
      if (workflow === undefined) {
        throw new WorkflowNotFoundError('Workflow does not exist', WORKFLOW_TRANSITION_REASON.WORKFLOW_NOT_FOUND)
      }

      if (input.expectedVersion !== workflow.version) {
        const rejection: Rejection = {
          reasonCode: WORKFLOW_TRANSITION_REASON.STALE_VERSION,
          transitionId: null,
          metricKind: 'stale_version',
          retainedForReplay: false,
        }
        await this.persistRejection(client, workflow, input, rejection)
        await client.query('COMMIT')
        failure = new StaleWorkflowVersionError('Workflow version is stale', WORKFLOW_TRANSITION_REASON.STALE_VERSION)
      } else {
        // Classify stale/illegal/guard failures before operational pauses. A pause must stop an
        // otherwise valid action, not hide an older event that needs replay or an illegal attempt
        // that belongs in the dimension metric.
        const plan = planWorkflowTransition(workflow.snapshot, input, {
          campaignStatus: workflow.campaignStatus,
          ...(input.identityMatchCategory === undefined ? {} : { identityMatchCategory: input.identityMatchCategory }),
          guardResults: input.guardResults,
          automated: input.automated,
          redeliveryAuthorized: input.redeliveryAuthorized ?? false,
          occurredAt: input.occurredAt,
          currentStateOriginAt: workflow.origins[input.dimension],
        })
        if (!plan.approved) {
          await this.persistRejection(client, workflow, input, {
            reasonCode: plan.reasonCode,
            transitionId: plan.transitionId,
            metricKind: plan.metricKind,
            retainedForReplay: plan.retainedForReplay,
            failedGuard: plan.failedGuard,
          })
          await client.query('COMMIT')
          failure =
            plan.metricKind === 'stale_event'
              ? new StaleWorkflowEventError('Source event is older than current workflow state', plan.reasonCode)
              : new WorkflowTransitionRejectedError('Workflow transition was rejected', plan.reasonCode)
        } else {
          const activePauses = input.automated
            ? await this.pauses.effectiveForRecord(client, {
                participantId: workflow.participantId,
                campaignId: workflow.campaignId,
                campaignType: workflow.snapshot.campaign_type,
              })
            : []
          const blockingPauses = activePauses.filter((pause) =>
            isPauseBlockingTransition(pause, input.essential === true),
          )
          if (blockingPauses.length > 0) {
            await this.persistRejection(client, workflow, input, {
              reasonCode: WORKFLOW_TRANSITION_REASON.AUTOMATION_PAUSED,
              transitionId: plan.transitionId,
              metricKind: 'automation_pause',
              retainedForReplay: false,
              activePauseIds: blockingPauses.map((pause) => pause.id),
            })
            await client.query('COMMIT')
            failure = new AutomationPausedError(
              'Automated workflow progression is paused',
              WORKFLOW_TRANSITION_REASON.AUTOMATION_PAUSED,
            )
          } else {
            outcome = await this.persistApproved(client, workflow, input, plan)
            await client.query('COMMIT')
          }
        }
      }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
    if (failure !== undefined) throw failure
    if (outcome === undefined) throw new Error('workflow transition completed without a result')
    return outcome
  }

  async countRejectedByDimension(): Promise<Readonly<Record<string, number>>> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT dimension, count(*)::integer AS count
         FROM workflow_events
        WHERE result = 'rejected'
          AND preconditions ->> 'metric_kind' = 'illegal_transition'
        GROUP BY dimension
        ORDER BY dimension`,
    )
    return Object.fromEntries(
      result.rows.map((row) => {
        if (typeof row.dimension !== 'string' || typeof row.count !== 'number') {
          throw new Error('workflow rejection metric query returned invalid values')
        }
        return [row.dimension, row.count]
      }),
    )
  }

  private async persistApproved(
    client: PoolClient,
    workflow: WorkflowRecord,
    input: ApplyWorkflowTransitionInput,
    plan: Extract<WorkflowTransitionPlan, Readonly<{ approved: true }>>,
  ): Promise<WorkflowTransitionOutcome> {
    const columns = WORKFLOW_DIMENSION_COLUMNS[input.dimension]
    const nextVersion = workflow.version + 1
    const update = await client.query(
      `UPDATE workflow_instances
          SET ${columns.state} = $2, ${columns.origin} = $3, version = $4, updated_at = $3
        WHERE id = $1 AND version = $5`,
      [workflow.id, input.to, input.occurredAt, nextVersion, workflow.version],
    )
    if (update.rowCount !== 1) throw new Error('locked workflow version changed unexpectedly')

    const eventId = await appendWorkflowEvent(client, {
      workflowId: workflow.id,
      expectedVersion: input.expectedVersion,
      workflowVersion: nextVersion,
      dimension: input.dimension,
      eventKind: 'transition',
      currentState: plan.currentState,
      requestedTargetState: input.to,
      triggerCode: input.trigger,
      triggeringEventId: input.triggeringEventId,
      actorType: input.actorType,
      actorId: input.actorId,
      preconditions: {
        codes: input.preconditionCodes,
        guard_results: input.guardResults,
        evaluated_guard: plan.transitionId,
      },
      ...(input.ruleVersion === undefined ? {} : { ruleVersion: input.ruleVersion }),
      decisionReason: input.decisionReason ?? plan.reasonCode,
      sideEffects: plan.sideEffects,
      occurredAt: input.occurredAt,
      correlationId: input.correlationId,
      result: 'success',
    })
    for (const effectCode of plan.sideEffects) {
      await client.query(
        `INSERT INTO workflow_side_effects (
           workflow_id, workflow_event_id, dimension, effect_code, status, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,'pending',$5,$5)`,
        [workflow.id, eventId, input.dimension, effectCode, input.occurredAt],
      )
    }
    await appendAtomicAudit(client, {
      actorType: input.actorType,
      actorId: input.actorId,
      action: WORKFLOW_AUDIT_ACTION.TRANSITIONED,
      targetType: 'workflow',
      targetId: workflow.id,
      result: 'success',
      reason: plan.reasonCode,
      correlationId: input.correlationId,
      detail: {
        dimension: input.dimension,
        from: plan.currentState,
        to: input.to,
        transition_id: plan.transitionId,
        workflow_version: nextVersion,
        event_id: eventId,
      },
      occurredAt: input.occurredAt,
    })
    return {
      workflowId: workflow.id,
      workflowVersion: nextVersion,
      eventId,
      transitionId: plan.transitionId,
      snapshot: plan.nextSnapshot,
      sideEffects: plan.sideEffects,
    }
  }

  private async persistRejection(
    client: PoolClient,
    workflow: WorkflowRecord,
    input: ApplyWorkflowTransitionInput,
    rejection: Rejection,
  ): Promise<void> {
    const eventId = await appendWorkflowEvent(client, {
      workflowId: workflow.id,
      expectedVersion: input.expectedVersion,
      workflowVersion: workflow.version,
      dimension: input.dimension,
      eventKind: rejection.metricKind === 'stale_event' ? 'stale_event_rejected' : 'transition_rejected',
      currentState: workflow.snapshot[input.dimension],
      requestedTargetState: input.to,
      triggerCode: input.trigger,
      triggeringEventId: input.triggeringEventId,
      actorType: input.actorType,
      actorId: input.actorId,
      preconditions: {
        codes: input.preconditionCodes,
        guard_results: input.guardResults,
        failed_guard: rejection.failedGuard ?? null,
        metric_kind: rejection.metricKind,
      },
      ...(input.ruleVersion === undefined ? {} : { ruleVersion: input.ruleVersion }),
      decisionReason: rejection.reasonCode,
      sideEffects: [],
      occurredAt: input.occurredAt,
      correlationId: input.correlationId,
      result: 'rejected',
      retainedForReplay: rejection.retainedForReplay,
    })
    await appendAtomicAudit(client, {
      actorType: input.actorType,
      actorId: input.actorId,
      action: WORKFLOW_AUDIT_ACTION.TRANSITION_REJECTED,
      targetType: 'workflow',
      targetId: workflow.id,
      result: 'rejected',
      reason: rejection.reasonCode,
      correlationId: input.correlationId,
      detail: {
        dimension: input.dimension,
        from: workflow.snapshot[input.dimension],
        to: input.to,
        transition_id: rejection.transitionId,
        metric_kind: rejection.metricKind,
        expected_version: input.expectedVersion,
        actual_version: workflow.version,
        event_id: eventId,
        active_pause_ids: rejection.activePauseIds ?? [],
      },
      occurredAt: input.occurredAt,
    })
  }
}

export const isPauseBlockingTransition = (pause: AutomationPauseRecord, essential: boolean): boolean =>
  pause.kind === 'standard' || !essential
