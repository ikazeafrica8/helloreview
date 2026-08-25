import { Module } from '@nestjs/common'
import { MessagingModule } from '../messaging/index.js'
import { RulesEngineModule } from '../rules-engine/index.js'
import { WorkflowCoreModule } from '../workflow-core/index.js'
import { ShippingService } from './shipping.service.js'

@Module({
  imports: [WorkflowCoreModule, MessagingModule, RulesEngineModule],
  providers: [ShippingService],
  exports: [ShippingService],
})
export class ShippingModule {}
