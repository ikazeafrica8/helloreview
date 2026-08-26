import { Inject, Injectable } from '@nestjs/common'
import { POSTGRES_POOL } from '@helloreview/db'
import { Pool, type PoolClient } from 'pg'
import {
  EmergencyKillSwitchValidationError,
  EmergencyResumeValidationError,
  PauseAuthorizationError,
  WorkflowNotFoundError,
  WorkflowScopeConflictError,
} from './errors.js'
import { appendAtomicAudit, type WorkflowActorType } from './persistence.js'
import { WORKFLOW_AUDIT_ACTION, WORKFLOW_TRANSITION_REASON } from './reason-codes.js'
import type { CampaignType } from './state-model.js'
import type { WorkflowRecord } from './workflow-record.js'

export type AutomationPauseKind = 'standard' | 'emergency_kill_switch' | 'privacy_request'
export type AutomationPauseScope =
  'global' | 'campaign' | 'workflow_type' | 'participant' | 'participant_campaign' | 'workflow'

export type AutomationPauseTarget =
  | Readonly<{ scope: 'global'; kind: AutomationPauseKind }>
  | Readonly<{ scope: 'campaign'; kind: 'standard'; campaignId: string }>
  | Readonly<{ scope: 'workflow_type'; kind: 'standard'; workflowType: CampaignType }>
  | Readonly<{ scope: 'participant'; kind: 'standard' | 'privacy_request'; participantId: string }>
  | Readonly<{
      scope: 'participant_campaign'
      kind: 'privacy_request'
      participantId: string
      campaignId: string
    }>
  | Readonly<{ scope: 'workflow'; kind: 'privacy_request'; workflowId: string }>

export type AutomationPauseRecord = Readonly<{
  id: string
  scope: AutomationPauseScope
  kind: AutomationPauseKind
  campaignId: string | null
  workflowType: CampaignType | null
  participantId: string | null
  workflowId: string | null
  reasonCode: string
  activatedAt: Date
}>

export type AutomationPauseWorkflowScope = Readonly<{
  workflowId: string
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
    case 'participant_campaign':
      return pause.participantId === workflow.participantId && pause.campaignId === workflow.campaignId
    case 'workflow':
      return pause.workflowId === workflow.workflowId
  }
}

type PauseActor = Readonly<{
  actorType: WorkflowActorType
  actorId: string
  authorized: boolean
  correlationId: string
}>

export type ActivatePauseInput = PauseActor &
  Readonly<{ reasonCode: string; activatedAt?: Date }> &
  (
    | Readonly<{ scope: 'global'; kind: 'emergency_kill_switch'; incidentReference: string }>
    | Readonly<{ scope: 'global'; kind: 'standard' }>
    | Readonly<{ scope: 'campaign'; kind: 'standard'; campaignId: string }>
    | Readonly<{ scope: 'workflow_type'; kind: 'standard'; workflowType: CampaignType }>
    | Readonly<{ scope: 'participant'; kind: 'standard'; participantId: string }>
  )

export type EmergencyResumeValidation = Readonly<{
  incidentResolved: boolean
  reconciliationComplete: boolean
  currentStateValidated: boolean
  policyVersion: string
  evaluatedAt: Date
}>

export type DeactivatePauseInput = PauseActor &
  Readonly<{
    pauseId: string
    reasonCode: string
    emergencyValidation?: EmergencyResumeValidation
    deactivatedAt?: Date
  }>

export type EmergencyKillSwitchStatus =
  Readonly<{ state: 'inactive' }> | Readonly<{ state: 'active'; pause: AutomationPauseRecord }>

const CODE = /^[A-Z][A-Z0-9_]*$/
const POLICY_VERSION = /^[a-z][a-z0-9-]*-v[0-9]+$/
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9:._/-]*$/
const MAX_VALIDATION_AGE_MS = 5 * 60_000

const isCurrentEmergencyValidation = (
  validation: EmergencyResumeValidation | undefined,
  deactivatedAt: Date,
): boolean => {
  if (validation === undefined || Number.isNaN(validation.evaluatedAt.getTime())) return false
  const age = deactivatedAt.getTime() - validation.evaluatedAt.getTime()
  return (
    validation.incidentResolved &&
    validation.reconciliationComplete &&
    validation.currentStateValidated &&
    POLICY_VERSION.test(validation.policyVersion) &&
    age >= 0 &&
    age <= MAX_VALIDATION_AGE_MS
  )
}

const pauseFromRow = (row: Record<string, unknown>): AutomationPauseRecord => {
  const id = row.id
  const scope = row.scope
  const kind = row.kind
  const activatedAt = row.activated_at
  const reasonCode = row.reason_code
  if (typeof id !== 'string' || typeof reasonCode !== 'string') throw new Error('pause query returned invalid text')
  if (
    scope !== 'global' &&
    scope !== 'campaign' &&
    scope !== 'workflow_type' &&
    scope !== 'participant' &&
    scope !== 'participant_campaign' &&
    scope !== 'workflow'
  ) {
    throw new Error('pause query returned invalid scope')
  }
  if (kind !== 'standard' && kind !== 'emergency_kill_switch' && kind !== 'privacy_request')
    throw new Error('pause query returned invalid kind')
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
    workflowId: nullableString(row.workflow_id),
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
    case 'participant_campaign':
      return `${target.participantId}:${target.campaignId}`
    case 'workflow':
      return target.workflowId
  }
}

@Injectable()
export class AutomationPauseService {
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  async activate(input: ActivatePauseInput): Promise<AutomationPauseRecord> {
    const activatedAt = input.activatedAt ?? new Date()
    if (Number.isNaN(activatedAt.getTime()) || !CODE.test(input.reasonCode)) {
      throw new EmergencyKillSwitchValidationError(
        'Automation pause reason and activation time are invalid',
        WORKFLOW_TRANSITION_REASON.EMERGENCY_INCIDENT_REFERENCE_REQUIRED,
      )
    }
    if (
      input.kind === 'emergency_kill_switch' &&
      (input.incidentReference.length > 200 ||
        !REFERENCE.test(input.incidentReference) ||
        !REFERENCE.test(input.correlationId))
    ) {
      throw new EmergencyKillSwitchValidationError(
        'Emergency activation requires a pseudonymous incident reference',
        WORKFLOW_TRANSITION_REASON.EMERGENCY_INCIDENT_REFERENCE_REQUIRED,
      )
    }
    const client = await this.pool.connect()
    let failure: Error | undefined
    let pause: AutomationPauseRecord | undefined
    try {
      await client.query('BEGIN')
      if (!input.authorized || (input.kind === 'emergency_kill_switch' && input.actorType !== 'operator')) {
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
             scope, kind, campaign_id, workflow_type, participant_id, workflow_id, reason_code,
             activated_by_type, activated_by_id, activated_at, created_at, updated_at
           ) VALUES ($1,$2,$3,$4,$5,null,$6,$7,$8,$9,$9,$9)
           ON CONFLICT DO NOTHING
           RETURNING id, scope, kind, campaign_id, workflow_type, participant_id, workflow_id, reason_code, activated_at`,
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
            input.kind === 'emergency_kill_switch'
              ? WORKFLOW_TRANSITION_REASON.EMERGENCY_SWITCH_ACTIVATED
              : WORKFLOW_TRANSITION_REASON.PAUSE_ACTIVATED,
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
    if (Number.isNaN(deactivatedAt.getTime()) || !CODE.test(input.reasonCode)) {
      throw new EmergencyResumeValidationError(
        'Automation resume reason and time are invalid',
        WORKFLOW_TRANSITION_REASON.EMERGENCY_RESUME_VALIDATION_REQUIRED,
      )
    }
    const client = await this.pool.connect()
    let failure: Error | undefined
    try {
      await client.query('BEGIN')
      const current = await client.query<Record<string, unknown>>(
        `SELECT id, scope, kind, campaign_id, workflow_type, participant_id, workflow_id, reason_code, activated_at,
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
                ? {
                    scope: 'participant',
                    kind: pause.kind === 'privacy_request' ? pause.kind : 'standard',
                    participantId: pause.participantId,
                  }
                : pause.scope === 'participant_campaign' &&
                    pause.kind === 'privacy_request' &&
                    pause.participantId !== null &&
                    pause.campaignId !== null
                  ? {
                      scope: 'participant_campaign',
                      kind: 'privacy_request',
                      participantId: pause.participantId,
                      campaignId: pause.campaignId,
                    }
                  : pause.scope === 'workflow' && pause.kind === 'privacy_request' && pause.workflowId !== null
                    ? { scope: 'workflow', kind: 'privacy_request', workflowId: pause.workflowId }
                    : (() => {
                        throw new Error('pause row has an incoherent scope target')
                      })()
      const auditInput = { ...target, ...input }
      if (!input.authorized || (pause.kind === 'emergency_kill_switch' && input.actorType !== 'operator')) {
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
      } else if (pause.kind === 'privacy_request') {
        await this.auditAttempt(
          client,
          auditInput,
          WORKFLOW_AUDIT_ACTION.RESUMED,
          'rejected',
          WORKFLOW_TRANSITION_REASON.PRIVACY_PAUSE_REQUIRES_PRIVACY_WORKFLOW,
          deactivatedAt,
        )
        await client.query('COMMIT')
        failure = new WorkflowScopeConflictError(
          'Privacy-request pauses can only be resumed by the privacy workflow',
          WORKFLOW_TRANSITION_REASON.PRIVACY_PAUSE_REQUIRES_PRIVACY_WORKFLOW,
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
      } else if (
        pause.kind === 'emergency_kill_switch' &&
        !isCurrentEmergencyValidation(input.emergencyValidation, deactivatedAt)
      ) {
        await this.auditAttempt(
          client,
          auditInput,
          WORKFLOW_AUDIT_ACTION.RESUMED,
          'rejected',
          WORKFLOW_TRANSITION_REASON.EMERGENCY_RESUME_VALIDATION_REQUIRED,
          deactivatedAt,
          {
            incident_resolved: input.emergencyValidation?.incidentResolved ?? false,
            reconciliation_complete: input.emergencyValidation?.reconciliationComplete ?? false,
            current_state_validated: input.emergencyValidation?.currentStateValidated ?? false,
            validation_policy_version: input.emergencyValidation?.policyVersion ?? null,
          },
        )
        await client.query('COMMIT')
        failure = new EmergencyResumeValidationError(
          'Emergency resume requires current incident, reconciliation, and state validation',
          WORKFLOW_TRANSITION_REASON.EMERGENCY_RESUME_VALIDATION_REQUIRED,
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
          reason:
            pause.kind === 'emergency_kill_switch'
              ? WORKFLOW_TRANSITION_REASON.EMERGENCY_SWITCH_DEACTIVATED
              : WORKFLOW_TRANSITION_REASON.PAUSE_DEACTIVATED,
          correlationId: input.correlationId,
          detail: {
            pause_id: input.pauseId,
            kind: pause.kind,
            ...(pause.kind === 'emergency_kill_switch' && input.emergencyValidation !== undefined
              ? {
                  validation_policy_version: input.emergencyValidation.policyVersion,
                  validation_evaluated_at: input.emergencyValidation.evaluatedAt.toISOString(),
                }
              : {}),
          },
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
      `SELECT id, participant_id, campaign_id, campaign_type FROM workflow_instances WHERE id = $1`,
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
        id: workflowId,
        participantId: row.participant_id,
        campaignId: row.campaign_id,
        campaignType: workflowType,
      })
    } finally {
      client.release()
    }
  }

  async emergencyStatus(): Promise<EmergencyKillSwitchStatus> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT id, scope, kind, campaign_id, workflow_type, participant_id, workflow_id, reason_code, activated_at
         FROM automation_pauses
        WHERE scope = 'global' AND kind = 'emergency_kill_switch' AND deactivated_at IS NULL
        ORDER BY activated_at DESC, id DESC
        LIMIT 1`,
    )
    const row = result.rows[0]
    return row === undefined ? { state: 'inactive' } : { state: 'active', pause: pauseFromRow(row) }
  }

  async effectiveForRecord(
    client: PoolClient,
    workflow: Pick<WorkflowRecord, 'id' | 'participantId' | 'campaignId'> & Readonly<{ campaignType: CampaignType }>,
  ): Promise<readonly AutomationPauseRecord[]> {
    const campaignType = workflow.campaignType
    const result = await client.query<Record<string, unknown>>(
      `SELECT id, scope, kind, campaign_id, workflow_type, participant_id, workflow_id, reason_code, activated_at
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
      [workflow.campaignId, campaignType, workflow.participantId, workflow.id],
    )
    const scope = {
      participantId: workflow.participantId,
      campaignId: workflow.campaignId,
      campaignType,
      workflowId: workflow.id,
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
    detail: Readonly<Record<string, unknown>> = {},
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
      detail: {
        kind: input.kind,
        ...('incidentReference' in input ? { incident_reference: input.incidentReference } : {}),
        ...detail,
      },
      occurredAt,
    })
  }
}
