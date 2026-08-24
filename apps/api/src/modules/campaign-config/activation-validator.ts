import { MESSAGE_PURPOSES, purposeStem, type MessagePurpose } from '@helloreview/contracts'
import { CAMPAIGN_CONFIG_REASON, type CampaignConfigReasonCode } from './reason-codes.js'

export type CampaignType = 'shipping' | 'payback' | 'visit'
export type VisitMethod = 'not_applicable' | 'visit_a' | 'visit_b' | 'visit_c'
export type CampaignRoute = 'shipping' | 'payback' | 'visit_a' | 'visit_b' | 'visit_c'
export type CampaignRuleType = 'selection' | 'reservation' | 'guideline' | 'payback' | 'shipping'

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
}>

export type CampaignActivationRequirement = 'route' | 'rule' | 'reservation_windows' | 'template' | 'guideline'

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
  MESSAGE_PURPOSES.SELECTION_RESULT,
  MESSAGE_PURPOSES.GUIDELINE_DELIVERY,
]

const ROUTE_TEMPLATES: Readonly<Record<CampaignRoute, readonly MessagePurpose[]>> = {
  shipping: [MESSAGE_PURPOSES.SHIPPING_ADDRESS_REQUEST],
  payback: [MESSAGE_PURPOSES.PAYBACK_CONSENT_REQUEST],
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

  return { canActivate: issues.length === 0, route: routing.route, issues }
}
