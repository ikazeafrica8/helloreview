import { Inject, Injectable } from '@nestjs/common'
import { POSTGRES_POOL } from '@helloreview/db'
import { Pool, type PoolClient } from 'pg'
import { PauseAuthorizationError, WorkflowNotFoundError, WorkflowScopeConflictError } from './errors.js'
import { appendAtomicAudit, type WorkflowActorType } from './persistence.js'
import { WORKFLOW_AUDIT_ACTION, WORKFLOW_TRANSITION_REASON } from './reason-codes.js'
import type { CampaignType } from './state-model.js'
import type { WorkflowRecord } from './workflow-record.js'

export type AutomationPauseKind = 'standard' | 'emergency_kill_switch'
export type AutomationPauseScope = 'global' | 'campaign' | 'workflow_type' | 'participant'

export type AutomationPauseTarget =
  | Readonly<{ scope: 'global'; kind: AutomationPauseKind }>
  | Readonly<{ scope: 'campaign'; kind: 'standard'; campaignId: string }>
  | Readonly<{ scope: 'workflow_type'; kind: 'standard'; workflowType: CampaignType }>
  | Readonly<{ scope: 'participant'; kind: 'standard'; participantId: string }>

export type AutomationPauseRecord = Readonly<{
  id: string
  scope: AutomationPauseScope
  kind: AutomationPauseKind
  campaignId: string | null
  workflowType: CampaignType | null
  participantId: string | null
  reasonCode: string
  activatedAt: Date
}>

export type AutomationPauseWorkflowScope = Readonly<{
  participantId: string
  campaignId: string
  campaignType: CampaignType
}>

export const pauseAppliesToWorkflow = (
  pause: AutomationPauseRecord,
  workflow: AutomationPauseWorkflowScope,
): boolean => {
  switch (pause.scope) {
    case 'global':
      return true
    case 'campaign':
      return pause.campaignId === workflow.campaignId
    case 'workflow_type':
      return pause.workflowType === workflow.campaignType
    case 'participant':
      return pause.participantId === workflow.participantId
  }
}

type PauseActor = Readonly<{
  actorType: WorkflowActorType
  actorId: string
  authorized: boolean
  correlationId: string
}>

export type ActivatePauseInput = AutomationPauseTarget &
  PauseActor &
  Readonly<{ reasonCode: string; activatedAt?: Date }>

export type DeactivatePauseInput = PauseActor & Readonly<{ pauseId: string; reasonCode: string; deactivatedAt?: Date }>

const pauseFromRow = (row: Record<string, unknown>): AutomationPauseRecord => {
  const id = row.id
  const scope = row.scope
  const kind = row.kind
  const activatedAt = row.activated_at
  const reasonCode = row.reason_code
  if (typeof id !== 'string' || typeof reasonCode !== 'string') throw new Error('pause query returned invalid text')
  if (scope !== 'global' && scope !== 'campaign' && scope !== 'workflow_type' && scope !== 'participant') {
    throw new Error('pause query returned invalid scope')
  }
  if (kind !== 'standard' && kind !== 'emergency_kill_switch') throw new Error('pause query returned invalid kind')
  if (!(activatedAt instanceof Date) || Number.isNaN(activatedAt.getTime())) {
    throw new Error('pause query returned invalid activated_at')
  }
  const nullableString = (value: unknown): string | null => {
    if (value === null || typeof value === 'string') return value
    throw new Error('pause query returned invalid target')
  }
  const workflowType = nullableString(row.workflow_type)
  if (workflowType !== null && workflowType !== 'shipping' && workflowType !== 'payback' && workflowType !== 'visit') {
    throw new Error('pause query returned invalid workflow type')
  }
  return {
    id,
    scope,
    kind,
    campaignId: nullableString(row.campaign_id),
    workflowType,
    participantId: nullableString(row.participant_id),
    reasonCode,
    activatedAt,
  }
}

const targetId = (target: AutomationPauseTarget): string => {
  switch (target.scope) {
    case 'global':
      return 'global'
    case 'campaign':
      return target.campaignId
    case 'workflow_type':
      return target.workflowType
    case 'participant':
      return target.participantId
  }
}

@Injectable()
export class AutomationPauseService {
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  async activate(input: ActivatePauseInput): Promise<AutomationPauseRecord> {
    const activatedAt = input.activatedAt ?? new Date()
    const client = await this.pool.connect()
    let failure: Error | undefined
    let pause: AutomationPauseRecord | undefined
    try {
      await client.query('BEGIN')
      if (!input.authorized) {
        await this.auditAttempt(
          client,
          input,
          WORKFLOW_AUDIT_ACTION.PAUSED,
          'rejected',
          WORKFLOW_TRANSITION_REASON.PAUSE_NOT_AUTHORIZED,
          activatedAt,
        )
        await client.query('COMMIT')
        failure = new PauseAuthorizationError(
          'Actor is not authorized to pause automation',
          WORKFLOW_TRANSITION_REASON.PAUSE_NOT_AUTHORIZED,
        )
      } else {
        const inserted = await client.query<Record<string, unknown>>(
          `INSERT INTO automation_pauses (
             scope, kind, campaign_id, workflow_type, participant_id, reason_code,
             activated_by_type, activated_by_id, activated_at, created_at, updated_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$9)
           ON CONFLICT DO NOTHING
           RETURNING id, scope, kind, campaign_id, workflow_type, participant_id, reason_code, activated_at`,
          [
            input.scope,
            input.kind,
            input.scope === 'campaign' ? input.campaignId : null,
            input.scope === 'workflow_type' ? input.workflowType : null,
            input.scope === 'participant' ? input.participantId : null,
            input.reasonCode,
            input.actorType,
            input.actorId,
            activatedAt,
          ],
        )
        const row = inserted.rows[0]
        if (row === undefined) {
          await this.auditAttempt(
            client,
            input,
            WORKFLOW_AUDIT_ACTION.PAUSED,
            'rejected',
            WORKFLOW_TRANSITION_REASON.PAUSE_ALREADY_ACTIVE,
            activatedAt,
          )
          await client.query('COMMIT')
          failure = new WorkflowScopeConflictError(
            'An active pause already exists for this scope',
            WORKFLOW_TRANSITION_REASON.PAUSE_ALREADY_ACTIVE,
          )
        } else {
          pause = pauseFromRow(row)
          await this.auditAttempt(
            client,
            input,
            WORKFLOW_AUDIT_ACTION.PAUSED,
            'success',
            WORKFLOW_TRANSITION_REASON.PAUSE_ACTIVATED,
            activatedAt,
          )
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
    if (pause === undefined) throw new Error('pause activation completed without a result')
    return pause
  }

  async deactivate(input: DeactivatePauseInput): Promise<void> {
    const deactivatedAt = input.deactivatedAt ?? new Date()
    const client = await this.pool.connect()
    let failure: Error | undefined
    try {
      await client.query('BEGIN')
      const current = await client.query<Record<string, unknown>>(
        `SELECT id, scope, kind, campaign_id, workflow_type, participant_id, reason_code, activated_at,
                deactivated_at
           FROM automation_pauses WHERE id = $1 FOR UPDATE`,
        [input.pauseId],
      )
      const row = current.rows[0]
      if (row === undefined) {
        throw new WorkflowNotFoundError('Automation pause does not exist', WORKFLOW_TRANSITION_REASON.PAUSE_NOT_ACTIVE)
      }
      const pause = pauseFromRow(row)
      const target: AutomationPauseTarget =
        pause.scope === 'global'
          ? { scope: 'global', kind: pause.kind }
          : pause.scope === 'campaign' && pause.campaignId !== null
            ? { scope: 'campaign', kind: 'standard', campaignId: pause.campaignId }
            : pause.scope === 'workflow_type' && pause.workflowType !== null
              ? { scope: 'workflow_type', kind: 'standard', workflowType: pause.workflowType }
              : pause.scope === 'participant' && pause.participantId !== null
                ? { scope: 'participant', kind: 'standard', participantId: pause.participantId }
                : (() => {
                    throw new Error('pause row has an incoherent scope target')
                  })()
      const auditInput = { ...target, ...input }
      if (!input.authorized) {
        await this.auditAttempt(
          client,
          auditInput,
          WORKFLOW_AUDIT_ACTION.RESUMED,
          'rejected',
          WORKFLOW_TRANSITION_REASON.PAUSE_NOT_AUTHORIZED,
          deactivatedAt,
        )
        await client.query('COMMIT')
        failure = new PauseAuthorizationError(
          'Actor is not authorized to resume automation',
          WORKFLOW_TRANSITION_REASON.PAUSE_NOT_AUTHORIZED,
        )
      } else if (row.deactivated_at !== null) {
        await this.auditAttempt(
          client,
          auditInput,
          WORKFLOW_AUDIT_ACTION.RESUMED,
          'rejected',
          WORKFLOW_TRANSITION_REASON.PAUSE_NOT_ACTIVE,
          deactivatedAt,
        )
        await client.query('COMMIT')
        failure = new WorkflowScopeConflictError(
          'Automation pause is not active',
          WORKFLOW_TRANSITION_REASON.PAUSE_NOT_ACTIVE,
        )
      } else {
        await client.query(
          `UPDATE automation_pauses
              SET deactivated_by_type = $2, deactivated_by_id = $3,
                  deactivation_reason_code = $4, deactivated_at = $5, updated_at = $5
            WHERE id = $1`,
          [input.pauseId, input.actorType, input.actorId, input.reasonCode, deactivatedAt],
        )
        await appendAtomicAudit(client, {
          actorType: input.actorType,
          actorId: input.actorId,
          action: WORKFLOW_AUDIT_ACTION.RESUMED,
          targetType: `automation_pause:${target.scope}`,
          targetId: targetId(target),
          result: 'success',
          reason: WORKFLOW_TRANSITION_REASON.PAUSE_DEACTIVATED,
          correlationId: input.correlationId,
          detail: { pause_id: input.pauseId, kind: pause.kind },
          occurredAt: deactivatedAt,
        })
        await client.query('COMMIT')
      }
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
    if (failure !== undefined) throw failure
  }

  async effectiveForWorkflow(workflowId: string): Promise<readonly AutomationPauseRecord[]> {
    const context = await this.pool.query<Record<string, unknown>>(
      `SELECT participant_id, campaign_id, campaign_type FROM workflow_instances WHERE id = $1`,
      [workflowId],
    )
    const row = context.rows[0]
    if (row === undefined) {
      throw new WorkflowNotFoundError('Workflow does not exist', WORKFLOW_TRANSITION_REASON.WORKFLOW_NOT_FOUND)
    }
    const workflowType = row.campaign_type
    if (workflowType !== 'shipping' && workflowType !== 'payback' && workflowType !== 'visit') {
      throw new Error('workflow query returned invalid campaign_type')
    }
    if (typeof row.participant_id !== 'string' || typeof row.campaign_id !== 'string') {
      throw new Error('workflow query returned invalid scope')
    }
    const client = await this.pool.connect()
    try {
      return await this.effectiveForRecord(client, {
        participantId: row.participant_id,
        campaignId: row.campaign_id,
        campaignType: workflowType,
      })
    } finally {
      client.release()
    }
  }

  async effectiveForRecord(
    client: PoolClient,
    workflow: Pick<WorkflowRecord, 'participantId' | 'campaignId'> & Readonly<{ campaignType: CampaignType }>,
  ): Promise<readonly AutomationPauseRecord[]> {
    const campaignType = workflow.campaignType
    const result = await client.query<Record<string, unknown>>(
      `SELECT id, scope, kind, campaign_id, workflow_type, participant_id, reason_code, activated_at
         FROM automation_pauses
        WHERE deactivated_at IS NULL
          AND (
            scope = 'global'
            OR (scope = 'campaign' AND campaign_id = $1)
            OR (scope = 'workflow_type' AND workflow_type = $2)
            OR (scope = 'participant' AND participant_id = $3)
          )
        ORDER BY activated_at, id`,
      [workflow.campaignId, campaignType, workflow.participantId],
    )
    const scope = {
      participantId: workflow.participantId,
      campaignId: workflow.campaignId,
      campaignType,
    }
    return result.rows.map(pauseFromRow).filter((pause) => pauseAppliesToWorkflow(pause, scope))
  }

  private auditAttempt(
    client: PoolClient,
    input: AutomationPauseTarget & PauseActor,
    action: typeof WORKFLOW_AUDIT_ACTION.PAUSED | typeof WORKFLOW_AUDIT_ACTION.RESUMED,
    result: 'success' | 'rejected',
    reason: string,
    occurredAt: Date,
  ): Promise<void> {
    return appendAtomicAudit(client, {
      actorType: input.actorType,
      actorId: input.actorId,
      action,
      targetType: `automation_pause:${input.scope}`,
      targetId: targetId(input),
      result,
      reason,
      correlationId: input.correlationId,
      detail: { kind: input.kind },
      occurredAt,
    })
  }
}
