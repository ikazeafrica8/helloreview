import { Module } from '@nestjs/common'
import { BusinessApprovalModule } from '../business-approval/index.js'
import { CampaignConfigModule } from '../campaign-config/index.js'
import { HumanTasksModule } from '../human-tasks/index.js'
import { WorkflowCoreModule } from '../workflow-core/index.js'
import { AuditLogModule } from '../audit-log/index.js'
import { ShippingModule } from '../shipping/index.js'
import { SelectionModule } from '../selection/index.js'
import { AdminCommandService } from './admin-command.service.js'
import { ConfigurationAdminCommandService } from './configuration-command.service.js'
import { OperationsAdminService } from './operations-admin.service.js'
import { ParticipantAdminQueryService } from './participant-query.service.js'
import { SensitiveAccessAdminService } from './sensitive-access-admin.service.js'
import {
  ProductionLockedSensitiveAccessPolicyProvider,
  SENSITIVE_ACCESS_POLICY_PROVIDER,
} from './sensitive-access-policy-provider.js'

@Module({
  imports: [
    HumanTasksModule,
    BusinessApprovalModule,
    CampaignConfigModule,
    WorkflowCoreModule,
    AuditLogModule,
    ShippingModule,
    SelectionModule,
  ],
  providers: [
    ParticipantAdminQueryService,
    AdminCommandService,
    ConfigurationAdminCommandService,
    OperationsAdminService,
    ProductionLockedSensitiveAccessPolicyProvider,
    {
      provide: SENSITIVE_ACCESS_POLICY_PROVIDER,
      useExisting: ProductionLockedSensitiveAccessPolicyProvider,
    },
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
