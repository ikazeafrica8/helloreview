import { Module } from '@nestjs/common'
import { WorkflowCoreModule } from '../workflow-core/index.js'
import { AttachmentAccessService } from './attachment-access.service.js'
import { AttachmentIngestService } from './attachment-ingest.service.js'
import { AttachmentLifecycleService } from './attachment-lifecycle.service.js'
import { AttachmentRepository } from './attachment.repository.js'

@Module({
  imports: [WorkflowCoreModule],
  providers: [AttachmentRepository, AttachmentAccessService, AttachmentIngestService, AttachmentLifecycleService],
  exports: [AttachmentRepository, AttachmentAccessService, AttachmentIngestService, AttachmentLifecycleService],
})
export class AttachmentsModule {}
