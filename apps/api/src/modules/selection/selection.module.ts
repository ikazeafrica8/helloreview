import { Module } from '@nestjs/common'
import { IdentityResolutionModule } from '../identity-resolution/index.js'
import { RulesEngineModule } from '../rules-engine/index.js'
import { WorkflowCoreModule } from '../workflow-core/index.js'
import { RankingEvidenceAdapter } from './ranking-evidence.js'
import { SelectionService } from './selection.service.js'

@Module({
  imports: [WorkflowCoreModule, RulesEngineModule, IdentityResolutionModule],
  providers: [RankingEvidenceAdapter, SelectionService],
  exports: [RankingEvidenceAdapter, SelectionService],
})
export class SelectionModule {}
