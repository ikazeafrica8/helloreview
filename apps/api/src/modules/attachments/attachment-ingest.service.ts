import { createHash } from 'node:crypto'
import { Inject, Injectable } from '@nestjs/common'
import {
  ATTACHMENT_STORAGE,
  MALWARE_SCANNER,
  type AttachmentStorage,
  type MalwareScanner,
  type MalwareScanResult,
} from '@helloreview/adapters'
import { ATTACHMENT_MAX_BYTES } from '@helloreview/config'
import { POSTGRES_POOL, runInTransaction } from '@helloreview/db'
import type { Pool } from 'pg'
import { z } from 'zod'
import { AttachmentAccessService } from './attachment-access.service.js'
import { AttachmentRepository, type AttachmentEvidence, type AttachmentSecurityState } from './attachment.repository.js'
import { inspectAttachmentFile } from './file-inspection.js'
import { ATTACHMENT_REASON } from './reason-codes.js'

const ingestRequestSchema = z
  .object({
    uploadToken: z.string().min(32).max(200),
    workflowId: z.uuid(),
    participantId: z.uuid(),
    sourceMessageReference: z.string().min(1).max(500),
    /**
     * The T135 inbound message this file arrived on.
     *
     * Optional and additive: `sourceMessageReference` above has carried the link as free text since
     * T88, and rows written before `inbound_messages` existed cannot be backfilled because this
     * table has UPDATE revoked. A caller that knows the message id supplies both.
     */
    inboundMessageId: z.uuid().nullish(),
    providerReference: z.string().min(1).max(500),
    filename: z.string().min(1).max(255),
    declaredType: z.string().min(1).max(200),
    bytes: z.instanceof(Uint8Array),
    receivedAt: z.date(),
  })
  .strict()

export type IngestAttachmentInput = z.input<typeof ingestRequestSchema>

export type IngestedAttachment = Readonly<{
  evidence: AttachmentEvidence
  securityState: AttachmentSecurityState
  deduplicated: boolean
}>

export class AttachmentIngestError extends Error {
  override readonly name = 'AttachmentIngestError'
  constructor(readonly reasonCode: string) {
    super(`attachment ingest rejected: ${reasonCode}`)
  }
}

const scanResult = async (
  scanner: MalwareScanner,
  request: Parameters<MalwareScanner['scan']>[0],
): Promise<MalwareScanResult> => {
  try {
    return await scanner.scan(request)
  } catch {
    return { status: 'error', failureCode: 'MALWARE_SCANNER_EXCEPTION' }
  }
}

@Injectable()
export class AttachmentIngestService {
  constructor(
    @Inject(POSTGRES_POOL) private readonly pool: Pool,
    private readonly attachments: AttachmentRepository,
    private readonly access: AttachmentAccessService,
    @Inject(ATTACHMENT_STORAGE) private readonly storage: AttachmentStorage,
    @Inject(MALWARE_SCANNER) private readonly scanner: MalwareScanner,
    @Inject(ATTACHMENT_MAX_BYTES) private readonly maxBytes: number,
  ) {}

  async ingest(raw: IngestAttachmentInput): Promise<IngestedAttachment> {
    const parsed = ingestRequestSchema.safeParse(raw)
    if (!parsed.success) throw new AttachmentIngestError(ATTACHMENT_REASON.INPUT_INVALID)
    const input = parsed.data

    const consumed = await this.access.consumeUploadGrant({
      token: input.uploadToken,
      workflowId: input.workflowId,
      participantId: input.participantId,
      declaredType: input.declaredType,
      sizeBytes: input.bytes.byteLength,
      now: input.receivedAt,
    })
    const inspection = inspectAttachmentFile({
      filename: input.filename,
      declaredType: input.declaredType,
      bytes: input.bytes,
      maxBytes: this.maxBytes,
    })
    if (!inspection.accepted) throw new AttachmentIngestError(inspection.reasonCode)

    const contentHash = createHash('sha256').update(input.bytes).digest('hex')
    const existing = await runInTransaction(this.pool, (tx) =>
      this.attachments.findBySource(tx, input.workflowId, input.providerReference),
    )
    if (existing !== undefined) {
      if (
        existing.participantId !== input.participantId ||
        existing.sourceMessageReference !== input.sourceMessageReference ||
        existing.contentHash !== contentHash
      ) {
        throw new AttachmentIngestError(ATTACHMENT_REASON.SOURCE_REFERENCE_CONFLICT)
      }
      const state = await runInTransaction(this.pool, (tx) => this.attachments.currentSecurityState(tx, existing.id))
      if (state === undefined) throw new Error('existing attachment has no security history')
      await this.access.fulfillUploadGrant(consumed.grantId, existing.id, input.receivedAt)
      return { evidence: existing, securityState: state, deduplicated: true }
    }

    const stored = await this.storage.putEncrypted({ contentHash, bytes: input.bytes })
    const evidence = await runInTransaction(this.pool, async (tx) => {
      if (!(await this.attachments.workflowOwnedBy(tx, input.workflowId, input.participantId))) {
        throw new AttachmentIngestError(ATTACHMENT_REASON.OWNERSHIP_MISMATCH)
      }
      const created = await this.attachments.createEvidence(tx, {
        workflowId: input.workflowId,
        participantId: input.participantId,
        sourceMessageReference: input.sourceMessageReference,
        providerReference: input.providerReference,
        declaredType: input.declaredType,
        detectedType: inspection.detectedType,
        sizeBytes: input.bytes.byteLength,
        contentHash,
        storageReference: stored.storageReference,
        inboundMessageId: input.inboundMessageId ?? null,
        createdAt: input.receivedAt,
      })
      await this.attachments.appendSecurityEvent(tx, {
        attachmentId: created.id,
        state: 'quarantined',
        reasonCode: ATTACHMENT_REASON.ATTACHMENT_QUARANTINED,
        scannerProvider: null,
        occurredAt: input.receivedAt,
      })
      return created
    })

    const scanningAt = new Date(input.receivedAt.getTime() + 1)
    await runInTransaction(this.pool, (tx) =>
      this.attachments.appendSecurityEvent(tx, {
        attachmentId: evidence.id,
        state: 'scanning',
        reasonCode: ATTACHMENT_REASON.ATTACHMENT_SCANNING,
        scannerProvider: this.scanner.provider,
        occurredAt: scanningAt,
      }),
    )
    const result = await scanResult(this.scanner, {
      contentHash,
      detectedType: inspection.detectedType,
      bytes: input.bytes,
    })
    const completedAt = new Date(input.receivedAt.getTime() + 2)

    if (result.status === 'clean') {
      await runInTransaction(this.pool, (tx) =>
        this.attachments.appendSecurityEvent(tx, {
          attachmentId: evidence.id,
          state: 'clean',
          reasonCode: ATTACHMENT_REASON.ATTACHMENT_CLEAN,
          scannerProvider: this.scanner.provider,
          occurredAt: completedAt,
        }),
      )
      await this.access.fulfillUploadGrant(consumed.grantId, evidence.id, completedAt)
      return { evidence, securityState: 'clean', deduplicated: stored.deduplicated }
    }

    const state: AttachmentSecurityState = result.status === 'infected' ? 'rejected' : 'scan_failed'
    const reasonCode =
      result.status === 'infected' ? ATTACHMENT_REASON.MALWARE_DETECTED : ATTACHMENT_REASON.MALWARE_SCAN_FAILED
    await runInTransaction(this.pool, async (tx) => {
      await this.attachments.appendSecurityEvent(tx, {
        attachmentId: evidence.id,
        state,
        reasonCode,
        scannerProvider: this.scanner.provider,
        occurredAt: completedAt,
      })
      await this.attachments.appendLifecycleEvent(tx, {
        attachmentId: evidence.id,
        eventType: 'operator_review_required',
        reasonCode: ATTACHMENT_REASON.OPERATOR_REVIEW_REQUIRED,
        policyReference: null,
        actorReference: 'attachment-security-pipeline',
        deduplicationKey: `attachment-review:${evidence.id}`,
        occurredAt: completedAt,
      })
    })
    return { evidence, securityState: state, deduplicated: stored.deduplicated }
  }
}
