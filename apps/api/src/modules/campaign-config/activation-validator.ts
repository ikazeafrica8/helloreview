import { MESSAGE_PURPOSES, purposeStem, type MessagePurpose } from '@helloreview/contracts'
import { CAMPAIGN_CONFIG_REASON, type CampaignConfigReasonCode } from './reason-codes.js'

export type CampaignType = 'shipping' | 'payback' | 'visit'
export type VisitMethod = 'not_applicable' | 'visit_a' | 'visit_b' | 'visit_c'
export type CampaignRoute = 'shipping' | 'payback' | 'visit_a' | 'visit_b' | 'visit_c'
export type CampaignRuleType = 'selection' | 'reservation' | 'guideline' | 'payback' | 'shipping'

/**
 * One published sender-ownership decision, as read from `message_purpose_ownership`.
 *
 * `triggerAudited` is separate from the sender on purpose. A campaign may legitimately activate with
 * the website legacy trigger owning a purpose — that is the cutover state — but it may not activate
 * claiming THIS platform owns a purpose whose legacy trigger nobody has looked for.
 */
export type CampaignPurposeOwnership = Readonly<{
  purposeStem: string
  authoritativeSender: 'website_legacy_trigger' | 'helloreview_platform' | 'operator_manual'
  triggerAudited: boolean
}>

export type CampaignActivationSnapshot = Readonly<{
  campaignType: CampaignType
  visitMethod: VisitMethod
  /** Open-ended published versions, not drafts or historical superseded versions. */
  publishedRuleTypes: readonly CampaignRuleType[]
  /** Windows belonging to the current published reservation-rule version. */
  reservationWindowCount: number
  /** Full template purpose codes whose status is `active`. */
  activeTemplatePurposeCodes: readonly string[]
  /** One open-ended published guideline version exists for the campaign. */
  hasPublishedGuidelineVersion: boolean
  /**
   * The current published journey configuration carries an application URL (T136).
   *
   * Required for EVERY route, not only the secret-comment one: PRD §14.5 puts "Campaign application
   * URL exists" on the Application dimension, which every campaign type has, and a participant who
   * has not applied can reach any campaign.
   */
  hasCurrentApplicationUrl: boolean
  /** The current published business version carries a phone (Visit A) and booking URL (Visit B/C). */
  hasCurrentBusinessPhone: boolean
  hasCurrentBookingUrl: boolean
  /** Published ownership rows for this campaign, one per purpose stem. */
  purposeOwnerships: readonly CampaignPurposeOwnership[]
  /** The current published selection rule configuration parses (T136). */
  hasValidSelectionPolicy: boolean
}>

export type CampaignActivationRequirement =
  | 'route'
  | 'rule'
  | 'reservation_windows'
  | 'template'
  | 'guideline'
  | 'journey_configuration'
  | 'business_contact'
  | 'sender_ownership'
  | 'selection_policy'

export type CampaignActivationIssue = Readonly<{
  reasonCode: CampaignConfigReasonCode
  requirement: CampaignActivationRequirement
  /** Stable machine-readable name of the missing/invalid item. */
  item: string
}>

export type CampaignActivationResult = Readonly<{
  canActivate: boolean
  route: CampaignRoute | null
  /** Every issue in deterministic policy order; never only the first failure. */
  issues: readonly CampaignActivationIssue[]
}>

const COMMON_RULES: readonly CampaignRuleType[] = ['selection', 'guideline']

const ROUTE_RULES: Readonly<Record<CampaignRoute, readonly CampaignRuleType[]>> = {
  shipping: ['shipping'],
  payback: ['payback'],
  visit_a: ['reservation'],
  visit_b: ['reservation'],
  visit_c: ['reservation'],
}

/**
 * Minimum participant-facing templates needed to enter each route safely.
 *
 * Selection outcome and guideline delivery are universal. Each route then adds the first message
 * that can advance that route. Visit C needs both the pending-status wording and the separately
 * gated booking instructions; combining them is the exact failure AC-01 is designed to catch.
 */
const COMMON_TEMPLATES: readonly MessagePurpose[] = [
  // T136 added APPLICATION_REQUEST: it is the message that carries the application URL, and no
  // campaign can start a participant who has not applied without it.
  MESSAGE_PURPOSES.APPLICATION_REQUEST,
  MESSAGE_PURPOSES.SELECTION_RESULT,
  MESSAGE_PURPOSES.GUIDELINE_DELIVERY,
]

const ROUTE_TEMPLATES: Readonly<Record<CampaignRoute, readonly MessagePurpose[]>> = {
  shipping: [MESSAGE_PURPOSES.SHIPPING_ADDRESS_REQUEST],
  payback: [MESSAGE_PURPOSES.PAYBACK_CONSENT_REQUEST, MESSAGE_PURPOSES.PAYBACK_CONSENT_CLARIFICATION],
  visit_a: [MESSAGE_PURPOSES.VISIT_A_INSTRUCTIONS],
  visit_b: [MESSAGE_PURPOSES.VISIT_B_INSTRUCTIONS],
  visit_c: [MESSAGE_PURPOSES.VISIT_C_APPROVAL_STATUS, MESSAGE_PURPOSES.VISIT_C_BOOKING_INSTRUCTIONS],
}

const issue = (
  reasonCode: CampaignConfigReasonCode,
  requirement: CampaignActivationRequirement,
  item: string,
): CampaignActivationIssue => ({ reasonCode, requirement, item })

const campaignRoute = (
  campaignType: CampaignType,
  visitMethod: VisitMethod,
): Readonly<{ route: CampaignRoute | null; issue: CampaignActivationIssue | null }> => {
  switch (campaignType) {
    case 'shipping':
      return visitMethod === 'not_applicable'
        ? { route: 'shipping', issue: null }
        : {
            route: null,
            issue: issue(CAMPAIGN_CONFIG_REASON.INVALID_CAMPAIGN_ROUTE, 'route', `shipping:${visitMethod}`),
          }
    case 'payback':
      return visitMethod === 'not_applicable'
        ? { route: 'payback', issue: null }
        : {
            route: null,
            issue: issue(CAMPAIGN_CONFIG_REASON.INVALID_CAMPAIGN_ROUTE, 'route', `payback:${visitMethod}`),
          }
    case 'visit':
      switch (visitMethod) {
        case 'visit_a':
          return { route: 'visit_a', issue: null }
        case 'visit_b':
          return { route: 'visit_b', issue: null }
        case 'visit_c':
          return { route: 'visit_c', issue: null }
        case 'not_applicable':
          return {
            route: null,
            issue: issue(CAMPAIGN_CONFIG_REASON.INVALID_CAMPAIGN_ROUTE, 'route', 'visit:not_applicable'),
          }
      }
  }
}

/** Validate every activation prerequisite without I/O or an ambient clock (FR-CAM-006, T25). */
export const validateCampaignActivation = (snapshot: CampaignActivationSnapshot): CampaignActivationResult => {
  const routing = campaignRoute(snapshot.campaignType, snapshot.visitMethod)
  const issues: CampaignActivationIssue[] = []
  if (routing.issue !== null) issues.push(routing.issue)

  const requiredRules = [...COMMON_RULES, ...(routing.route === null ? [] : ROUTE_RULES[routing.route])]
  const publishedRules = new Set<CampaignRuleType>(snapshot.publishedRuleTypes)
  for (const ruleType of requiredRules) {
    if (!publishedRules.has(ruleType)) {
      issues.push(issue(CAMPAIGN_CONFIG_REASON.MISSING_RULE_VERSION, 'rule', ruleType))
    }
  }

  if (
    routing.route !== null &&
    (routing.route === 'visit_a' || routing.route === 'visit_b' || routing.route === 'visit_c') &&
    snapshot.reservationWindowCount < 1
  ) {
    issues.push(issue(CAMPAIGN_CONFIG_REASON.MISSING_RESERVATION_WINDOWS, 'reservation_windows', 'reservation_windows'))
  }

  const activeTemplateStems = new Set<MessagePurpose>()
  for (const purposeCode of snapshot.activeTemplatePurposeCodes) {
    const stem = purposeStem(purposeCode)
    if (stem !== undefined) activeTemplateStems.add(stem)
  }
  const requiredTemplates = [...COMMON_TEMPLATES, ...(routing.route === null ? [] : ROUTE_TEMPLATES[routing.route])]
  for (const purpose of requiredTemplates) {
    if (!activeTemplateStems.has(purpose)) {
      issues.push(issue(CAMPAIGN_CONFIG_REASON.MISSING_MESSAGE_TEMPLATE, 'template', purpose))
    }
  }

  if (!snapshot.hasPublishedGuidelineVersion) {
    issues.push(issue(CAMPAIGN_CONFIG_REASON.MISSING_GUIDELINE_VERSION, 'guideline', 'guideline_version'))
  }

  if (!snapshot.hasCurrentApplicationUrl) {
    issues.push(issue(CAMPAIGN_CONFIG_REASON.MISSING_APPLICATION_URL, 'journey_configuration', 'application_url'))
  }

  // §13.8: a Visit A participant is told to phone the business. Without the number the instruction
  // message cannot be composed, so activating would guarantee a dead end mid-journey.
  if (routing.route === 'visit_a' && !snapshot.hasCurrentBusinessPhone) {
    issues.push(issue(CAMPAIGN_CONFIG_REASON.MISSING_BUSINESS_PHONE, 'business_contact', 'business_phone'))
  }
  // §13.9 and §13.10: Visit B and C both send the participant to a booking URL.
  if ((routing.route === 'visit_b' || routing.route === 'visit_c') && !snapshot.hasCurrentBookingUrl) {
    issues.push(issue(CAMPAIGN_CONFIG_REASON.MISSING_BOOKING_URL, 'business_contact', 'booking_url'))
  }

  // Every participant-facing purpose this route can send needs a named authoritative sender, and a
  // platform claim needs the legacy trigger to have been audited. Both are reported per purpose so
  // an operator sees the whole gap, not the first one.
  const ownershipByStem = new Map(snapshot.purposeOwnerships.map((ownership) => [ownership.purposeStem, ownership]))
  for (const purpose of requiredTemplates) {
    const ownership = ownershipByStem.get(purpose)
    if (ownership === undefined) {
      issues.push(issue(CAMPAIGN_CONFIG_REASON.MISSING_SENDER_OWNERSHIP, 'sender_ownership', purpose))
      continue
    }
    if (ownership.authoritativeSender === 'helloreview_platform' && !ownership.triggerAudited) {
      issues.push(issue(CAMPAIGN_CONFIG_REASON.UNAUDITED_SENDER_OWNERSHIP, 'sender_ownership', purpose))
    }
  }

  if (!snapshot.hasValidSelectionPolicy) {
    issues.push(issue(CAMPAIGN_CONFIG_REASON.INVALID_SELECTION_POLICY, 'selection_policy', 'selection_policy'))
  }

  return { canActivate: issues.length === 0, route: routing.route, issues }
}
