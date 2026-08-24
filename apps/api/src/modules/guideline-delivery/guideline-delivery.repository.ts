import { Injectable } from '@nestjs/common'
import type { DbTransaction } from '@helloreview/db'
import { isStateForDimension, type WorkflowSnapshot } from '../workflow-core/index.js'
import type { GuidelineCampaignRoute, GuidelineReadinessSnapshot } from './guideline-gate.js'

export type GuidelineDeliveryContext = Readonly<{
  workflowId: string
  participantId: string
  applicationId: string
  campaignId: string
  guidelineVersionId: string | null
  guidelineBody: string | null
  readiness: GuidelineReadinessSnapshot
}>

const text = (row: Record<string, unknown>, column: string): string => {
  const value = row[column]
  if (typeof value === 'string') return value
  throw new Error(`guideline readiness query returned invalid ${column}`)
}

const nullableText = (row: Record<string, unknown>, column: string): string | null => {
  const value = row[column]
  if (value === null || typeof value === 'string') return value
  throw new Error(`guideline readiness query returned invalid ${column}`)
}

const date = (row: Record<string, unknown>, column: string): Date => {
  const value = row[column]
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value
  throw new Error(`guideline readiness query returned invalid ${column}`)
}

const nullableDate = (row: Record<string, unknown>, column: string): Date | null => {
  const value = row[column]
  return value === null ? null : date(row, column)
}

const state = <Dimension extends keyof WorkflowSnapshot>(
  row: Record<string, unknown>,
  column: string,
  dimension: Dimension,
): WorkflowSnapshot[Dimension] => {
  const value = text(row, column)
  if (isStateForDimension(dimension, value)) return value
  throw new Error(`guideline readiness query returned unknown ${column}`)
}

const campaignRoute = (row: Record<string, unknown>): GuidelineCampaignRoute => {
  const type = text(row, 'campaign_type')
  const visitMethod = text(row, 'visit_method')
  if (type === 'shipping') return 'shipping'
  if (type === 'payback') return 'payback'
  if (type === 'visit' && (visitMethod === 'visit_a' || visitMethod === 'visit_b' || visitMethod === 'visit_c')) {
    return visitMethod
  }
  throw new Error('guideline readiness query returned incoherent campaign route')
}

const campaignStatus = (value: unknown): 'draft' | 'active' | 'paused' | 'closed' => {
  if (value === 'draft' || value === 'active' || value === 'paused' || value === 'closed') return value
  throw new Error('guideline readiness query returned invalid campaign status')
}

const deliveredVersions = (value: unknown): readonly number[] => {
  if (!Array.isArray(value)) throw new Error('guideline readiness query returned invalid delivered versions')
  const parsed = value.map(Number)
  if (!parsed.every(Number.isInteger)) throw new Error('guideline readiness query returned invalid delivery version')
  return parsed
}

@Injectable()
export class GuidelineDeliveryRepository {
  async readiness(
    tx: DbTransaction,
    input: Readonly<{
      workflowId: string
      now: Date
      consentTermsVersion: number | null
      activeTermsVersion: number | null
      safeScreenshotReceived: boolean
      criticalFieldsExtracted: boolean
      shippingPrerequisitesSatisfied: boolean
      paybackPrerequisitesSatisfied: boolean
    }>,
  ): Promise<GuidelineDeliveryContext | undefined> {
    const result = await tx.query(
      `SELECT w.id, w.participant_id, w.application_id, w.campaign_id,
              w.application_state, w.selection_state, w.campaign_type, w.visit_method,
              w.secret_comment_state, w.payback_consent_state, w.business_approval_state,
              w.shipping_state, w.reservation_state, w.guideline_state,
              w.human_handoff_state, w.automation_mode_state,
              c.status AS campaign_status, c.starts_at, c.ends_at,
              g.id AS guideline_version_id, g.version AS guideline_version,
              coalesce(g.body_text, g.content_uri) AS guideline_body,
              a.expires_at AS approval_expires_at,
              EXISTS (
                SELECT 1 FROM automation_pauses p
                 WHERE p.deactivated_at IS NULL AND (
                   p.scope = 'global'
                   OR (p.scope = 'campaign' AND p.campaign_id = w.campaign_id)
                   OR (p.scope = 'workflow_type' AND p.workflow_type = w.campaign_type)
                   OR (p.scope = 'participant' AND p.participant_id = w.participant_id)
                 )
              ) AS active_pause,
              EXISTS (
                SELECT 1 FROM operator_assignments o
                 WHERE o.workflow_id = w.id AND o.ended_at IS NULL
              ) AS human_owned,
              coalesce((
                SELECT jsonb_agg(d.guideline_version ORDER BY d.guideline_version)
                  FROM guideline_deliveries d WHERE d.workflow_id = w.id
              ), '[]'::jsonb) AS delivered_versions
         FROM workflow_instances w
         JOIN campaigns c ON c.id = w.campaign_id
         LEFT JOIN LATERAL (
           SELECT id, version, body_text, content_uri
             FROM guideline_versions
            WHERE campaign_id = w.campaign_id
              AND status = 'published'
              AND effective_from <= $2
              AND (effective_to IS NULL OR effective_to > $2)
            ORDER BY effective_from DESC, version DESC LIMIT 1
         ) g ON true
         LEFT JOIN business_approval_heads ah ON ah.workflow_id = w.id
         LEFT JOIN business_approvals a ON a.id = ah.approval_id AND a.workflow_id = w.id
        WHERE w.id = $1
        FOR UPDATE OF w`,
      [input.workflowId, input.now],
    )
    const row = result.rows[0]
    if (row === undefined) return undefined

    const baseAutomation = state(row, 'automation_mode_state', 'automation_mode')
    const baseHandoff = state(row, 'human_handoff_state', 'human_handoff')
    const workflow: WorkflowSnapshot = {
      application: state(row, 'application_state', 'application'),
      selection: state(row, 'selection_state', 'selection'),
      campaign_type: state(row, 'campaign_type', 'campaign_type'),
      visit_method: state(row, 'visit_method', 'visit_method'),
      secret_comment: state(row, 'secret_comment_state', 'secret_comment'),
      payback_consent: state(row, 'payback_consent_state', 'payback_consent'),
      business_approval: state(row, 'business_approval_state', 'business_approval'),
      shipping: state(row, 'shipping_state', 'shipping'),
      reservation: state(row, 'reservation_state', 'reservation'),
      guideline: state(row, 'guideline_state', 'guideline'),
      human_handoff: row.human_owned === true ? 'in_progress' : baseHandoff,
      automation_mode: row.active_pause === true ? 'campaign_paused' : baseAutomation,
    }
    const guidelineVersion = row.guideline_version === null ? null : Number(row.guideline_version)
    if (guidelineVersion !== null && !Number.isInteger(guidelineVersion)) {
      throw new Error('guideline readiness query returned invalid guideline version')
    }
    return {
      workflowId: text(row, 'id'),
      participantId: text(row, 'participant_id'),
      applicationId: text(row, 'application_id'),
      campaignId: text(row, 'campaign_id'),
      guidelineVersionId: nullableText(row, 'guideline_version_id'),
      guidelineBody: nullableText(row, 'guideline_body'),
      readiness: {
        workflow,
        campaign: {
          route: campaignRoute(row),
          status: campaignStatus(row.campaign_status),
          startsAt: date(row, 'starts_at'),
          endsAt: nullableDate(row, 'ends_at'),
          activeGuidelineVersion: guidelineVersion,
          activeTermsVersion: input.activeTermsVersion,
        },
        consentTermsVersion: input.consentTermsVersion,
        businessApprovalExpiresAt: nullableDate(row, 'approval_expires_at'),
        safeScreenshotReceived: input.safeScreenshotReceived,
        criticalFieldsExtracted: input.criticalFieldsExtracted,
        shippingPrerequisitesSatisfied: input.shippingPrerequisitesSatisfied,
        paybackPrerequisitesSatisfied: input.paybackPrerequisitesSatisfied,
        deliveredGuidelineVersions: deliveredVersions(row.delivered_versions),
      },
    }
  }
}
