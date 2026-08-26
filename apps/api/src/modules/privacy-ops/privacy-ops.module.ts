import { Module } from '@nestjs/common'
import { PrivacyRequestService } from './privacy-request.service.js'

@Module({
  providers: [PrivacyRequestService],
  exports: [PrivacyRequestService],
})
export class PrivacyOpsModule {}
