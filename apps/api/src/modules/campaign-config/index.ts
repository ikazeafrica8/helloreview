// The ONLY public surface of campaign-config (SPEC.md §5).

export { CampaignConfigModule } from './campaign-config.module.js'
export { CampaignRulesRepository } from './campaign-rules.repository.js'
export type { ResolvedRuleVersion, ReservationWindow } from './campaign-rules.repository.js'
export { normalizeBusinessName, matchesApprovedName, matchesBranch } from './business-name-normalizer.js'
export { ConfigurationPublishingService, ConfigurationPublishingError } from './publishing.js'
export type { PublishedGuidelineVersion, TransitionedMessageTemplate } from './publishing.js'
export { CAMPAIGN_CONFIG_REASON } from './reason-codes.js'
export type { CampaignConfigReasonCode } from './reason-codes.js'
export { validateCampaignActivation } from './activation-validator.js'
export type {
  CampaignType,
  VisitMethod,
  CampaignRoute,
  CampaignRuleType,
  CampaignActivationSnapshot,
  CampaignPurposeOwnership,
  CampaignActivationRequirement,
  CampaignActivationIssue,
  CampaignActivationResult,
} from './activation-validator.js'
