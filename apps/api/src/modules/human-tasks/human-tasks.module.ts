import { Module } from '@nestjs/common'
import { HumanReviewTaskService } from './human-review-task.service.js'

@Module({ providers: [HumanReviewTaskService], exports: [HumanReviewTaskService] })
export class HumanTasksModule {}
