import { Module } from '@nestjs/common'
import { ProviderGatewayModule } from '../provider-gateway/index.js'
import { CampaignConfigModule } from '../campaign-config/index.js'
import { ApplicationSyncService } from './application-sync.service.js'

@Module({
  imports: [ProviderGatewayModule, CampaignConfigModule],
  providers: [ApplicationSyncService],
  exports: [ApplicationSyncService],
})
export class ApplicationSyncModule {}
