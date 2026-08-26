import { Module } from '@nestjs/common'
import { PlatformCoreModule } from './modules/platform-core/index.js'
import { AuditLogModule } from './modules/audit-log/index.js'
import { ProviderGatewayModule } from './modules/provider-gateway/index.js'
import { CampaignConfigModule } from './modules/campaign-config/index.js'
import { ApplicationSyncModule } from './modules/application-sync/index.js'
import { IdentityResolutionModule } from './modules/identity-resolution/index.js'
import { HumanTasksModule } from './modules/human-tasks/index.js'
import { WorkflowCoreModule } from './modules/workflow-core/index.js'
import { MessagingModule } from './modules/messaging/index.js'
import { RulesEngineModule } from './modules/rules-engine/index.js'
import { BusinessApprovalModule } from './modules/business-approval/index.js'
import { GuidelineDeliveryModule } from './modules/guideline-delivery/index.js'
import { AttachmentsModule } from './modules/attachments/index.js'
import { AiOrchestrationModule } from './modules/ai-orchestration/index.js'
import { SelectionModule } from './modules/selection/index.js'
import { ShippingModule } from './modules/shipping/index.js'
import { PaybackConsentModule } from './modules/payback-consent/index.js'
import { ReservationModule } from './modules/reservation/index.js'
import { PrivacyOpsModule } from './modules/privacy-ops/index.js'
import { AdminApiModule } from './modules/admin-api/index.js'

/**
 * Composition root. Every capability-map module from SPEC.md §3.1 is imported here as it lands, in
 * dependency order — platform-core first, because everything else rests on it.
 */
@Module({
  imports: [
    PlatformCoreModule,
    AuditLogModule,
    ProviderGatewayModule,
    CampaignConfigModule,
    ApplicationSyncModule,
    IdentityResolutionModule,
    WorkflowCoreModule,
    MessagingModule,
    HumanTasksModule,
    RulesEngineModule,
    BusinessApprovalModule,
    GuidelineDeliveryModule,
    AttachmentsModule,
    AiOrchestrationModule,
    SelectionModule,
    ShippingModule,
    PaybackConsentModule,
    ReservationModule,
    PrivacyOpsModule,
    AdminApiModule,
  ],
})
export class AppModule {}
