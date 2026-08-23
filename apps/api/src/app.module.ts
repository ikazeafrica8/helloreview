import { Module } from '@nestjs/common'
import { PlatformCoreModule } from './modules/platform-core/index.js'
import { AuditLogModule } from './modules/audit-log/index.js'
import { ProviderGatewayModule } from './modules/provider-gateway/index.js'
import { CampaignConfigModule } from './modules/campaign-config/index.js'

/**
 * Composition root. Every capability-map module from SPEC.md §3.1 is imported here as it lands, in
 * dependency order — platform-core first, because everything else rests on it.
 */
@Module({
  imports: [PlatformCoreModule, AuditLogModule, ProviderGatewayModule, CampaignConfigModule],
})
export class AppModule {}
