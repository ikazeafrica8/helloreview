import { Inject, Injectable } from '@nestjs/common'
import { bindDbTransaction, POSTGRES_POOL } from '@helloreview/db'
import {
  WORKFLOW_EXECUTION_REASON,
  WorkflowTransitionExecutionError,
  executeGovernedWorkflowTransition,
  isGovernedPauseBlocking,
  type GovernedWorkflowTransitionPlanner,
  type GovernedWorkflowTransitionResult,
  type WorkflowActorType,
} from '@helloreview/workflow-runtime'
import { Pool } from 'pg'
import type { AutomationPauseRecord } from './automation-pause.service.js'
import {
  AutomationPausedError,
  StaleWorkflowEventError,
  StaleWorkflowVersionError,
  WorkflowNotFoundError,
  WorkflowTransitionRejectedError,
} from './errors.js'
import { WORKFLOW_TRANSITION_REASON } from './reason-codes.js'
import type { WorkflowSnapshot } from './state-model.js'
import {
  planWorkflowTransition,
  type WorkflowGuardResults,
  type WorkflowGuardCode,
  type WorkflowTransitionRequest,
  type WorkflowTrigger,
} from './transition-table.js'

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

const governedTransitionPlanner: GovernedWorkflowTransitionPlanner<WorkflowTrigger, WorkflowGuardCode> = (
  snapshot,
  request,
  context,
) => planWorkflowTransition(snapshot, request, context)

@Injectable()
export class WorkflowTransitionService {
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  async apply(input: ApplyWorkflowTransitionInput): Promise<WorkflowTransitionOutcome> {
    const client = await this.pool.connect()
    let execution: GovernedWorkflowTransitionResult
    try {
      await client.query('BEGIN')
      execution = await executeGovernedWorkflowTransition(bindDbTransaction(client), input, governedTransitionPlanner)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      if (
        error instanceof WorkflowTransitionExecutionError &&
        error.reasonCode === WORKFLOW_EXECUTION_REASON.WORKFLOW_NOT_FOUND
      ) {
        throw new WorkflowNotFoundError('Workflow does not exist', WORKFLOW_TRANSITION_REASON.WORKFLOW_NOT_FOUND)
      }
      throw error
    } finally {
      client.release()
    }
    if (execution.status === 'applied') return execution.outcome

    const rejection = execution.rejection
    if (rejection.metricKind === 'stale_version') {
      throw new StaleWorkflowVersionError('Workflow version is stale', rejection.reasonCode)
    }
    if (rejection.metricKind === 'stale_event') {
      throw new StaleWorkflowEventError('Source event is older than current workflow state', rejection.reasonCode)
    }
    if (rejection.metricKind === 'automation_pause') {
      throw new AutomationPausedError('Automated workflow progression is paused', rejection.reasonCode)
    }
    throw new WorkflowTransitionRejectedError('Workflow transition was rejected', rejection.reasonCode)
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
}

export const isPauseBlockingTransition = (pause: AutomationPauseRecord, essential: boolean): boolean =>
  isGovernedPauseBlocking(pause, essential)
