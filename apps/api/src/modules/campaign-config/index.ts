// The ONLY public surface of campaign-config (SPEC.md §5).

export { CampaignConfigModule } from './campaign-config.module.js'
export { CampaignRulesRepository } from './campaign-rules.repository.js'
export type { ResolvedRuleVersion, ReservationWindow } from './campaign-rules.repository.js'
export { normalizeBusinessName, matchesApprovedName, matchesBranch } from './business-name-normalizer.js'
