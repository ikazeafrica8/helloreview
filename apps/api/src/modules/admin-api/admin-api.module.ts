import { Module } from '@nestjs/common'
import { BusinessApprovalModule } from '../business-approval/index.js'
import { CampaignConfigModule } from '../campaign-config/index.js'
import { HumanTasksModule } from '../human-tasks/index.js'
import { WorkflowCoreModule } from '../workflow-core/index.js'
import { AuditLogModule } from '../audit-log/index.js'
import { ShippingModule } from '../shipping/index.js'
import { AdminCommandService } from './admin-command.service.js'
import { ConfigurationAdminCommandService } from './configuration-command.service.js'
import { OperationsAdminService } from './operations-admin.service.js'
import { ParticipantAdminQueryService } from './participant-query.service.js'
import { SensitiveAccessAdminService } from './sensitive-access-admin.service.js'

@Module({
  imports: [
    HumanTasksModule,
    BusinessApprovalModule,
    CampaignConfigModule,
    WorkflowCoreModule,
    AuditLogModule,
    ShippingModule,
  ],
  providers: [
    ParticipantAdminQueryService,
    AdminCommandService,
    ConfigurationAdminCommandService,
    OperationsAdminService,
    SensitiveAccessAdminService,
  ],
  exports: [
    ParticipantAdminQueryService,
    AdminCommandService,
    ConfigurationAdminCommandService,
    OperationsAdminService,
    SensitiveAccessAdminService,
  ],
})
export class AdminApiModule {}
