import { Module } from '@nestjs/common'
import { AiOrchestrationModule } from '../ai-orchestration/index.js'
import { BusinessApprovalModule } from '../business-approval/index.js'
import { RulesEngineModule } from '../rules-engine/index.js'
import { WorkflowCoreModule } from '../workflow-core/index.js'
import { ReservationService } from './reservation.service.js'

@Module({
  imports: [WorkflowCoreModule, RulesEngineModule, AiOrchestrationModule, BusinessApprovalModule],
  providers: [ReservationService],
  exports: [ReservationService],
})
export class ReservationModule {}
