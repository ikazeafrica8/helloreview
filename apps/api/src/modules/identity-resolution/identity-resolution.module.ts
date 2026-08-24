import { Module } from '@nestjs/common'
import { ApplicationSyncModule } from '../application-sync/index.js'
import { CampaignConfigModule } from '../campaign-config/index.js'

/** Phase 4 identity boundary. T29 adds deterministic matching services behind this module. */
@Module({ imports: [ApplicationSyncModule, CampaignConfigModule] })
export class IdentityResolutionModule {}
