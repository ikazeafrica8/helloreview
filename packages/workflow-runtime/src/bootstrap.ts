import type { DbTransaction } from '@helloreview/db'
import {
  initialWorkflowSnapshot,
  type CampaignType,
  type VisitMethod,
  type WorkflowDimension,
  type WorkflowSnapshot,
} from './state-model.js'
import { WORKFLOW_SIDE_EFFECT } from './side-effects.js'

export const WORKFLOW_BOOTSTRAP_REASON = {
  APPLICATION_NOT_FOUND: 'WORKFLOW_NOT_FOUND',
  SCOPE_CONFLICT: 'WORKFLOW_SCOPE_CONFLICT',
  INITIALIZED: 'WORKFLOW_INITIALIZED',
} as const

export class WorkflowBootstrapError extends Error {
  override readonly name = 'WorkflowBootstrapError'

  constructor(readonly reasonCode: string) {
    super(`Workflow bootstrap failed: ${reasonCode}`)
  }
}

export type WorkflowActorType = 'system' | 'operator' | 'participant' | 'provider' | 'scheduler'

export type CreateApplicationWorkflowInput = Readonly<{
  participantId: string
  applicationId: string
  campaignId: string
  actorType: WorkflowActorType
  actorId: string
  triggeringEventId: string
  correlationId: string
  occurredAt: Date
  initialApplicationState?: 'not_applied' | 'application_completed'
}>

export type BootstrapApplicationWorkflowInput = Readonly<{
  applicationId: string
  participantId?: string
  actorType: WorkflowActorType
  actorId: string
  triggeringEventId: string
  correlationId: string
  occurredAt: Date
}>

export type WorkflowBootstrapResult = Readonly<{
  workflowId: string
  participantId: string
  applicationId: string
  campaignId: string
  created: boolean
}>

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

const stringColumn = (row: Record<string, unknown>, column: string): string => {
  const value = row[column]
  if (typeof value === 'string') return value
  throw new Error(`workflow bootstrap query returned an invalid ${column}`)
}

const campaignType = (value: unknown): CampaignType => {
  if (value === 'shipping' || value === 'payback' || value === 'visit') return value
  throw new Error('workflow bootstrap query returned an invalid campaign type')
}

const visitMethod = (value: unknown): VisitMethod => {
  if (value === 'not_applicable' || value === 'visit_a' || value === 'visit_b' || value === 'visit_c') {
    return value
  }
  throw new Error('workflow bootstrap query returned an invalid visit method')
}

const appendInitializationEvidence = async (
  tx: DbTransaction,
  input: CreateApplicationWorkflowInput,
  workflowId: string,
  snapshot: WorkflowSnapshot,
): Promise<string> => {
  let applicationEventId: string | undefined
  for (const dimension of initializationDimensions) {
    const inserted = await tx.query(
      `INSERT INTO workflow_events (
         workflow_id, expected_version, workflow_version, dimension, event_kind,
         current_state, requested_target_state, trigger_code, triggering_event_id,
         actor_type, actor_id, preconditions, rule_version, decision_reason, side_effects,
         occurred_at, correlation_id, result, retained_for_replay
       ) VALUES ($1,0,0,$2,'initialized',$3,$3,'WORKFLOW_INITIALIZED',$4,$5,$6,$7::jsonb,NULL,$8,$9::jsonb,$10,$11,'success',false)
       RETURNING id`,
      [
        workflowId,
        dimension,
        snapshot[dimension],
        input.triggeringEventId,
        input.actorType,
        input.actorId,
        JSON.stringify({ application_campaign_bound: true }),
        WORKFLOW_BOOTSTRAP_REASON.INITIALIZED,
        JSON.stringify([]),
        input.occurredAt,
        input.correlationId,
      ],
    )
    const eventId = inserted.rows[0]?.id
    if (typeof eventId !== 'string') throw new Error('workflow initialization event insert returned no id')
    if (dimension === 'application') applicationEventId = eventId
  }

  await tx.query(
    `INSERT INTO audit_logs (
       occurred_at, actor_type, actor_id, action, target_type, target_id,
       result, reason, correlation_id, protected_action, detail
     ) VALUES ($1,$2,$3,'WORKFLOW_CREATED','workflow',$4,'success',$5,$6,'yes',$7::jsonb)`,
    [
      input.occurredAt,
      input.actorType,
      input.actorId,
      workflowId,
      WORKFLOW_BOOTSTRAP_REASON.INITIALIZED,
      input.correlationId,
      JSON.stringify({ application_id: input.applicationId, campaign_id: input.campaignId }),
    ],
  )
  if (applicationEventId === undefined) throw new Error('workflow application initialization event was not recorded')
  return applicationEventId
}

const findWorkflow = async (
  tx: DbTransaction,
  applicationId: string,
  campaignId: string,
): Promise<Readonly<{ workflowId: string; participantId: string }> | undefined> => {
  const selected = await tx.query(
    `SELECT id, participant_id
       FROM workflow_instances
      WHERE application_id = $1 AND campaign_id = $2
      FOR UPDATE`,
    [applicationId, campaignId],
  )
  const row = selected.rows[0]
  return row === undefined
    ? undefined
    : { workflowId: stringColumn(row, 'id'), participantId: stringColumn(row, 'participant_id') }
}

export const createParticipantForApplication = async (
  tx: DbTransaction,
  applicationId: string,
  occurredAt: Date,
): Promise<string> => {
  const inserted = await tx.query(
    `INSERT INTO participants (name, phone_normalized, blog_url, created_at, updated_at)
     SELECT applicant_name, phone_normalized, blog_url, $2, $2
       FROM applications
      WHERE id = $1
     RETURNING id`,
    [applicationId, occurredAt],
  )
  const row = inserted.rows[0]
  if (row === undefined) throw new WorkflowBootstrapError(WORKFLOW_BOOTSTRAP_REASON.APPLICATION_NOT_FOUND)
  return stringColumn(row, 'id')
}

export const createApplicationWorkflow = async (
  tx: DbTransaction,
  input: CreateApplicationWorkflowInput,
): Promise<WorkflowBootstrapResult> => {
  const source = await tx.query(
    `SELECT a.campaign_id, c.type, c.visit_method
       FROM applications a
       JOIN campaigns c ON c.id = a.campaign_id
      WHERE a.id = $1
      FOR SHARE`,
    [input.applicationId],
  )
  const sourceRow = source.rows[0]
  if (sourceRow === undefined) throw new WorkflowBootstrapError(WORKFLOW_BOOTSTRAP_REASON.APPLICATION_NOT_FOUND)
  if (stringColumn(sourceRow, 'campaign_id') !== input.campaignId) {
    throw new WorkflowBootstrapError(WORKFLOW_BOOTSTRAP_REASON.SCOPE_CONFLICT)
  }

  const baseSnapshot = initialWorkflowSnapshot({
    campaignType: campaignType(sourceRow.type),
    visitMethod: visitMethod(sourceRow.visit_method),
  })
  const snapshot: WorkflowSnapshot = {
    ...baseSnapshot,
    application: input.initialApplicationState ?? baseSnapshot.application,
  }
  const inserted = await tx.query(
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
      input.occurredAt,
    ],
  )
  const insertedId = inserted.rows[0]?.id
  const workflow = await findWorkflow(tx, input.applicationId, input.campaignId)
  if (workflow === undefined) throw new Error('workflow bootstrap insert was not visible')
  if (workflow.participantId !== input.participantId) {
    throw new WorkflowBootstrapError(WORKFLOW_BOOTSTRAP_REASON.SCOPE_CONFLICT)
  }

  const created = typeof insertedId === 'string'
  if (insertedId !== undefined && !created) throw new Error('workflow bootstrap insert returned an invalid id')
  if (created) {
    const applicationEventId = await appendInitializationEvidence(tx, input, workflow.workflowId, snapshot)
    if (snapshot.application === 'application_completed') {
      await tx.query(
        `INSERT INTO workflow_side_effects (
           workflow_id, workflow_event_id, dimension, effect_code, status, created_at, updated_at
         ) VALUES ($1,$2,'application',$3,'pending',$4,$4)`,
        [workflow.workflowId, applicationEventId, WORKFLOW_SIDE_EFFECT.BEGIN_IDENTITY_MATCHING, input.occurredAt],
      )
    }
  }

  return {
    workflowId: workflow.workflowId,
    participantId: workflow.participantId,
    applicationId: input.applicationId,
    campaignId: input.campaignId,
    created,
  }
}

export const bootstrapApplicationWorkflow = async (
  tx: DbTransaction,
  input: BootstrapApplicationWorkflowInput,
): Promise<WorkflowBootstrapResult> => {
  const application = await tx.query('SELECT campaign_id FROM applications WHERE id = $1 FOR UPDATE', [
    input.applicationId,
  ])
  const applicationRow = application.rows[0]
  if (applicationRow === undefined) {
    throw new WorkflowBootstrapError(WORKFLOW_BOOTSTRAP_REASON.APPLICATION_NOT_FOUND)
  }
  const campaignId = stringColumn(applicationRow, 'campaign_id')
  const existing = await findWorkflow(tx, input.applicationId, campaignId)
  if (existing !== undefined) {
    if (input.participantId !== undefined && existing.participantId !== input.participantId) {
      throw new WorkflowBootstrapError(WORKFLOW_BOOTSTRAP_REASON.SCOPE_CONFLICT)
    }
    return {
      workflowId: existing.workflowId,
      participantId: existing.participantId,
      applicationId: input.applicationId,
      campaignId,
      created: false,
    }
  }

  const participantId =
    input.participantId ?? (await createParticipantForApplication(tx, input.applicationId, input.occurredAt))
  return createApplicationWorkflow(tx, {
    ...input,
    participantId,
    campaignId,
    initialApplicationState: 'application_completed',
  })
}
