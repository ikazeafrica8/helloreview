import { Module } from '@nestjs/common'
import { PlatformCoreModule } from '../platform-core/index.js'
import { AuditLogModule } from '../audit-log/index.js'
import { CampaignRulesRepository } from './campaign-rules.repository.js'

/**
 * Campaign configuration (SPEC.md §3.1: depends on platform-core and audit-log).
 *
 * The audit-log dependency is not decorative: FR-CAM-004 requires configuration changes to be
 * auditable, and T25's activation validation records who activated a campaign and against which
 * rule versions.
 */
@Module({
  imports: [PlatformCoreModule, AuditLogModule],
  providers: [CampaignRulesRepository],
  exports: [CampaignRulesRepository],
})
export class CampaignConfigModule {}
