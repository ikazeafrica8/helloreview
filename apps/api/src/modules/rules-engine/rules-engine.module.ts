import { Module } from '@nestjs/common'
import { CampaignConfigModule } from '../campaign-config/index.js'

@Module({ imports: [CampaignConfigModule] })
export class RulesEngineModule {}
