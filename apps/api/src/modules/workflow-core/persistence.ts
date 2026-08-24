import type { PoolClient } from 'pg'
import { isProtectedAction } from '../audit-log/index.js'
import type { MutableWorkflowDimension } from './state-model.js'

export type WorkflowActorType = 'system' | 'operator' | 'participant' | 'provider' | 'scheduler'

export type WorkflowEventInput = Readonly<{
  workflowId: string
  expectedVersion: number
  workflowVersion: number
  dimension: MutableWorkflowDimension | 'campaign_type' | 'visit_method'
  eventKind: 'initialized' | 'transition' | 'transition_rejected' | 'stale_event_rejected' | 'correction'
  currentState: string
  requestedTargetState: string
  triggerCode: string
  triggeringEventId: string
  actorType: WorkflowActorType
  actorId: string
  preconditions: Readonly<Record<string, unknown>>
  ruleVersion?: string
  decisionReason: string
  sideEffects: readonly string[]
  occurredAt: Date
  correlationId: string
  result: 'success' | 'rejected' | 'corrected'
  retainedForReplay?: boolean
}>

export const appendWorkflowEvent = async (client: PoolClient, input: WorkflowEventInput): Promise<string> => {
  const result = await client.query<Record<string, unknown>>(
    `INSERT INTO workflow_events (
       workflow_id, expected_version, workflow_version, dimension, event_kind,
       current_state, requested_target_state, trigger_code, triggering_event_id,
       actor_type, actor_id, preconditions, rule_version, decision_reason, side_effects,
       occurred_at, correlation_id, result, retained_for_replay
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15::jsonb,$16,$17,$18,$19)
     RETURNING id`,
    [
      input.workflowId,
      input.expectedVersion,
      input.workflowVersion,
      input.dimension,
      input.eventKind,
      input.currentState,
      input.requestedTargetState,
      input.triggerCode,
      input.triggeringEventId,
      input.actorType,
      input.actorId,
      JSON.stringify(input.preconditions),
      input.ruleVersion ?? null,
      input.decisionReason,
      JSON.stringify(input.sideEffects),
      input.occurredAt,
      input.correlationId,
      input.result,
      input.retainedForReplay ?? false,
    ],
  )
  const id = result.rows[0]?.id
  if (typeof id !== 'string') throw new Error('workflow event insert returned no id')
  return id
}

export const appendAtomicAudit = async (
  client: PoolClient,
  input: Readonly<{
    actorType: WorkflowActorType
    actorId: string
    action: string
    targetType: string
    targetId: string
    result: 'success' | 'failure' | 'rejected'
    reason?: string
    correlationId: string
    detail?: Readonly<Record<string, unknown>>
    occurredAt: Date
  }>,
): Promise<void> => {
  await client.query(
    `INSERT INTO audit_logs (
       occurred_at, actor_type, actor_id, action, target_type, target_id,
       result, reason, correlation_id, protected_action, detail
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
    [
      input.occurredAt,
      input.actorType,
      input.actorId,
      input.action,
      input.targetType,
      input.targetId,
      input.result,
      input.reason ?? null,
      input.correlationId,
      isProtectedAction(input.action) ? 'yes' : 'no',
      JSON.stringify(input.detail ?? {}),
    ],
  )
}
