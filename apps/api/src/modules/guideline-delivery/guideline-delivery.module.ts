import { Module } from '@nestjs/common'
import { MessagingModule } from '../messaging/index.js'
import { RulesEngineModule } from '../rules-engine/index.js'
import { ReservationModule } from '../reservation/index.js'
import { WorkflowCoreModule } from '../workflow-core/index.js'
import { GuidelineDeliveryRepository } from './guideline-delivery.repository.js'
import { GuidelineDeliveryService } from './guideline-delivery.service.js'
import { GuidelineIncidentAuditorService } from './guideline-incident-auditor.service.js'
import { VisitAJourneyService } from './visit-a-journey.service.js'

@Module({
  imports: [WorkflowCoreModule, RulesEngineModule, MessagingModule, ReservationModule],
  providers: [
    GuidelineDeliveryRepository,
    GuidelineDeliveryService,
    GuidelineIncidentAuditorService,
    VisitAJourneyService,
  ],
  exports: [GuidelineDeliveryService, GuidelineIncidentAuditorService, VisitAJourneyService],
})
export class GuidelineDeliveryModule {}
