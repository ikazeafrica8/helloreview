import { Injectable } from '@nestjs/common'
import type { PoolClient } from 'pg'
import { appendAtomicAudit, appendWorkflowEvent, type WorkflowActorType } from './persistence.js'
import { WORKFLOW_AUDIT_ACTION } from './reason-codes.js'

export const HUMAN_HANDOFF_PROJECTION_REASON = {
  QUEUED: 'HUMAN_HANDOFF_QUEUED',
  ASSIGNED: 'HUMAN_HANDOFF_ASSIGNED',
  RELEASED: 'HUMAN_HANDOFF_RELEASED',
  RETURNED: 'HUMAN_HANDOFF_RETURNED_TO_AUTOMATION',
  WORKFLOW_NOT_FOUND: 'HUMAN_HANDOFF_WORKFLOW_NOT_FOUND',
  STALE_VERSION: 'HUMAN_HANDOFF_STALE_WORKFLOW_VERSION',
  INVALID_STATE: 'HUMAN_HANDOFF_INVALID_WORKFLOW_STATE',
} as const

type ProjectionAction = 'queue' | 'assign' | 'release' | 'return'

export type HumanHandoffProjection = Readonly<{
  workflowId: string
  participantId: string
  campaignId: string
  campaignType: 'shipping' | 'payback' | 'visit'
  campaignStatus: 'draft' | 'active' | 'paused' | 'closed'
  version: number
  humanHandoffState: string
  automationModeState: string
}>

export class HumanHandoffProjectionError extends Error {
  override readonly name = 'HumanHandoffProjectionError'

  constructor(
    readonly reasonCode: (typeof HUMAN_HANDOFF_PROJECTION_REASON)[keyof typeof HUMAN_HANDOFF_PROJECTION_REASON],
  ) {
    super(`human handoff projection rejected: ${reasonCode}`)
  }
}

const stringColumn = (row: Record<string, unknown>, column: string): string => {
  const value = row[column]
  if (typeof value === 'string') return value
  throw new Error(`human handoff workflow query returned invalid ${column}`)
}

const projectionFrom = (row: Record<string, unknown>): HumanHandoffProjection => {
  const version = row.version
  const campaignType = stringColumn(row, 'campaign_type')
  const campaignStatus = stringColumn(row, 'campaign_status')
  if (typeof version !== 'number' || !Number.isInteger(version))
    throw new Error('workflow query returned invalid version')
  if (campaignType !== 'shipping' && campaignType !== 'payback' && campaignType !== 'visit') {
    throw new Error('workflow query returned invalid campaign type')
  }
  if (
    campaignStatus !== 'draft' &&
    campaignStatus !== 'active' &&
    campaignStatus !== 'paused' &&
    campaignStatus !== 'closed'
  ) {
    throw new Error('workflow query returned invalid campaign status')
  }
  return {
    workflowId: stringColumn(row, 'id'),
    participantId: stringColumn(row, 'participant_id'),
    campaignId: stringColumn(row, 'campaign_id'),
    campaignType,
    campaignStatus,
    version,
    humanHandoffState: stringColumn(row, 'human_handoff_state'),
    automationModeState: stringColumn(row, 'automation_mode_state'),
  }
}

const targetStates = (
  action: ProjectionAction,
  current: HumanHandoffProjection,
): Readonly<{ human: string; automation: string; reason: string; trigger: string }> => {
  switch (action) {
    case 'queue':
      if (!['not_required', 'resolved', 'returned_to_automation'].includes(current.humanHandoffState)) {
        throw new HumanHandoffProjectionError(HUMAN_HANDOFF_PROJECTION_REASON.INVALID_STATE)
      }
      return {
        human: 'queued',
        automation: ['campaign_paused', 'globally_paused', 'closed'].includes(current.automationModeState)
          ? current.automationModeState
          : 'paused_for_human',
        reason: HUMAN_HANDOFF_PROJECTION_REASON.QUEUED,
        trigger: 'HANDOFF_TASK_PERSISTED',
      }
    case 'assign':
      if (current.humanHandoffState !== 'queued') {
        throw new HumanHandoffProjectionError(HUMAN_HANDOFF_PROJECTION_REASON.INVALID_STATE)
      }
      return {
        human: 'assigned',
        automation: ['campaign_paused', 'globally_paused', 'closed'].includes(current.automationModeState)
          ? current.automationModeState
          : 'human_owned',
        reason: HUMAN_HANDOFF_PROJECTION_REASON.ASSIGNED,
        trigger: 'HANDOFF_ASSIGNED',
      }
    case 'release':
      if (current.humanHandoffState !== 'assigned' && current.humanHandoffState !== 'in_progress') {
        throw new HumanHandoffProjectionError(HUMAN_HANDOFF_PROJECTION_REASON.INVALID_STATE)
      }
      return {
        human: 'queued',
        automation: current.automationModeState === 'human_owned' ? 'paused_for_human' : current.automationModeState,
        reason: HUMAN_HANDOFF_PROJECTION_REASON.RELEASED,
        trigger: 'HANDOFF_RELEASED',
      }
    case 'return':
      if (current.humanHandoffState !== 'assigned' && current.humanHandoffState !== 'in_progress') {
        throw new HumanHandoffProjectionError(HUMAN_HANDOFF_PROJECTION_REASON.INVALID_STATE)
      }
      if (current.automationModeState !== 'human_owned' && current.automationModeState !== 'paused_for_human') {
        throw new HumanHandoffProjectionError(HUMAN_HANDOFF_PROJECTION_REASON.INVALID_STATE)
      }
      return {
        human: 'returned_to_automation',
        automation: 'active',
        reason: HUMAN_HANDOFF_PROJECTION_REASON.RETURNED,
        trigger: 'HANDOFF_RETURNED',
      }
  }
}

@Injectable()
export class HumanHandoffProjectionService {
  async loadInside(client: PoolClient, workflowId: string, lock = true): Promise<HumanHandoffProjection> {
    const result = await client.query<Record<string, unknown>>(
      `SELECT w.id, w.participant_id, w.campaign_id, w.campaign_type, w.version,
              w.human_handoff_state, w.automation_mode_state, c.status AS campaign_status
         FROM workflow_instances w
         JOIN campaigns c ON c.id = w.campaign_id
        WHERE w.id = $1${lock ? ' FOR UPDATE OF w' : ''}`,
      [workflowId],
    )
    const row = result.rows[0]
    if (row === undefined) {
      throw new HumanHandoffProjectionError(HUMAN_HANDOFF_PROJECTION_REASON.WORKFLOW_NOT_FOUND)
    }
    return projectionFrom(row)
  }

  async applyInside(
    client: PoolClient,
    input: Readonly<{
      action: ProjectionAction
      workflowId: string
      expectedVersion: number
      taskId: string
      actorType: WorkflowActorType
      actorId: string
      correlationId: string
      occurredAt: Date
    }>,
  ): Promise<HumanHandoffProjection> {
    const current = await this.loadInside(client, input.workflowId)
    if (current.version !== input.expectedVersion) {
      throw new HumanHandoffProjectionError(HUMAN_HANDOFF_PROJECTION_REASON.STALE_VERSION)
    }
    const target = targetStates(input.action, current)
    const changes = [
      ...(target.human === current.humanHandoffState
        ? []
        : [{ dimension: 'human_handoff' as const, from: current.humanHandoffState, to: target.human }]),
      ...(target.automation === current.automationModeState
        ? []
        : [{ dimension: 'automation_mode' as const, from: current.automationModeState, to: target.automation }]),
    ]
    if (changes.length === 0) throw new HumanHandoffProjectionError(HUMAN_HANDOFF_PROJECTION_REASON.INVALID_STATE)
    const nextVersion = current.version + changes.length
    const update = await client.query(
      `UPDATE workflow_instances
          SET human_handoff_state = $2,
              automation_mode_state = $3,
              human_handoff_origin_at = CASE WHEN human_handoff_state = $2 THEN human_handoff_origin_at ELSE $4 END,
              automation_mode_origin_at = CASE WHEN automation_mode_state = $3 THEN automation_mode_origin_at ELSE $4 END,
              version = $5,
              updated_at = $4
        WHERE id = $1 AND version = $6`,
      [input.workflowId, target.human, target.automation, input.occurredAt, nextVersion, current.version],
    )
    if (update.rowCount !== 1) throw new HumanHandoffProjectionError(HUMAN_HANDOFF_PROJECTION_REASON.STALE_VERSION)

    for (const [offset, change] of changes.entries()) {
      const workflowVersion = current.version + offset + 1
      const eventId = await appendWorkflowEvent(client, {
        workflowId: input.workflowId,
        expectedVersion: current.version + offset,
        workflowVersion,
        dimension: change.dimension,
        eventKind: 'transition',
        currentState: change.from,
        requestedTargetState: change.to,
        triggerCode: target.trigger,
        triggeringEventId: `human-review-task:${input.taskId}:${input.action}`,
        actorType: input.actorType,
        actorId: input.actorId,
        preconditions: { task_id: input.taskId, operation: input.action },
        decisionReason: target.reason,
        sideEffects: [],
        occurredAt: input.occurredAt,
        correlationId: input.correlationId,
        result: 'success',
      })
      await appendAtomicAudit(client, {
        actorType: input.actorType,
        actorId: input.actorId,
        action:
          input.action === 'return' && change.dimension === 'automation_mode'
            ? WORKFLOW_AUDIT_ACTION.RESUMED
            : WORKFLOW_AUDIT_ACTION.TRANSITIONED,
        targetType: 'workflow',
        targetId: input.workflowId,
        result: 'success',
        reason: target.reason,
        correlationId: input.correlationId,
        detail: {
          task_id: input.taskId,
          dimension: change.dimension,
          from: change.from,
          to: change.to,
          workflow_version: workflowVersion,
          event_id: eventId,
        },
        occurredAt: input.occurredAt,
      })
    }

    return { ...current, version: nextVersion, humanHandoffState: target.human, automationModeState: target.automation }
  }
}
