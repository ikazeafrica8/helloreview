import { Module } from '@nestjs/common'
import { CampaignConfigModule } from '../campaign-config/index.js'
import { ProviderGatewayModule } from '../provider-gateway/index.js'
import { WorkflowCoreModule } from '../workflow-core/index.js'
import { HumanOwnershipService } from './human-ownership.service.js'
import { MessageTemplateRepository } from './message-template.repository.js'
import { OutboundIntentService } from './outbound-intent.service.js'

@Module({
  imports: [WorkflowCoreModule, CampaignConfigModule, ProviderGatewayModule],
  providers: [MessageTemplateRepository, OutboundIntentService, HumanOwnershipService],
  exports: [MessageTemplateRepository, OutboundIntentService, HumanOwnershipService],
})
export class MessagingModule {}
