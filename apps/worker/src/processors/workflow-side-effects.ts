import type { DbClient, DbTransaction } from '@helloreview/db'
import {
  ALL_WORKFLOW_SIDE_EFFECTS,
  WORKFLOW_SIDE_EFFECT,
  isWorkflowSideEffectCode,
  type WorkflowSideEffectCode,
} from '@helloreview/workflow-runtime'

export const WORKFLOW_SIDE_EFFECT_DISPATCH_REASON = {
  HANDLER_MISSING: 'WORKFLOW_SIDE_EFFECT_HANDLER_MISSING',
  CAMPAIGN_CLOSED: 'WORKFLOW_SIDE_EFFECT_CAMPAIGN_CLOSED',
  CAMPAIGN_NOT_ACTIVE: 'WORKFLOW_SIDE_EFFECT_CAMPAIGN_NOT_ACTIVE',
  STALE_WORKFLOW_VERSION: 'WORKFLOW_SIDE_EFFECT_STALE_WORKFLOW_VERSION',
  AUTOMATION_NOT_ACTIVE: 'WORKFLOW_SIDE_EFFECT_AUTOMATION_NOT_ACTIVE',
  HUMAN_OWNERSHIP_ACTIVE: 'WORKFLOW_SIDE_EFFECT_HUMAN_OWNERSHIP_ACTIVE',
  AUTOMATION_PAUSED: 'WORKFLOW_SIDE_EFFECT_AUTOMATION_PAUSED',
  INVALID_HANDLER_OUTCOME: 'WORKFLOW_SIDE_EFFECT_INVALID_HANDLER_OUTCOME',
  UNSUPPORTED_EFFECT_CODE: 'WORKFLOW_SIDE_EFFECT_UNSUPPORTED_CODE',
} as const

export class WorkflowSideEffectDispatchError extends Error {
  override readonly name = 'WorkflowSideEffectDispatchError'

  constructor(readonly reasonCode: string) {
    super(`Workflow side effect dispatch failed: ${reasonCode}`)
  }
}

export type ClaimedWorkflowSideEffect = Readonly<{
  id: string
  workflowId: string
  workflowEventId: string
  dimension: string
  effectCode: WorkflowSideEffectCode
  participantId: string
  campaignId: string
  campaignType: 'shipping' | 'payback' | 'visit'
  campaignStatus: 'draft' | 'active' | 'paused' | 'closed'
  automationMode: string
  sourceWorkflowVersion: number
  currentWorkflowVersion: number
  sourceEventKind: 'initialized' | 'transition' | 'transition_rejected' | 'stale_event_rejected' | 'correction'
  sourceTriggerCode: string
}>

export type WorkflowSideEffectHandlerOutcome =
  | Readonly<{ status: 'completed' }>
  | Readonly<{ status: 'blocked'; reasonCode: string }>
  | Readonly<{ status: 'suppressed' | 'cancelled'; reasonCode: string }>

export type WorkflowSideEffectHandler = (
  tx: DbTransaction,
  effect: ClaimedWorkflowSideEffect,
) => Promise<WorkflowSideEffectHandlerOutcome>

export type WorkflowSideEffectHandlers = Readonly<Partial<Record<WorkflowSideEffectCode, WorkflowSideEffectHandler>>>

export type WorkflowSideEffectDispatchResult =
  | Readonly<{ status: 'idle' }>
  | Readonly<{ status: 'blocked'; effectId: string; effectCode: WorkflowSideEffectCode; reasonCode: string }>
  | Readonly<{
      status: 'completed'
      effectId: string
      effectCode: WorkflowSideEffectCode
    }>
  | Readonly<{
      status: 'suppressed' | 'cancelled'
      effectId: string
      effectCode: WorkflowSideEffectCode
      reasonCode: string
    }>

type WorkflowSideEffectPreconditionOutcome =
  | Extract<WorkflowSideEffectDispatchResult, Readonly<{ status: 'blocked' }>>
  | Extract<WorkflowSideEffectDispatchResult, Readonly<{ status: 'suppressed' | 'cancelled' }>>

export type WorkflowSideEffectDispatcher = Readonly<{
  dispatchOne: (effectId?: string) => Promise<WorkflowSideEffectDispatchResult>
  dispatchBatch: (limit?: number) => Promise<Readonly<{ inspected: number; finalized: number; blocked: boolean }>>
}>

const REASON_CODE = /^[A-Z][A-Z0-9_]*$/

const CONTROL_EFFECTS: ReadonlySet<WorkflowSideEffectCode> = new Set([
  WORKFLOW_SIDE_EFFECT.CREATE_HUMAN_TASK,
  WORKFLOW_SIDE_EFFECT.STOP_PROGRESSION,
  WORKFLOW_SIDE_EFFECT.PAUSE_AND_REVIEW,
  WORKFLOW_SIDE_EFFECT.STOP_AUTOMATION_AND_CREATE_REVIEW,
  WORKFLOW_SIDE_EFFECT.PAUSE_AUTOMATION,
  WORKFLOW_SIDE_EFFECT.CREATE_CRITICAL_INCIDENT,
])

const stringColumn = (row: Record<string, unknown>, column: string): string => {
  const value = row[column]
  if (typeof value === 'string') return value
  throw new Error(`workflow side effect query returned an invalid ${column}`)
}

const integerColumn = (row: Record<string, unknown>, column: string): number => {
  const value = row[column]
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  throw new Error(`workflow side effect query returned an invalid ${column}`)
}

const campaignTypeColumn = (row: Record<string, unknown>): ClaimedWorkflowSideEffect['campaignType'] => {
  const value = stringColumn(row, 'campaign_type')
  if (value === 'shipping' || value === 'payback' || value === 'visit') return value
  throw new Error('workflow side effect query returned an invalid campaign_type')
}

const campaignStatusColumn = (row: Record<string, unknown>): ClaimedWorkflowSideEffect['campaignStatus'] => {
  const value = stringColumn(row, 'campaign_status')
  if (value === 'draft' || value === 'active' || value === 'paused' || value === 'closed') return value
  throw new Error('workflow side effect query returned an invalid campaign_status')
}

const sourceEventKindColumn = (row: Record<string, unknown>): ClaimedWorkflowSideEffect['sourceEventKind'] => {
  const value = stringColumn(row, 'source_event_kind')
  if (
    value === 'initialized' ||
    value === 'transition' ||
    value === 'transition_rejected' ||
    value === 'stale_event_rejected' ||
    value === 'correction'
  ) {
    return value
  }
  throw new Error('workflow side effect query returned an invalid source_event_kind')
}

const effectFromRow = (row: Record<string, unknown>): ClaimedWorkflowSideEffect => {
  const effectCode = stringColumn(row, 'effect_code')
  if (!isWorkflowSideEffectCode(effectCode)) {
    throw new WorkflowSideEffectDispatchError(WORKFLOW_SIDE_EFFECT_DISPATCH_REASON.UNSUPPORTED_EFFECT_CODE)
  }
  return {
    id: stringColumn(row, 'id'),
    workflowId: stringColumn(row, 'workflow_id'),
    workflowEventId: stringColumn(row, 'workflow_event_id'),
    dimension: stringColumn(row, 'dimension'),
    effectCode,
    participantId: stringColumn(row, 'participant_id'),
    campaignId: stringColumn(row, 'campaign_id'),
    campaignType: campaignTypeColumn(row),
    campaignStatus: campaignStatusColumn(row),
    automationMode: stringColumn(row, 'automation_mode_state'),
    sourceWorkflowVersion: integerColumn(row, 'source_workflow_version'),
    currentWorkflowVersion: integerColumn(row, 'current_workflow_version'),
    sourceEventKind: sourceEventKindColumn(row),
    sourceTriggerCode: stringColumn(row, 'source_trigger_code'),
  }
}

const claimEffect = async (tx: DbTransaction, effectId?: string): Promise<ClaimedWorkflowSideEffect | undefined> => {
  const selected = await tx.query(
    `SELECT s.id, s.workflow_id, s.workflow_event_id, s.dimension, s.effect_code,
            w.participant_id, w.campaign_id, w.campaign_type, w.automation_mode_state,
            w.version AS current_workflow_version, e.workflow_version AS source_workflow_version,
            e.event_kind AS source_event_kind, e.trigger_code AS source_trigger_code,
            c.status AS campaign_status
       FROM workflow_side_effects s
       JOIN workflow_instances w ON w.id = s.workflow_id
       JOIN workflow_events e ON e.id = s.workflow_event_id
       JOIN campaigns c ON c.id = w.campaign_id
      WHERE s.status = 'pending'${effectId === undefined ? '' : ' AND s.id = $1'}
      ORDER BY s.created_at, s.id
      FOR UPDATE OF s SKIP LOCKED
      LIMIT 1`,
    effectId === undefined ? [] : [effectId],
  )
  const row = selected.rows[0]
  return row === undefined ? undefined : effectFromRow(row)
}

const hasEffectivePause = async (tx: DbTransaction, effect: ClaimedWorkflowSideEffect): Promise<boolean> => {
  const selected = await tx.query(
    `SELECT id
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
      LIMIT 1`,
    [effect.campaignId, effect.campaignType, effect.participantId, effect.workflowId],
  )
  return selected.rows[0] !== undefined
}

const preconditionOutcome = async (
  tx: DbTransaction,
  effect: ClaimedWorkflowSideEffect,
): Promise<WorkflowSideEffectPreconditionOutcome | undefined> => {
  if (CONTROL_EFFECTS.has(effect.effectCode)) return undefined
  if (effect.campaignStatus === 'closed') {
    return {
      status: 'cancelled',
      effectId: effect.id,
      effectCode: effect.effectCode,
      reasonCode: WORKFLOW_SIDE_EFFECT_DISPATCH_REASON.CAMPAIGN_CLOSED,
    }
  }
  if (effect.sourceWorkflowVersion !== effect.currentWorkflowVersion) {
    return {
      status: 'suppressed',
      effectId: effect.id,
      effectCode: effect.effectCode,
      reasonCode: WORKFLOW_SIDE_EFFECT_DISPATCH_REASON.STALE_WORKFLOW_VERSION,
    }
  }
  if (effect.automationMode === 'human_owned' || effect.automationMode === 'paused_for_human') {
    return {
      status: 'suppressed',
      effectId: effect.id,
      effectCode: effect.effectCode,
      reasonCode: WORKFLOW_SIDE_EFFECT_DISPATCH_REASON.HUMAN_OWNERSHIP_ACTIVE,
    }
  }
  if (effect.campaignStatus !== 'active') {
    return {
      status: 'blocked',
      effectId: effect.id,
      effectCode: effect.effectCode,
      reasonCode: WORKFLOW_SIDE_EFFECT_DISPATCH_REASON.CAMPAIGN_NOT_ACTIVE,
    }
  }
  if (effect.automationMode !== 'active') {
    return {
      status: 'blocked',
      effectId: effect.id,
      effectCode: effect.effectCode,
      reasonCode: WORKFLOW_SIDE_EFFECT_DISPATCH_REASON.AUTOMATION_NOT_ACTIVE,
    }
  }
  if (await hasEffectivePause(tx, effect)) {
    return {
      status: 'blocked',
      effectId: effect.id,
      effectCode: effect.effectCode,
      reasonCode: WORKFLOW_SIDE_EFFECT_DISPATCH_REASON.AUTOMATION_PAUSED,
    }
  }
  return undefined
}

const validateHandlerOutcome = (outcome: WorkflowSideEffectHandlerOutcome): void => {
  if (outcome.status === 'completed') return
  if (!REASON_CODE.test(outcome.reasonCode)) {
    throw new WorkflowSideEffectDispatchError(WORKFLOW_SIDE_EFFECT_DISPATCH_REASON.INVALID_HANDLER_OUTCOME)
  }
}

const finalize = async (
  tx: DbTransaction,
  effect: ClaimedWorkflowSideEffect,
  outcome: Extract<WorkflowSideEffectDispatchResult, Readonly<{ status: 'completed' | 'suppressed' | 'cancelled' }>>,
  now: Date,
): Promise<void> => {
  const updated = await tx.query(
    `UPDATE workflow_side_effects
        SET status = $2::workflow_side_effect_status,
            cancellation_reason = $3,
            completed_at = CASE WHEN $2::workflow_side_effect_status = 'completed' THEN $4::timestamptz ELSE NULL END,
            cancelled_at = CASE WHEN $2::workflow_side_effect_status IN ('suppressed','cancelled') THEN $4::timestamptz ELSE NULL END,
            updated_at = $4::timestamptz
      WHERE id = $1 AND status = 'pending'
      RETURNING id`,
    [effect.id, outcome.status, 'reasonCode' in outcome ? outcome.reasonCode : null, now],
  )
  if (updated.rows[0]?.id !== effect.id) throw new Error('workflow side effect finalization lost its lock')
}

export const assertWorkflowSideEffectHandlerCoverage = (handlers: WorkflowSideEffectHandlers): void => {
  for (const effectCode of ALL_WORKFLOW_SIDE_EFFECTS) {
    if (handlers[effectCode] === undefined) {
      throw new WorkflowSideEffectDispatchError(WORKFLOW_SIDE_EFFECT_DISPATCH_REASON.HANDLER_MISSING)
    }
  }
}

export const createWorkflowSideEffectDispatcher = (
  options: Readonly<{
    db: Pick<DbClient, 'transaction'>
    handlers: WorkflowSideEffectHandlers
    now?: () => Date
  }>,
): WorkflowSideEffectDispatcher => {
  const now = options.now ?? (() => new Date())

  const dispatchOne = async (effectId?: string): Promise<WorkflowSideEffectDispatchResult> =>
    options.db.transaction(async (tx) => {
      const effect = await claimEffect(tx, effectId)
      if (effect === undefined) return { status: 'idle' }

      const precondition = await preconditionOutcome(tx, effect)
      if (precondition?.status === 'blocked') return precondition
      if (precondition !== undefined) {
        await finalize(tx, effect, precondition, now())
        return precondition
      }

      const handler = options.handlers[effect.effectCode]
      if (handler === undefined) {
        throw new WorkflowSideEffectDispatchError(WORKFLOW_SIDE_EFFECT_DISPATCH_REASON.HANDLER_MISSING)
      }
      const handlerOutcome = await handler(tx, effect)
      validateHandlerOutcome(handlerOutcome)
      if (handlerOutcome.status === 'blocked') {
        return { ...handlerOutcome, effectId: effect.id, effectCode: effect.effectCode }
      }
      const outcome: Extract<
        WorkflowSideEffectDispatchResult,
        Readonly<{ status: 'completed' | 'suppressed' | 'cancelled' }>
      > = {
        ...handlerOutcome,
        effectId: effect.id,
        effectCode: effect.effectCode,
      }
      await finalize(tx, effect, outcome, now())
      return outcome
    })

  return {
    dispatchOne,
    dispatchBatch: async (limit = 25) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new Error('workflow side effect batch limit must be between 1 and 100')
      }
      let inspected = 0
      let finalized = 0
      for (let index = 0; index < limit; index += 1) {
        const outcome = await dispatchOne()
        if (outcome.status === 'idle') break
        inspected += 1
        if (outcome.status === 'blocked') return { inspected, finalized, blocked: true }
        finalized += 1
      }
      return { inspected, finalized, blocked: false }
    },
  }
}
