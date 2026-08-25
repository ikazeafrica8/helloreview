import { ATTACHMENT_REASON } from './reason-codes.js'

export type AttachmentRetentionDecision =
  | Readonly<{ allowed: true; reasonCode: typeof ATTACHMENT_REASON.DELETION_ELIGIBLE }>
  | Readonly<{
      allowed: false
      reasonCode: typeof ATTACHMENT_REASON.RETENTION_POLICY_MISSING | typeof ATTACHMENT_REASON.LEGAL_HOLD_ACTIVE
    }>

/** No configured policy means no deletion; legal hold always wins over an otherwise valid policy. */
export const evaluateAttachmentDeletion = (
  input: Readonly<{
    policyReference: string | null
    legalHoldActive: boolean
  }>,
): AttachmentRetentionDecision => {
  if (input.policyReference === null || input.policyReference.trim() === '') {
    return { allowed: false, reasonCode: ATTACHMENT_REASON.RETENTION_POLICY_MISSING }
  }
  if (input.legalHoldActive) return { allowed: false, reasonCode: ATTACHMENT_REASON.LEGAL_HOLD_ACTIVE }
  return { allowed: true, reasonCode: ATTACHMENT_REASON.DELETION_ELIGIBLE }
}
