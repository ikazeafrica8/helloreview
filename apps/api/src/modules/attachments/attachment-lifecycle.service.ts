import { Inject, Injectable } from '@nestjs/common'
import { ATTACHMENT_STORAGE, type AttachmentStorage } from '@helloreview/adapters'
import { POSTGRES_POOL, runInTransaction } from '@helloreview/db'
import type { Pool } from 'pg'
import { AttachmentAccessError } from './attachment-access.service.js'
import { AttachmentRepository } from './attachment.repository.js'
import { evaluateAttachmentDeletion, type AttachmentRetentionDecision } from './retention-gate.js'
import { ATTACHMENT_REASON } from './reason-codes.js'

@Injectable()
export class AttachmentLifecycleService {
  constructor(
    @Inject(POSTGRES_POOL) private readonly pool: Pool,
    private readonly attachments: AttachmentRepository,
    @Inject(ATTACHMENT_STORAGE) private readonly storage: AttachmentStorage,
  ) {}

  async linkCleanEvidence(
    input: Readonly<{
      attachmentId: string
      workflowId: string
      participantId: string
      actorReference: string
      occurredAt: Date
    }>,
  ): Promise<Readonly<{ linked: boolean }>> {
    return runInTransaction(this.pool, async (tx) => {
      const evidence = await this.attachments.ownedEvidence(
        tx,
        input.attachmentId,
        input.workflowId,
        input.participantId,
        true,
      )
      if (evidence === undefined) throw new AttachmentAccessError(ATTACHMENT_REASON.OWNERSHIP_MISMATCH)
      if ((await this.attachments.currentSecurityState(tx, evidence.id)) !== 'clean') {
        throw new AttachmentAccessError(ATTACHMENT_REASON.ATTACHMENT_NOT_CLEAN)
      }
      const linked = await this.attachments.appendLifecycleEvent(tx, {
        attachmentId: evidence.id,
        eventType: 'evidence_linked',
        reasonCode: ATTACHMENT_REASON.EVIDENCE_LINKED,
        policyReference: null,
        actorReference: input.actorReference,
        deduplicationKey: `attachment-evidence:${evidence.id}`,
        occurredAt: input.occurredAt,
      })
      return { linked }
    })
  }

  async setLegalHold(
    input: Readonly<{
      attachmentId: string
      workflowId: string
      participantId: string
      holdReference: string
      active: boolean
      actorReference: string
      occurredAt: Date
    }>,
  ): Promise<Readonly<{ changed: boolean }>> {
    return runInTransaction(this.pool, async (tx) => {
      const evidence = await this.attachments.ownedEvidence(
        tx,
        input.attachmentId,
        input.workflowId,
        input.participantId,
        true,
      )
      if (evidence === undefined) throw new AttachmentAccessError(ATTACHMENT_REASON.OWNERSHIP_MISMATCH)
      const changed = await this.attachments.appendLifecycleEvent(tx, {
        attachmentId: evidence.id,
        eventType: input.active ? 'legal_hold_applied' : 'legal_hold_released',
        reasonCode: input.active ? ATTACHMENT_REASON.LEGAL_HOLD_APPLIED : ATTACHMENT_REASON.LEGAL_HOLD_RELEASED,
        policyReference: input.holdReference,
        actorReference: input.actorReference,
        deduplicationKey: `attachment-legal-hold:${evidence.id}:${input.holdReference}:${input.active ? 'apply' : 'release'}`,
        occurredAt: input.occurredAt,
      })
      return { changed }
    })
  }

  async deleteWhenEligible(
    input: Readonly<{
      attachmentId: string
      workflowId: string
      participantId: string
      policyReference: string | null
      operationId: string
      actorReference: string
      occurredAt: Date
    }>,
  ): Promise<Readonly<{ decision: AttachmentRetentionDecision; objectDeleted: boolean }>> {
    const prepared = await runInTransaction(this.pool, async (tx) => {
      const evidence = await this.attachments.ownedEvidence(
        tx,
        input.attachmentId,
        input.workflowId,
        input.participantId,
        true,
      )
      if (evidence === undefined) throw new AttachmentAccessError(ATTACHMENT_REASON.OWNERSHIP_MISMATCH)
      const decision = evaluateAttachmentDeletion({
        policyReference: input.policyReference,
        legalHoldActive: await this.attachments.legalHoldActive(tx, evidence.id),
      })
      if (!decision.allowed) {
        await this.attachments.appendLifecycleEvent(tx, {
          attachmentId: evidence.id,
          eventType:
            decision.reasonCode === ATTACHMENT_REASON.RETENTION_POLICY_MISSING
              ? 'deletion_blocked_policy_missing'
              : 'deletion_blocked_legal_hold',
          reasonCode: decision.reasonCode,
          policyReference: input.policyReference,
          actorReference: input.actorReference,
          deduplicationKey: `attachment-deletion-blocked:${input.operationId}`,
          occurredAt: input.occurredAt,
        })
        return { evidence, decision, shouldDeleteObject: false }
      }
      await this.attachments.appendLifecycleEvent(tx, {
        attachmentId: evidence.id,
        eventType: 'deletion_eligible',
        reasonCode: ATTACHMENT_REASON.DELETION_ELIGIBLE,
        policyReference: input.policyReference,
        actorReference: input.actorReference,
        deduplicationKey: `attachment-deletion-eligible:${input.operationId}`,
        occurredAt: input.occurredAt,
      })
      const activeReferences = await this.attachments.activeStorageReferenceCount(tx, evidence.storageReference)
      return { evidence, decision, shouldDeleteObject: activeReferences <= 1 }
    })

    if (!prepared.decision.allowed) return { decision: prepared.decision, objectDeleted: false }
    const deletion = prepared.shouldDeleteObject
      ? await this.storage.deleteEncrypted({
          storageReference: prepared.evidence.storageReference,
          contentHash: prepared.evidence.contentHash,
        })
      : { deleted: false }
    await runInTransaction(this.pool, (tx) =>
      this.attachments.appendLifecycleEvent(tx, {
        attachmentId: prepared.evidence.id,
        eventType: 'deleted',
        reasonCode: ATTACHMENT_REASON.ATTACHMENT_DELETED,
        policyReference: input.policyReference,
        actorReference: input.actorReference,
        deduplicationKey: `attachment-deleted:${prepared.evidence.id}`,
        occurredAt: new Date(input.occurredAt.getTime() + 1),
      }),
    )
    return { decision: prepared.decision, objectDeleted: deletion.deleted }
  }
}
