import type { MutableWorkflowDimension, WorkflowSnapshot, WorkflowStateByDimension } from './state-model.js'
import { isStateForDimension } from './state-model.js'

export type CampaignStatus = 'draft' | 'active' | 'paused' | 'closed'

export type WorkflowRecord = Readonly<{
  id: string
  participantId: string
  applicationId: string
  campaignId: string
  version: number
  campaignStatus: CampaignStatus
  snapshot: WorkflowSnapshot
  origins: Readonly<Record<MutableWorkflowDimension, Date>>
}>

export const WORKFLOW_DIMENSION_COLUMNS: Readonly<
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

export const stringColumn = (row: Record<string, unknown>, column: string): string => {
  const value = row[column]
  if (typeof value === 'string') return value
  throw new Error(`workflow query returned an invalid ${column}`)
}

export const nullableStringColumn = (row: Record<string, unknown>, column: string): string | null => {
  const value = row[column]
  if (value === null || typeof value === 'string') return value
  throw new Error(`workflow query returned an invalid ${column}`)
}

export const dateColumn = (row: Record<string, unknown>, column: string): Date => {
  const value = row[column]
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value
  throw new Error(`workflow query returned an invalid ${column}`)
}

export const integerColumn = (row: Record<string, unknown>, column: string): number => {
  const value = row[column]
  if (typeof value === 'number' && Number.isInteger(value)) return value
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

const campaignStatusColumn = (row: Record<string, unknown>): CampaignStatus => {
  const value = stringColumn(row, 'campaign_status')
  if (value === 'draft' || value === 'active' || value === 'paused' || value === 'closed') return value
  throw new Error('workflow query returned an unknown campaign_status')
}

export const workflowRecordFromRow = (row: Record<string, unknown>): WorkflowRecord => ({
  id: stringColumn(row, 'id'),
  participantId: stringColumn(row, 'participant_id'),
  applicationId: stringColumn(row, 'application_id'),
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

export const WORKFLOW_SELECT_COLUMNS = `
  w.id, w.participant_id, w.application_id, w.campaign_id, w.version,
  c.status AS campaign_status,
  w.application_state, w.selection_state, w.campaign_type, w.visit_method,
  w.secret_comment_state, w.payback_consent_state, w.business_approval_state,
  w.shipping_state, w.reservation_state, w.guideline_state,
  w.human_handoff_state, w.automation_mode_state,
  w.application_origin_at, w.selection_origin_at, w.secret_comment_origin_at,
  w.payback_consent_origin_at, w.business_approval_origin_at, w.shipping_origin_at,
  w.reservation_origin_at, w.guideline_origin_at, w.human_handoff_origin_at,
  w.automation_mode_origin_at`
