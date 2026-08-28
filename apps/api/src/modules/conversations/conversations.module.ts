import { Module } from '@nestjs/common'
import { WorkflowCoreModule } from '../workflow-core/index.js'
import { ConversationService } from './conversation.service.js'
import { InboundMessageService } from './inbound-message.service.js'
import { SecretCommentEvidenceService } from './secret-comment-evidence.service.js'

@Module({
  imports: [WorkflowCoreModule],
  providers: [ConversationService, InboundMessageService, SecretCommentEvidenceService],
  exports: [ConversationService, InboundMessageService, SecretCommentEvidenceService],
})
export class ConversationsModule {}
