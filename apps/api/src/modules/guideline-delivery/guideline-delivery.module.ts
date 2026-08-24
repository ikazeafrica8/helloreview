import { Module } from '@nestjs/common'
import { MessagingModule } from '../messaging/index.js'
import { RulesEngineModule } from '../rules-engine/index.js'
import { WorkflowCoreModule } from '../workflow-core/index.js'
import { GuidelineDeliveryRepository } from './guideline-delivery.repository.js'
import { GuidelineDeliveryService } from './guideline-delivery.service.js'
import { GuidelineIncidentAuditorService } from './guideline-incident-auditor.service.js'

@Module({
  imports: [WorkflowCoreModule, RulesEngineModule, MessagingModule],
  providers: [GuidelineDeliveryRepository, GuidelineDeliveryService, GuidelineIncidentAuditorService],
  exports: [GuidelineDeliveryService, GuidelineIncidentAuditorService],
})
export class GuidelineDeliveryModule {}
