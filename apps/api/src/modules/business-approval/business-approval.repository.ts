import { Injectable } from '@nestjs/common'
import type { DbTransaction } from '@helloreview/db'
import type { BusinessApprovalSource, BusinessApprovalState, VisitCApprovalSnapshot } from './visit-c-approval-gate.js'

export type CurrentBusinessApproval = Readonly<{
  id: string
  workflowId: string
  campaignId: string
  applicationId: string
  version: number
  state: BusinessApprovalState
  source: Exclude<BusinessApprovalSource, 'participant'>
  approverReference: string
  scopeCode: string
  reasonCode: string
  issuedAt: Date | null
  expiresAt: Date | null
  recordedAt: Date
}>

const text = (row: Record<string, unknown>, column: string): string => {
  const value = row[column]
  if (typeof value === 'string') return value
  throw new Error(`business approval query returned invalid ${column}`)
}

const date = (row: Record<string, unknown>, column: string): Date | null => {
  const value = row[column]
  if (value === null) return null
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value
  throw new Error(`business approval query returned invalid ${column}`)
}

const state = (value: unknown): BusinessApprovalState => {
  if (
    value === 'not_required' ||
    value === 'not_requested' ||
    value === 'pending' ||
    value === 'approved' ||
    value === 'rejected' ||
    value === 'expired' ||
    value === 'revoked' ||
    value === 'human_review_required'
  )
    return value
  throw new Error('business approval query returned invalid state')
}

const source = (value: unknown): Exclude<BusinessApprovalSource, 'participant'> => {
  if (value === 'authorized_operator' || value === 'authorized_system') return value
  throw new Error('business approval query returned invalid source')
}

const fromRow = (row: Record<string, unknown>): CurrentBusinessApproval => ({
  id: text(row, 'id'),
  workflowId: text(row, 'workflow_id'),
  campaignId: text(row, 'campaign_id'),
  applicationId: text(row, 'application_id'),
  version: Number(row.version),
  state: state(row.state),
  source: source(row.source),
  approverReference: text(row, 'approver_reference'),
  scopeCode: text(row, 'scope_code'),
  reasonCode: text(row, 'reason_code'),
  issuedAt: date(row, 'issued_at'),
  expiresAt: date(row, 'expires_at'),
  recordedAt:
    date(row, 'recorded_at') ??
    (() => {
      throw new Error('business approval recorded_at cannot be null')
    })(),
})

@Injectable()
export class BusinessApprovalRepository {
  async current(tx: DbTransaction, workflowId: string, lock = false): Promise<CurrentBusinessApproval | undefined> {
    const result = await tx.query(
      `SELECT a.id, a.workflow_id, a.campaign_id, a.application_id, a.version, a.state,
              a.source, a.approver_reference, a.scope_code, a.reason_code,
              a.issued_at, a.expires_at, a.recorded_at
         FROM business_approval_heads h
         JOIN business_approvals a ON a.id = h.approval_id AND a.workflow_id = h.workflow_id
        WHERE h.workflow_id = $1${lock ? ' FOR UPDATE OF h' : ''}`,
      [workflowId],
    )
    const row = result.rows[0]
    return row === undefined ? undefined : fromRow(row)
  }

  async history(tx: DbTransaction, workflowId: string): Promise<readonly CurrentBusinessApproval[]> {
    const result = await tx.query(
      `SELECT id, workflow_id, campaign_id, application_id, version, state, source,
              approver_reference, scope_code, reason_code, issued_at, expires_at, recorded_at
         FROM business_approvals WHERE workflow_id = $1 ORDER BY version`,
      [workflowId],
    )
    return result.rows.map(fromRow)
  }

  gateSnapshot(
    approval: CurrentBusinessApproval | undefined,
    scope: Readonly<{ campaignId: string; applicationId: string }>,
  ): VisitCApprovalSnapshot {
    return approval === undefined
      ? {
          state: 'not_requested',
          source: 'authorized_system',
          isCurrentVersion: true,
          scopeMatches: true,
          expiresAt: null,
        }
      : {
          state: approval.state,
          source: approval.source,
          isCurrentVersion: true,
          scopeMatches: approval.campaignId === scope.campaignId && approval.applicationId === scope.applicationId,
          expiresAt: approval.expiresAt,
        }
  }
}
