import { Module } from '@nestjs/common'
import { CampaignConfigModule } from '../campaign-config/index.js'
import { MessagingModule } from '../messaging/index.js'
import { WorkflowCoreModule } from '../workflow-core/index.js'
import { BusinessApprovalRepository } from './business-approval.repository.js'
import { BusinessApprovalService } from './business-approval.service.js'
import { VisitCBookingService } from './visit-c-booking.service.js'

@Module({
  imports: [WorkflowCoreModule, CampaignConfigModule, MessagingModule],
  providers: [BusinessApprovalRepository, BusinessApprovalService, VisitCBookingService],
  exports: [BusinessApprovalRepository, BusinessApprovalService, VisitCBookingService],
})
export class BusinessApprovalModule {}
