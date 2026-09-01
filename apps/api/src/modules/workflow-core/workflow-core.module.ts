import { Module } from '@nestjs/common'
import { AuditLogModule } from '../audit-log/index.js'
import { CampaignConfigModule } from '../campaign-config/index.js'
import { IdentityResolutionModule } from '../identity-resolution/index.js'
import { AutomationPauseService } from './automation-pause.service.js'
import { WorkflowCorrectionService } from './workflow-correction.service.js'
import { WorkflowInstanceService } from './workflow-instance.service.js'
import { WorkflowTransitionService } from './workflow-transition.service.js'
import { HumanHandoffProjectionService } from './human-handoff-projection.service.js'
import { ApplicationWorkflowBootstrapService } from './application-workflow-bootstrap.service.js'

/** Durable multidimensional workflow projection and its append-only decision ledger. */
@Module({
  imports: [IdentityResolutionModule, CampaignConfigModule, AuditLogModule],
  providers: [
    WorkflowInstanceService,
    AutomationPauseService,
    WorkflowTransitionService,
    WorkflowCorrectionService,
    HumanHandoffProjectionService,
    ApplicationWorkflowBootstrapService,
  ],
  exports: [
    WorkflowInstanceService,
    AutomationPauseService,
    WorkflowTransitionService,
    WorkflowCorrectionService,
    HumanHandoffProjectionService,
    ApplicationWorkflowBootstrapService,
  ],
})
export class WorkflowCoreModule {}
