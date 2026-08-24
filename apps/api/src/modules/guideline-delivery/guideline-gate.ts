import type { WorkflowSnapshot } from '../workflow-core/index.js'
import { GUIDELINE_BLOCK, type GuidelineBlockCode } from './reason-codes.js'

export type GuidelineCampaignRoute = 'shipping' | 'payback' | 'visit_a' | 'visit_b' | 'visit_c'

export type GuidelineReadinessSnapshot = Readonly<{
  workflow: WorkflowSnapshot
  campaign: Readonly<{
    route: GuidelineCampaignRoute
    status: 'draft' | 'active' | 'paused' | 'closed'
    startsAt: Date
    endsAt: Date | null
    activeGuidelineVersion: number | null
    activeTermsVersion: number | null
  }>
  consentTermsVersion: number | null
  businessApprovalExpiresAt: Date | null
  safeScreenshotReceived: boolean
  criticalFieldsExtracted: boolean
  shippingPrerequisitesSatisfied: boolean
  paybackPrerequisitesSatisfied: boolean
  deliveredGuidelineVersions: readonly number[]
}>

export type GuidelineGateResult =
  | Readonly<{ ready: true; reasonCode: typeof GUIDELINE_BLOCK.READY; guidelineVersion: number }>
  | Readonly<{
      ready: false
      reasonCode: Exclude<GuidelineBlockCode, typeof GUIDELINE_BLOCK.READY>
      observed: string
      expected: string
      correction: string
    }>

const blocked = (
  reasonCode: Exclude<GuidelineBlockCode, typeof GUIDELINE_BLOCK.READY>,
  observed: string,
  expected: string,
  correction: string,
): GuidelineGateResult => ({ ready: false, reasonCode, observed, expected, correction })

const selected = (state: WorkflowSnapshot['selection']): boolean =>
  state === 'auto_selected' || state === 'manually_selected'

/** PRD §16.9, universal checks first and then an exhaustive route switch. */
export const evaluateGuidelineReadiness = (snapshot: GuidelineReadinessSnapshot, now: Date): GuidelineGateResult => {
  const workflow = snapshot.workflow
  if (workflow.automation_mode !== 'active') {
    return blocked(GUIDELINE_BLOCK.AUTOMATION_PAUSED, workflow.automation_mode, 'active', 'WAIT_FOR_AUTOMATION_RESUME')
  }
  if (workflow.human_handoff === 'assigned' || workflow.human_handoff === 'in_progress') {
    return blocked(
      GUIDELINE_BLOCK.HUMAN_OWNERSHIP_ACTIVE,
      workflow.human_handoff,
      'not human owned',
      'WAIT_FOR_HUMAN_RELEASE',
    )
  }
  const campaignIsActive =
    snapshot.campaign.status === 'active' &&
    snapshot.campaign.startsAt.getTime() <= now.getTime() &&
    (snapshot.campaign.endsAt === null || snapshot.campaign.endsAt.getTime() > now.getTime())
  if (!campaignIsActive) {
    return blocked(
      GUIDELINE_BLOCK.CAMPAIGN_NOT_ACTIVE,
      snapshot.campaign.status,
      'active in current period',
      'CONTACT_OPERATOR',
    )
  }
  if (!selected(workflow.selection)) {
    return blocked(GUIDELINE_BLOCK.NOT_SELECTED, workflow.selection, 'selected', 'WAIT_FOR_SELECTION')
  }
  const activeVersion = snapshot.campaign.activeGuidelineVersion
  if (activeVersion === null) {
    return blocked(GUIDELINE_BLOCK.NO_ACTIVE_GUIDELINE_VERSION, 'none', 'active version', 'CONTACT_OPERATOR')
  }
  if (snapshot.deliveredGuidelineVersions.includes(activeVersion)) {
    return blocked(
      GUIDELINE_BLOCK.VERSION_ALREADY_DELIVERED,
      String(activeVersion),
      'undelivered active version',
      'SUPPRESS_DUPLICATE',
    )
  }

  switch (snapshot.campaign.route) {
    case 'shipping':
      if (workflow.shipping !== 'address_valid') {
        return blocked(
          GUIDELINE_BLOCK.SHIPPING_ADDRESS_NOT_VALID,
          workflow.shipping,
          'address_valid',
          'CORRECT_SHIPPING_ADDRESS',
        )
      }
      return snapshot.shippingPrerequisitesSatisfied
        ? { ready: true, reasonCode: GUIDELINE_BLOCK.READY, guidelineVersion: activeVersion }
        : blocked(GUIDELINE_BLOCK.SHIPPING_PREREQUISITES_NOT_MET, 'false', 'true', 'COMPLETE_SHIPPING_PREREQUISITES')
    case 'payback':
      if (
        workflow.payback_consent !== 'agreed' ||
        snapshot.consentTermsVersion !== snapshot.campaign.activeTermsVersion
      ) {
        return blocked(
          GUIDELINE_BLOCK.CONSENT_NOT_CURRENT,
          workflow.payback_consent,
          'agreed to active terms',
          'AGREE_TO_CURRENT_TERMS',
        )
      }
      return snapshot.paybackPrerequisitesSatisfied
        ? { ready: true, reasonCode: GUIDELINE_BLOCK.READY, guidelineVersion: activeVersion }
        : blocked(GUIDELINE_BLOCK.PAYBACK_PREREQUISITES_NOT_MET, 'false', 'true', 'COMPLETE_PAYBACK_PREREQUISITES')
    case 'visit_a':
      return workflow.reservation === 'valid'
        ? { ready: true, reasonCode: GUIDELINE_BLOCK.READY, guidelineVersion: activeVersion }
        : blocked(GUIDELINE_BLOCK.RESERVATION_NOT_VALID, workflow.reservation, 'valid', 'CORRECT_RESERVATION')
    case 'visit_b':
      if (!snapshot.safeScreenshotReceived) {
        return blocked(GUIDELINE_BLOCK.SCREENSHOT_NOT_SAFE, 'false', 'true', 'UPLOAD_SAFE_SCREENSHOT')
      }
      if (!snapshot.criticalFieldsExtracted) {
        return blocked(GUIDELINE_BLOCK.CRITICAL_FIELDS_NOT_EXTRACTED, 'false', 'true', 'REVIEW_SCREENSHOT_FIELDS')
      }
      return workflow.reservation === 'valid'
        ? { ready: true, reasonCode: GUIDELINE_BLOCK.READY, guidelineVersion: activeVersion }
        : blocked(GUIDELINE_BLOCK.RESERVATION_NOT_VALID, workflow.reservation, 'valid', 'CORRECT_RESERVATION')
    case 'visit_c':
      if (workflow.business_approval !== 'approved') {
        return blocked(
          GUIDELINE_BLOCK.BUSINESS_APPROVAL_NOT_CURRENT,
          workflow.business_approval,
          'approved',
          'WAIT_FOR_BUSINESS_APPROVAL',
        )
      }
      if (
        snapshot.businessApprovalExpiresAt !== null &&
        snapshot.businessApprovalExpiresAt.getTime() <= now.getTime()
      ) {
        return blocked(
          GUIDELINE_BLOCK.BUSINESS_APPROVAL_EXPIRED,
          snapshot.businessApprovalExpiresAt.toISOString(),
          'unexpired approval',
          'RENEW_BUSINESS_APPROVAL',
        )
      }
      if (!snapshot.safeScreenshotReceived) {
        return blocked(GUIDELINE_BLOCK.SCREENSHOT_NOT_SAFE, 'false', 'true', 'UPLOAD_SAFE_SCREENSHOT')
      }
      if (!snapshot.criticalFieldsExtracted) {
        return blocked(GUIDELINE_BLOCK.CRITICAL_FIELDS_NOT_EXTRACTED, 'false', 'true', 'REVIEW_SCREENSHOT_FIELDS')
      }
      return workflow.reservation === 'valid'
        ? { ready: true, reasonCode: GUIDELINE_BLOCK.READY, guidelineVersion: activeVersion }
        : blocked(GUIDELINE_BLOCK.RESERVATION_NOT_VALID, workflow.reservation, 'valid', 'CORRECT_RESERVATION')
  }
}
