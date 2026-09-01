import { Module } from '@nestjs/common'
import { ApplicationSyncModule } from '../application-sync/index.js'
import { CampaignConfigModule } from '../campaign-config/index.js'
import { ApplicationCandidateLookupService } from './candidate-lookup.service.js'
import { ApplicationParticipantBootstrapService } from './participant-bootstrap.service.js'

/** Phase 4 identity boundary. T29 adds deterministic matching services behind this module. */
@Module({
  imports: [ApplicationSyncModule, CampaignConfigModule],
  providers: [ApplicationCandidateLookupService, ApplicationParticipantBootstrapService],
  exports: [ApplicationCandidateLookupService, ApplicationParticipantBootstrapService],
})
export class IdentityResolutionModule {}
