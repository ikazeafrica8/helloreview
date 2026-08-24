import { Inject, Injectable } from '@nestjs/common'
import { POSTGRES_POOL, runInTransaction } from '@helloreview/db'
import type { Pool } from 'pg'

export const GUIDELINE_INCIDENT_REASON = {
  PREMATURE_GUIDELINE_DELIVERY: 'PREMATURE_GUIDELINE_DELIVERY',
  POST_DELIVERY_RESERVATION_CANCELLED: 'POST_DELIVERY_RESERVATION_CANCELLED',
  POST_DELIVERY_APPROVAL_REVOKED: 'POST_DELIVERY_APPROVAL_REVOKED',
} as const

export type GuidelineAuditResult = Readonly<{
  inspected: number
  incidentsCreated: number
  reviewTasksCreated: number
}>

const text = (row: Record<string, unknown>, column: string): string => {
  const value = row[column]
  if (typeof value === 'string') return value
  throw new Error(`guideline audit query returned invalid ${column}`)
}

const ruleWasReady = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null || !('ready' in value)) return false
  const carrier: Record<string, unknown> = { ...value }
  return carrier.ready === true
}

@Injectable()
export class GuidelineIncidentAuditorService {
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  async auditBatch(now: Date, limit = 100): Promise<GuidelineAuditResult> {
    return runInTransaction(this.pool, async (tx) => {
      const candidates = await tx.query(
        `SELECT d.id, d.workflow_id, d.campaign_id, d.guideline_version, d.rule_result,
                w.reservation_state, w.business_approval_state,
                n.status AS provider_status, n.provider_message_id, n.delivered_at
           FROM guideline_deliveries d
           JOIN workflow_instances w ON w.id = d.workflow_id
           JOIN outbound_notifications n ON n.id = d.outbound_notification_id
          WHERE d.status = 'delivered' OR n.status = 'delivered'
          ORDER BY d.updated_at, d.id
          FOR UPDATE OF d SKIP LOCKED
          LIMIT $1`,
        [limit],
      )
      let incidentsCreated = 0
      let reviewTasksCreated = 0
      for (const row of candidates.rows) {
        const deliveryId = text(row, 'id')
        const workflowId = text(row, 'workflow_id')
        const campaignId = text(row, 'campaign_id')
        await tx.query(
          `UPDATE guideline_deliveries
              SET status = 'delivered', delivered_at = coalesce(delivered_at, $2),
                  provider_result = $3::jsonb, updated_at = $2
            WHERE id = $1`,
          [
            deliveryId,
            row.delivered_at instanceof Date ? row.delivered_at : now,
            JSON.stringify({ status: row.provider_status, providerMessageId: row.provider_message_id }),
          ],
        )

        if (!ruleWasReady(row.rule_result)) {
          const incident = await tx.query(
            `INSERT INTO guideline_delivery_incidents (
               delivery_id, workflow_id, campaign_id, severity, status,
               reason_code, state_snapshot, created_at
             ) VALUES ($1,$2,$3,'critical','open',$4,$5::jsonb,$6)
             ON CONFLICT (delivery_id, reason_code) DO NOTHING RETURNING id`,
            [
              deliveryId,
              workflowId,
              campaignId,
              GUIDELINE_INCIDENT_REASON.PREMATURE_GUIDELINE_DELIVERY,
              JSON.stringify({
                reservationState: row.reservation_state,
                businessApprovalState: row.business_approval_state,
                guidelineVersion: row.guideline_version,
              }),
              now,
            ],
          )
          if (incident.rows.length > 0) incidentsCreated += 1
          await tx.query(
            `INSERT INTO automation_pauses (
               scope, kind, campaign_id, workflow_type, participant_id, reason_code,
               activated_by_type, activated_by_id, activated_at, created_at, updated_at
             ) VALUES ('campaign','standard',$1,NULL,NULL,$2,'system','guideline-auditor',$3,$3,$3)
             ON CONFLICT DO NOTHING`,
            [campaignId, GUIDELINE_INCIDENT_REASON.PREMATURE_GUIDELINE_DELIVERY, now],
          )
        }

        const postDeliveryReason =
          row.business_approval_state === 'revoked'
            ? GUIDELINE_INCIDENT_REASON.POST_DELIVERY_APPROVAL_REVOKED
            : row.reservation_state === 'cancelled'
              ? GUIDELINE_INCIDENT_REASON.POST_DELIVERY_RESERVATION_CANCELLED
              : undefined
        if (postDeliveryReason !== undefined) {
          const history = await tx.query(
            `SELECT state, version, recorded_at FROM business_approvals
              WHERE workflow_id = $1 ORDER BY version`,
            [workflowId],
          )
          const task = await tx.query(
            `INSERT INTO human_review_tasks (
               workflow_reference, reason_code, priority, status, case_packet,
               automation_paused, deduplication_key, created_at, updated_at
             ) VALUES ($1,'GUIDELINE_MAY_HAVE_BEEN_SENT_PREMATURELY','critical','open',$2::jsonb,true,$3,$4,$4)
             ON CONFLICT (deduplication_key) DO NOTHING RETURNING id`,
            [
              workflowId,
              JSON.stringify({
                stateCode: postDeliveryReason,
                summaryCode: 'GUIDELINE_MAY_HAVE_BEEN_SENT_PREMATURELY',
                evidenceCodes: [`GUIDELINE_VERSION_${String(row.guideline_version)}`, `DELIVERY_${deliveryId}`],
                allowedActionCodes: ['REVIEW_DELIVERY_HISTORY', 'KEEP_AUTOMATION_PAUSED'],
                recommendationCode: 'REVIEW_POST_DELIVERY_STATE_CHANGE',
                stateHistory: {
                  reservationState: row.reservation_state,
                  businessApprovalState: row.business_approval_state,
                },
                deliveryHistory: {
                  deliveryId,
                  guidelineVersion: row.guideline_version,
                  providerStatus: row.provider_status,
                  providerMessageId: row.provider_message_id,
                },
                approvalHistory: history.rows,
              }),
              `guideline-post-delivery:${deliveryId}:${postDeliveryReason}`,
              now,
            ],
          )
          if (task.rows.length > 0) reviewTasksCreated += 1
        }
      }
      return { inspected: candidates.rows.length, incidentsCreated, reviewTasksCreated }
    })
  }
}
