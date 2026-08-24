import { Module } from '@nestjs/common'
import { HumanReviewTaskService } from './human-review-task.service.js'
import { MessagingModule } from '../messaging/index.js'
import { WorkflowCoreModule } from '../workflow-core/index.js'

@Module({
  imports: [WorkflowCoreModule, MessagingModule],
  providers: [HumanReviewTaskService],
  exports: [HumanReviewTaskService],
})
export class HumanTasksModule {}
