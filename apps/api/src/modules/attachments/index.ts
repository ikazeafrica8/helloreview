export { AttachmentsModule } from './attachments.module.js'
export { AttachmentRepository } from './attachment.repository.js'
export type {
  AttachmentEvidence,
  AttachmentLifecycleEventType,
  AttachmentSecurityState,
} from './attachment.repository.js'
export { AttachmentAccessError, AttachmentAccessService } from './attachment-access.service.js'
export type { IssuedAttachmentGrant } from './attachment-access.service.js'
export { AttachmentIngestError, AttachmentIngestService } from './attachment-ingest.service.js'
export type { IngestAttachmentInput, IngestedAttachment } from './attachment-ingest.service.js'
export { AttachmentLifecycleService } from './attachment-lifecycle.service.js'
export { ATTACHMENT_ALLOWED_TYPES, detectAttachmentType, inspectAttachmentFile } from './file-inspection.js'
export type { AttachmentAllowedType, FileInspectionResult } from './file-inspection.js'
export { evaluateAttachmentDeletion } from './retention-gate.js'
export type { AttachmentRetentionDecision } from './retention-gate.js'
export { ATTACHMENT_REASON } from './reason-codes.js'
export type { AttachmentReasonCode } from './reason-codes.js'
