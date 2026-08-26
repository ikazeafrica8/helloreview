import { Module } from '@nestjs/common'
import { PrivacyRequestService } from './privacy-request.service.js'
import { PrivacyRetentionService } from './privacy-retention.service.js'

@Module({
  providers: [PrivacyRequestService, PrivacyRetentionService],
  exports: [PrivacyRequestService, PrivacyRetentionService],
})
export class PrivacyOpsModule {}
