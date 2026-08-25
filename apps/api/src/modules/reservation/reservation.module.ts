import { Module } from '@nestjs/common'
import { AiOrchestrationModule } from '../ai-orchestration/index.js'
import { BusinessApprovalModule } from '../business-approval/index.js'
import { MessagingModule } from '../messaging/index.js'
import { RulesEngineModule } from '../rules-engine/index.js'
import { WorkflowCoreModule } from '../workflow-core/index.js'
import { ReservationService } from './reservation.service.js'
import { VisitAReservationService } from './visit-a-reservation.service.js'

@Module({
  imports: [WorkflowCoreModule, RulesEngineModule, AiOrchestrationModule, BusinessApprovalModule, MessagingModule],
  providers: [ReservationService, VisitAReservationService],
  exports: [ReservationService, VisitAReservationService],
})
export class ReservationModule {}
