import type { DbTransaction } from '@helloreview/db'
import {
  isStateForDimension,
  type MutableWorkflowDimension,
  type WorkflowSnapshot,
  type WorkflowStateByDimension,
  type WorkflowStateChange,
} from './state-model.js'
import type { WorkflowSideEffectCode } from './side-effects.js'

export const WORKFLOW_EXECUTION_REASON = {
  WORKFLOW_NOT_FOUND: 'WORKFLOW_NOT_FOUND',
  STALE_VERSION: 'WORKFLOW_STALE_VERSION',
  AUTOMATION_PAUSED: 'WORKFLOW_AUTOMATION_PAUSED',
} as const

export class WorkflowTransitionExecutionError extends Error {
  override readonly name = 'WorkflowTransitionExecutionError'

  constructor(readonly reasonCode: string) {
    super(`Workflow transition execution failed: ${reasonCode}`)
  }
}

export type GovernedWorkflowActorType = 'system' | 'operator' | 'participant' | 'provider' | 'scheduler'
export type GovernedWorkflowMetricKind =
  'illegal_transition' | 'guard_rejection' | 'stale_event' | 'stale_version' | 'automation_pause'

export type GovernedWorkflowTransitionInput<Trigger extends string, Guard extends string> = WorkflowStateChange &
  Readonly<{
    workflowId: string
    expectedVersion: number
    triggeringEventId: string
    trigger: Trigger
    actorType: GovernedWorkflowActorType
    actorId: string
    preconditionCodes: readonly string[]
    guardResults: Readonly<Partial<Record<Guard, boolean>>>
    ruleVersion?: string
    decisionReason?: string
    correlationId: string
    occurredAt: Date
    automated: boolean
    essential?: boolean
    redeliveryAuthorized?: boolean
    identityMatchCategory?: 'verified' | 'strong_match' | 'weak_match' | 'ambiguous' | 'no_match'
  }>

export type GovernedWorkflowTransitionContext<Guard extends string> = Readonly<{
  campaignStatus: 'draft' | 'active' | 'paused' | 'closed'
  identityMatchCategory?: 'verified' | 'strong_match' | 'weak_match' | 'ambiguous' | 'no_match'
  guardResults: Readonly<Partial<Record<Guard, boolean>>>
  automated: boolean
  redeliveryAuthorized: boolean
  occurredAt: Date
  currentStateOriginAt: Date
}>

export type GovernedWorkflowTransitionPlan<Guard extends string> =
  | Readonly<{
      approved: true
      transitionId: string
      currentState: string
      nextSnapshot: WorkflowSnapshot
      reasonCode: string
      sideEffects: readonly WorkflowSideEffectCode[]
    }>
  | Readonly<{
      approved: false
      transitionId: string | null
      reasonCode: string
      failedGuard: Guard | null
      metricKind: 'illegal_transition' | 'guard_rejection' | 'stale_event'
      retainedForReplay: boolean
    }>

export type GovernedWorkflowTransitionPlanner<Trigger extends string, Guard extends string> = (
  snapshot: WorkflowSnapshot,
  request: WorkflowStateChange & Readonly<{ trigger: Trigger }>,
  context: GovernedWorkflowTransitionContext<Guard>,
) => GovernedWorkflowTransitionPlan<Guard>

export type GovernedWorkflowTransitionOutcome = Readonly<{
  workflowId: string
  workflowVersion: number
  eventId: string
  transitionId: string
  snapshot: WorkflowSnapshot
  sideEffects: readonly WorkflowSideEffectCode[]
}>

export type GovernedWorkflowTransitionResult =
  | Readonly<{ status: 'applied'; outcome: GovernedWorkflowTransitionOutcome }>
  | Readonly<{
      status: 'rejected'
      rejection: Readonly<{
        reasonCode: string
        transitionId: string | null
        metricKind: GovernedWorkflowMetricKind
      }>
    }>

type WorkflowRecord = Readonly<{
  id: string
  participantId: string
  campaignId: string
  version: number
  campaignStatus: 'draft' | 'active' | 'paused' | 'closed'
  snapshot: WorkflowSnapshot
  origins: Readonly<Record<MutableWorkflowDimension, Date>>
}>

type Rejection = Readonly<{
  reasonCode: string
  transitionId: string | null
  metricKind: GovernedWorkflowMetricKind
  retainedForReplay: boolean
  failedGuard?: string | null
  activePauseIds?: readonly string[]
}>

type AutomationPause = Readonly<{
  id: string
  kind: 'standard' | 'emergency_kill_switch' | 'privacy_request'
}>

const WORKFLOW_DIMENSION_COLUMNS: Readonly<
  Record<MutableWorkflowDimension, Readonly<{ state: string; origin: string }>>
> = {
  application: { state: 'application_state', origin: 'application_origin_at' },
  selection: { state: 'selection_state', origin: 'selection_origin_at' },
  secret_comment: { state: 'secret_comment_state', origin: 'secret_comment_origin_at' },
  payback_consent: { state: 'payback_consent_state', origin: 'payback_consent_origin_at' },
  business_approval: { state: 'business_approval_state', origin: 'business_approval_origin_at' },
  shipping: { state: 'shipping_state', origin: 'shipping_origin_at' },
  reservation: { state: 'reservation_state', origin: 'reservation_origin_at' },
  guideline: { state: 'guideline_state', origin: 'guideline_origin_at' },
  human_handoff: { state: 'human_handoff_state', origin: 'human_handoff_origin_at' },
  automation_mode: { state: 'automation_mode_state', origin: 'automation_mode_origin_at' },
}

const stringColumn = (row: Record<string, unknown>, column: string): string => {
  const value = row[column]
  if (typeof value === 'string') return value
  throw new Error(`workflow query returned an invalid ${column}`)
}

const integerColumn = (row: Record<string, unknown>, column: string): number => {
  const value = row[column]
  if (typeof value === 'number' && Number.isInteger(value)) return value
  throw new Error(`workflow query returned an invalid ${column}`)
}

const dateColumn = (row: Record<string, unknown>, column: string): Date => {
  const value = row[column]
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value
  throw new Error(`workflow query returned an invalid ${column}`)
}

const stateColumn = <Dimension extends keyof WorkflowStateByDimension>(
  row: Record<string, unknown>,
  column: string,
  dimension: Dimension,
): WorkflowStateByDimension[Dimension] => {
  const value = stringColumn(row, column)
  if (isStateForDimension(dimension, value)) return value
  throw new Error(`workflow query returned an unknown ${column}`)
}

const campaignStatusColumn = (row: Record<string, unknown>): WorkflowRecord['campaignStatus'] => {
  const value = stringColumn(row, 'campaign_status')
  if (value === 'draft' || value === 'active' || value === 'paused' || value === 'closed') return value
  throw new Error('workflow query returned an unknown campaign_status')
}

const workflowFromRow = (row: Record<string, unknown>): WorkflowRecord => ({
  id: stringColumn(row, 'id'),
  participantId: stringColumn(row, 'participant_id'),
  campaignId: stringColumn(row, 'campaign_id'),
  version: integerColumn(row, 'version'),
  campaignStatus: campaignStatusColumn(row),
  snapshot: {
    application: stateColumn(row, 'application_state', 'application'),
    selection: stateColumn(row, 'selection_state', 'selection'),
    campaign_type: stateColumn(row, 'campaign_type', 'campaign_type'),
    visit_method: stateColumn(row, 'visit_method', 'visit_method'),
    secret_comment: stateColumn(row, 'secret_comment_state', 'secret_comment'),
    payback_consent: stateColumn(row, 'payback_consent_state', 'payback_consent'),
    business_approval: stateColumn(row, 'business_approval_state', 'business_approval'),
    shipping: stateColumn(row, 'shipping_state', 'shipping'),
    reservation: stateColumn(row, 'reservation_state', 'reservation'),
    guideline: stateColumn(row, 'guideline_state', 'guideline'),
    human_handoff: stateColumn(row, 'human_handoff_state', 'human_handoff'),
    automation_mode: stateColumn(row, 'automation_mode_state', 'automation_mode'),
  },
  origins: {
    application: dateColumn(row, 'application_origin_at'),
    selection: dateColumn(row, 'selection_origin_at'),
    secret_comment: dateColumn(row, 'secret_comment_origin_at'),
    payback_consent: dateColumn(row, 'payback_consent_origin_at'),
    business_approval: dateColumn(row, 'business_approval_origin_at'),
    shipping: dateColumn(row, 'shipping_origin_at'),
    reservation: dateColumn(row, 'reservation_origin_at'),
    guideline: dateColumn(row, 'guideline_origin_at'),
    human_handoff: dateColumn(row, 'human_handoff_origin_at'),
    automation_mode: dateColumn(row, 'automation_mode_origin_at'),
  },
})

const loadLockedWorkflow = async (tx: DbTransaction, workflowId: string): Promise<WorkflowRecord | undefined> => {
  const result = await tx.query(
    `SELECT
       w.id, w.participant_id, w.campaign_id, w.version, c.status AS campaign_status,
       w.application_state, w.selection_state, w.campaign_type, w.visit_method,
       w.secret_comment_state, w.payback_consent_state, w.business_approval_state,
       w.shipping_state, w.reservation_state, w.guideline_state,
       w.human_handoff_state, w.automation_mode_state,
       w.application_origin_at, w.selection_origin_at, w.secret_comment_origin_at,
       w.payback_consent_origin_at, w.business_approval_origin_at, w.shipping_origin_at,
       w.reservation_origin_at, w.guideline_origin_at, w.human_handoff_origin_at,
       w.automation_mode_origin_at
     FROM workflow_instances w
     JOIN campaigns c ON c.id = w.campaign_id
     WHERE w.id = $1
     FOR UPDATE OF w`,
    [workflowId],
  )
  const row = result.rows[0]
  return row === undefined ? undefined : workflowFromRow(row)
}

const effectivePauses = async (tx: DbTransaction, workflow: WorkflowRecord): Promise<readonly AutomationPause[]> => {
  const result = await tx.query(
    `SELECT id, kind
       FROM automation_pauses
      WHERE deactivated_at IS NULL
        AND (
          scope = 'global'
          OR (scope = 'campaign' AND campaign_id = $1)
          OR (scope = 'workflow_type' AND workflow_type = $2)
          OR (scope = 'participant' AND participant_id = $3)
          OR (scope = 'participant_campaign' AND participant_id = $3 AND campaign_id = $1)
          OR (scope = 'workflow' AND workflow_id = $4)
        )
      ORDER BY activated_at, id`,
    [workflow.campaignId, workflow.snapshot.campaign_type, workflow.participantId, workflow.id],
  )
  return result.rows.map((row) => {
    const id = stringColumn(row, 'id')
    const kind = stringColumn(row, 'kind')
    if (kind !== 'standard' && kind !== 'emergency_kill_switch' && kind !== 'privacy_request') {
      throw new Error('pause query returned invalid kind')
    }
    return { id, kind }
  })
}

export const isGovernedPauseBlocking = (pause: Pick<AutomationPause, 'kind'>, essential: boolean): boolean =>
  pause.kind === 'standard' || !essential

const appendWorkflowEvent = async (
  tx: DbTransaction,
  input: Readonly<{
    workflowId: string
    expectedVersion: number
    workflowVersion: number
    dimension: MutableWorkflowDimension
    eventKind: 'transition' | 'transition_rejected' | 'stale_event_rejected'
    currentState: string
    requestedTargetState: string
    triggerCode: string
    triggeringEventId: string
    actorType: GovernedWorkflowActorType
    actorId: string
    preconditions: Readonly<Record<string, unknown>>
    ruleVersion?: string
    decisionReason: string
    sideEffects: readonly WorkflowSideEffectCode[]
    occurredAt: Date
    correlationId: string
    result: 'success' | 'rejected'
    retainedForReplay?: boolean
  }>,
): Promise<string> => {
  const result = await tx.query(
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

const appendAudit = async (
  tx: DbTransaction,
  input: Readonly<{
    actorType: GovernedWorkflowActorType
    actorId: string
    action: 'WORKFLOW_TRANSITIONED' | 'WORKFLOW_TRANSITION_REJECTED'
    targetId: string
    result: 'success' | 'rejected'
    reason: string
    correlationId: string
    detail: Readonly<Record<string, unknown>>
    occurredAt: Date
  }>,
): Promise<void> => {
  await tx.query(
    `INSERT INTO audit_logs (
       occurred_at, actor_type, actor_id, action, target_type, target_id,
       result, reason, correlation_id, protected_action, detail
     ) VALUES ($1,$2,$3,$4,'workflow',$5,$6,$7,$8,'yes',$9::jsonb)`,
    [
      input.occurredAt,
      input.actorType,
      input.actorId,
      input.action,
      input.targetId,
      input.result,
      input.reason,
      input.correlationId,
      JSON.stringify(input.detail),
    ],
  )
}

const persistRejection = async <Trigger extends string, Guard extends string>(
  tx: DbTransaction,
  workflow: WorkflowRecord,
  input: GovernedWorkflowTransitionInput<Trigger, Guard>,
  rejection: Rejection,
): Promise<void> => {
  const eventId = await appendWorkflowEvent(tx, {
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
  await appendAudit(tx, {
    actorType: input.actorType,
    actorId: input.actorId,
    action: 'WORKFLOW_TRANSITION_REJECTED',
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

export const executeGovernedWorkflowTransition = async <Trigger extends string, Guard extends string>(
  tx: DbTransaction,
  input: GovernedWorkflowTransitionInput<Trigger, Guard>,
  planner: GovernedWorkflowTransitionPlanner<Trigger, Guard>,
): Promise<GovernedWorkflowTransitionResult> => {
  const workflow = await loadLockedWorkflow(tx, input.workflowId)
  if (workflow === undefined) {
    throw new WorkflowTransitionExecutionError(WORKFLOW_EXECUTION_REASON.WORKFLOW_NOT_FOUND)
  }

  if (input.expectedVersion !== workflow.version) {
    const rejection: Rejection = {
      reasonCode: WORKFLOW_EXECUTION_REASON.STALE_VERSION,
      transitionId: null,
      metricKind: 'stale_version',
      retainedForReplay: false,
    }
    await persistRejection(tx, workflow, input, rejection)
    return { status: 'rejected', rejection }
  }

  // Stale, illegal, and guard failures are classified before pauses so operational controls never
  // erase the evidence needed for replay or dimension-specific rejection metrics.
  const plan = planner(workflow.snapshot, input, {
    campaignStatus: workflow.campaignStatus,
    ...(input.identityMatchCategory === undefined ? {} : { identityMatchCategory: input.identityMatchCategory }),
    guardResults: input.guardResults,
    automated: input.automated,
    redeliveryAuthorized: input.redeliveryAuthorized ?? false,
    occurredAt: input.occurredAt,
    currentStateOriginAt: workflow.origins[input.dimension],
  })
  if (!plan.approved) {
    const rejection: Rejection = {
      reasonCode: plan.reasonCode,
      transitionId: plan.transitionId,
      metricKind: plan.metricKind,
      retainedForReplay: plan.retainedForReplay,
      failedGuard: plan.failedGuard,
    }
    await persistRejection(tx, workflow, input, rejection)
    return { status: 'rejected', rejection }
  }

  const pauses = input.automated ? await effectivePauses(tx, workflow) : []
  const blockingPauses = pauses.filter((pause) => isGovernedPauseBlocking(pause, input.essential === true))
  if (blockingPauses.length > 0) {
    const rejection: Rejection = {
      reasonCode: WORKFLOW_EXECUTION_REASON.AUTOMATION_PAUSED,
      transitionId: plan.transitionId,
      metricKind: 'automation_pause',
      retainedForReplay: false,
      activePauseIds: blockingPauses.map((pause) => pause.id),
    }
    await persistRejection(tx, workflow, input, rejection)
    return { status: 'rejected', rejection }
  }

  const columns = WORKFLOW_DIMENSION_COLUMNS[input.dimension]
  const nextVersion = workflow.version + 1
  const update = await tx.query(
    `UPDATE workflow_instances
        SET ${columns.state} = $2, ${columns.origin} = $3, version = $4, updated_at = $3
      WHERE id = $1 AND version = $5
      RETURNING id`,
    [workflow.id, input.to, input.occurredAt, nextVersion, workflow.version],
  )
  if (update.rows[0]?.id !== workflow.id) throw new Error('locked workflow version changed unexpectedly')

  const eventId = await appendWorkflowEvent(tx, {
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
    await tx.query(
      `INSERT INTO workflow_side_effects (
         workflow_id, workflow_event_id, dimension, effect_code, status, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,'pending',$5,$5)`,
      [workflow.id, eventId, input.dimension, effectCode, input.occurredAt],
    )
  }
  await appendAudit(tx, {
    actorType: input.actorType,
    actorId: input.actorId,
    action: 'WORKFLOW_TRANSITIONED',
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
    status: 'applied',
    outcome: {
      workflowId: workflow.id,
      workflowVersion: nextVersion,
      eventId,
      transitionId: plan.transitionId,
      snapshot: plan.nextSnapshot,
      sideEffects: plan.sideEffects,
    },
  }
}
