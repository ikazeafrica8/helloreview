import { BUSINESS_APPROVAL_REASON, type BusinessApprovalReasonCode } from './reason-codes.js'

export type BusinessApprovalState =
  | 'not_required'
  | 'not_requested'
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'revoked'
  | 'human_review_required'

export type BusinessApprovalSource = 'authorized_operator' | 'authorized_system' | 'participant'

export type VisitCApprovalSnapshot = Readonly<{
  state: BusinessApprovalState
  source: BusinessApprovalSource
  isCurrentVersion: boolean
  scopeMatches: boolean
  expiresAt: Date | null
}>

export type VisitCApprovalGateResult =
  | Readonly<{ allowed: true; reasonCode: typeof BUSINESS_APPROVAL_REASON.APPROVED_CURRENT }>
  | Readonly<{
      allowed: false
      reasonCode: Exclude<BusinessApprovalReasonCode, typeof BUSINESS_APPROVAL_REASON.APPROVED_CURRENT>
      participantAction: 'send_approval_pending' | 'send_approved_explanation' | 'no_automated_message'
      createHumanTask: boolean
      taskPriority: 'high' | 'critical' | null
      pauseProgression: boolean
    }>

const blocked = (
  reasonCode: Exclude<BusinessApprovalReasonCode, typeof BUSINESS_APPROVAL_REASON.APPROVED_CURRENT>,
  participantAction: VisitCApprovalGateResult extends infer Result
    ? Result extends Readonly<{ allowed: false; participantAction: infer Action }>
      ? Action
      : never
    : never,
  createHumanTask = false,
  taskPriority: 'high' | 'critical' | null = null,
  pauseProgression = true,
): VisitCApprovalGateResult => ({
  allowed: false,
  reasonCode,
  participantAction,
  createHumanTask,
  taskPriority,
  pauseProgression,
})

/** PRD §16.6 hard gate. All approval facts and the clock are explicit inputs. */
export const evaluateVisitCApprovalGate = (approval: VisitCApprovalSnapshot, now: Date): VisitCApprovalGateResult => {
  if (approval.source === 'participant') {
    return blocked(BUSINESS_APPROVAL_REASON.APPROVAL_SOURCE_NOT_AUTHORIZED, 'no_automated_message', true, 'critical')
  }
  if (!approval.scopeMatches) {
    return blocked(BUSINESS_APPROVAL_REASON.APPROVAL_SCOPE_MISMATCH, 'no_automated_message', true, 'critical')
  }
  if (!approval.isCurrentVersion) {
    return blocked(BUSINESS_APPROVAL_REASON.APPROVAL_VERSION_NOT_CURRENT, 'no_automated_message', true, 'high')
  }

  switch (approval.state) {
    case 'not_required':
      return blocked(
        BUSINESS_APPROVAL_REASON.APPROVAL_NOT_REQUIRED_INVALID_FOR_VISIT_C,
        'no_automated_message',
        true,
        'high',
      )
    case 'not_requested':
      return blocked(BUSINESS_APPROVAL_REASON.APPROVAL_NOT_REQUESTED, 'send_approval_pending')
    case 'pending':
      return blocked(BUSINESS_APPROVAL_REASON.APPROVAL_PENDING, 'send_approval_pending')
    case 'rejected':
      return blocked(BUSINESS_APPROVAL_REASON.APPROVAL_REJECTED, 'send_approved_explanation', true, 'high')
    case 'expired':
      return blocked(BUSINESS_APPROVAL_REASON.APPROVAL_EXPIRED, 'send_approved_explanation', true, 'high')
    case 'revoked':
      return blocked(BUSINESS_APPROVAL_REASON.APPROVAL_REVOKED, 'no_automated_message', true, 'critical')
    case 'human_review_required':
      return blocked(BUSINESS_APPROVAL_REASON.APPROVAL_HUMAN_REVIEW_REQUIRED, 'send_approved_explanation', true, 'high')
    case 'approved':
      if (approval.expiresAt !== null && approval.expiresAt.getTime() <= now.getTime()) {
        return blocked(BUSINESS_APPROVAL_REASON.APPROVAL_EXPIRED, 'send_approved_explanation', true, 'high')
      }
      return { allowed: true, reasonCode: BUSINESS_APPROVAL_REASON.APPROVED_CURRENT }
  }
}
