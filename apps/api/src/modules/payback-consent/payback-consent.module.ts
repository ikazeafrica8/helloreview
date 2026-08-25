import { Module } from '@nestjs/common'
import { CampaignConfigModule } from '../campaign-config/index.js'
import { MessagingModule } from '../messaging/index.js'
import { WorkflowCoreModule } from '../workflow-core/index.js'
import { PaybackConsentService } from './payback-consent.service.js'

@Module({
  imports: [WorkflowCoreModule, MessagingModule, CampaignConfigModule],
  providers: [PaybackConsentService],
  exports: [PaybackConsentService],
})
export class PaybackConsentModule {}
