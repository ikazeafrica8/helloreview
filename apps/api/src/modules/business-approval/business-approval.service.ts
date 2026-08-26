import { Inject, Injectable } from '@nestjs/common'
import { POSTGRES_POOL, runInTransaction } from '@helloreview/db'
import type { Pool } from 'pg'
import { BusinessApprovalRepository, type CurrentBusinessApproval } from './business-approval.repository.js'
import { BUSINESS_APPROVAL_REASON } from './reason-codes.js'
import type { BusinessApprovalSource, BusinessApprovalState } from './visit-c-approval-gate.js'

export type RecordBusinessApprovalInput = Readonly<{
  workflowId: string
  campaignId: string
  applicationId: string
  state: Exclude<BusinessApprovalState, 'not_required'>
  source: BusinessApprovalSource
  approverReference: string
  scopeCode: string
  reasonCode: string
  issuedAt: Date | null
  expiresAt: Date | null
  recordedAt: Date
  /** Optional for legacy internal callers; admin commands always supply it. */
  expectedWorkflowVersion?: number
  correlationId?: string
}>

export type RecordedBusinessApproval = Readonly<{
  approval: CurrentBusinessApproval
  deduplicated: boolean
}>

export class BusinessApprovalError extends Error {
  override readonly name = 'BusinessApprovalError'
  constructor(readonly reasonCode: string) {
    super(`business approval rejected: ${reasonCode}`)
  }
}

const rowText = (row: Record<string, unknown>, column: string): string => {
  const value = row[column]
  if (typeof value === 'string') return value
  throw new Error(`business approval workflow query returned invalid ${column}`)
}

@Injectable()
export class BusinessApprovalService {
  constructor(
    @Inject(POSTGRES_POOL) private readonly pool: Pool,
    private readonly approvals: BusinessApprovalRepository,
  ) {}

  async record(input: RecordBusinessApprovalInput): Promise<RecordedBusinessApproval> {
    if (input.source === 'participant') {
      throw new BusinessApprovalError(BUSINESS_APPROVAL_REASON.APPROVAL_SOURCE_NOT_AUTHORIZED)
    }
    return runInTransaction(this.pool, async (tx) => {
      const workflowResult = await tx.query(
        `SELECT id, campaign_id, application_id, visit_method, version
           FROM workflow_instances WHERE id = $1 FOR UPDATE`,
        [input.workflowId],
      )
      const workflow = workflowResult.rows[0]
      if (workflow === undefined) throw new BusinessApprovalError('WORKFLOW_NOT_FOUND')
      if (
        rowText(workflow, 'campaign_id') !== input.campaignId ||
        rowText(workflow, 'application_id') !== input.applicationId ||
        rowText(workflow, 'visit_method') !== 'visit_c'
      )
        throw new BusinessApprovalError(BUSINESS_APPROVAL_REASON.APPROVAL_SCOPE_MISMATCH)
      if (input.expectedWorkflowVersion !== undefined && Number(workflow.version) !== input.expectedWorkflowVersion)
        throw new BusinessApprovalError('STALE_WORKFLOW_VERSION')

      const current = await this.approvals.current(tx, input.workflowId, true)
      if (
        current?.state === input.state &&
        current.source === input.source &&
        current.reasonCode === input.reasonCode &&
        current.expiresAt?.getTime() === input.expiresAt?.getTime()
      )
        return { approval: current, deduplicated: true }

      const version = (current?.version ?? 0) + 1
      const inserted = await tx.query(
        `INSERT INTO business_approvals (
           workflow_id, campaign_id, application_id, version, state, source,
           approver_reference, scope_code, reason_code, issued_at, expires_at, recorded_at, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)
         RETURNING id`,
        [
          input.workflowId,
          input.campaignId,
          input.applicationId,
          version,
          input.state,
          input.source,
          input.approverReference,
          input.scopeCode,
          input.reasonCode,
          input.issuedAt,
          input.expiresAt,
          input.recordedAt,
        ],
      )
      const approvalId = rowText(inserted.rows[0] ?? {}, 'id')
      await tx.query(
        `INSERT INTO audit_logs (
           occurred_at, actor_type, actor_id, action, target_type, target_id,
           result, reason, correlation_id, protected_action, detail
         ) VALUES ($1,$2,$3,'BUSINESS_APPROVAL_CHANGED','business_approval',$4,
                   'success',$5,$6,'yes',$7::jsonb)`,
        [
          input.recordedAt,
          input.source === 'authorized_operator' ? 'operator' : 'system',
          input.approverReference,
          approvalId,
          input.reasonCode,
          input.correlationId ?? null,
          JSON.stringify({
            workflowId: input.workflowId,
            campaignId: input.campaignId,
            applicationId: input.applicationId,
            version,
            state: input.state,
            scopeCode: input.scopeCode,
          }),
        ],
      )
      await tx.query(
        `INSERT INTO business_approval_heads (workflow_id, approval_id, updated_at)
         VALUES ($1,$2,$3)
         ON CONFLICT (workflow_id) DO UPDATE SET approval_id = EXCLUDED.approval_id, updated_at = EXCLUDED.updated_at`,
        [input.workflowId, approvalId, input.recordedAt],
      )
      await tx.query(
        `UPDATE workflow_instances
            SET business_approval_state = $2, business_approval_origin_at = $3,
                version = version + 1, updated_at = $3
          WHERE id = $1`,
        [input.workflowId, input.state, input.recordedAt],
      )
      if (input.state === 'expired' || input.state === 'revoked') {
        const priority = input.state === 'revoked' ? 'critical' : 'high'
        const reason = input.state === 'revoked' ? 'VISIT_C_APPROVAL_REVOKED' : 'VISIT_C_APPROVAL_EXPIRED'
        await tx.query(
          `INSERT INTO human_review_tasks (
             workflow_reference, reason_code, priority, status, case_packet,
             automation_paused, deduplication_key, created_at, updated_at
           ) VALUES ($1,$2,$3,'open',$4::jsonb,true,$5,$6,$6)
           ON CONFLICT (deduplication_key) DO NOTHING`,
          [
            input.workflowId,
            reason,
            priority,
            JSON.stringify({
              stateCode: input.state,
              summaryCode: reason,
              evidenceCodes: [`APPROVAL_VERSION_${String(version)}`],
              allowedActionCodes: ['RECONFIRM_APPROVAL', 'KEEP_AUTOMATION_PAUSED'],
              recommendationCode: 'REVIEW_VISIT_C_APPROVAL',
            }),
            `visit-c-approval:${approvalId}`,
            input.recordedAt,
          ],
        )
      }
      const approval = await this.approvals.current(tx, input.workflowId)
      if (approval === undefined) throw new Error('inserted business approval was not visible')
      return { approval, deduplicated: false }
    })
  }
}
