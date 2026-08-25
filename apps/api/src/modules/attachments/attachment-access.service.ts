import { createHash, randomBytes } from 'node:crypto'
import { Inject, Injectable } from '@nestjs/common'
import { POSTGRES_POOL, runInTransaction } from '@helloreview/db'
import { ATTACHMENT_STORAGE, type AttachmentStorage, type SignedAttachmentRead } from '@helloreview/adapters'
import { ATTACHMENT_READ_GRANT_TTL_SECONDS } from '@helloreview/config'
import type { Pool } from 'pg'
import { AttachmentRepository } from './attachment.repository.js'
import { ATTACHMENT_REASON } from './reason-codes.js'

const MAX_GRANT_LIFETIME_MS = 15 * 60 * 1_000

export class AttachmentAccessError extends Error {
  override readonly name = 'AttachmentAccessError'
  constructor(readonly reasonCode: string) {
    super(`attachment access rejected: ${reasonCode}`)
  }
}

export type IssuedAttachmentGrant = Readonly<{ token: string; expiresAt: Date }>

const tokenDigest = (token: string): string => createHash('sha256').update(token).digest('hex')
const issueToken = (): string => `hr_att_${randomBytes(32).toString('base64url')}`

const validLifetime = (now: Date, expiresAt: Date): boolean => {
  const lifetime = expiresAt.getTime() - now.getTime()
  return lifetime > 0 && lifetime <= MAX_GRANT_LIFETIME_MS
}

@Injectable()
export class AttachmentAccessService {
  constructor(
    @Inject(POSTGRES_POOL) private readonly pool: Pool,
    private readonly attachments: AttachmentRepository,
    @Inject(ATTACHMENT_STORAGE) private readonly storage: AttachmentStorage,
    @Inject(ATTACHMENT_READ_GRANT_TTL_SECONDS) private readonly readGrantTtlSeconds: number,
  ) {}

  async issueUploadGrant(
    input: Readonly<{
      workflowId: string
      participantId: string
      expectedDeclaredType: string
      maxBytes: number
      now: Date
      expiresAt: Date
    }>,
  ): Promise<IssuedAttachmentGrant> {
    if (!validLifetime(input.now, input.expiresAt) || input.maxBytes < 1) {
      throw new AttachmentAccessError(ATTACHMENT_REASON.GRANT_INVALID)
    }
    const token = issueToken()
    await runInTransaction(this.pool, async (tx) => {
      if (!(await this.attachments.workflowOwnedBy(tx, input.workflowId, input.participantId))) {
        throw new AttachmentAccessError(ATTACHMENT_REASON.OWNERSHIP_MISMATCH)
      }
      const grant = await tx.query(
        `INSERT INTO attachment_access_grants (
           kind, token_digest, workflow_id, participant_id, expected_declared_type,
           max_bytes, expires_at, created_at
         ) VALUES ('upload',$1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [
          tokenDigest(token),
          input.workflowId,
          input.participantId,
          input.expectedDeclaredType,
          input.maxBytes,
          input.expiresAt,
          input.now,
        ],
      )
      const grantId = grant.rows[0]?.id
      if (typeof grantId !== 'string') throw new Error('upload grant insert returned no id')
      await tx.query(
        `INSERT INTO attachment_grant_events (grant_id, event_type, reason_code, occurred_at)
         VALUES ($1,'issued',$2,$3)`,
        [grantId, ATTACHMENT_REASON.GRANT_ISSUED, input.now],
      )
    })
    return { token, expiresAt: input.expiresAt }
  }

  async consumeUploadGrant(
    input: Readonly<{
      token: string
      workflowId: string
      participantId: string
      declaredType: string
      sizeBytes: number
      now: Date
    }>,
  ): Promise<Readonly<{ grantId: string }>> {
    return runInTransaction(this.pool, async (tx) => {
      const result = await tx.query(
        `UPDATE attachment_access_grants
            SET consumed_at = $7
          WHERE token_digest = $1 AND kind = 'upload'
            AND workflow_id = $2 AND participant_id = $3
            AND expected_declared_type = $4 AND max_bytes >= $5
            AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > $6
        RETURNING id`,
        [
          tokenDigest(input.token),
          input.workflowId,
          input.participantId,
          input.declaredType,
          input.sizeBytes,
          input.now,
          input.now,
        ],
      )
      const grantId = result.rows[0]?.id
      if (typeof grantId !== 'string') throw new AttachmentAccessError(ATTACHMENT_REASON.GRANT_INVALID)
      await tx.query(
        `INSERT INTO attachment_grant_events (grant_id, event_type, reason_code, occurred_at)
         VALUES ($1,'consumed',$2,$3)`,
        [grantId, ATTACHMENT_REASON.GRANT_CONSUMED, input.now],
      )
      return { grantId }
    })
  }

  async fulfillUploadGrant(grantId: string, attachmentId: string, occurredAt: Date): Promise<void> {
    await this.pool.query(
      `INSERT INTO attachment_grant_events (grant_id, attachment_id, event_type, reason_code, occurred_at)
       VALUES ($1,$2,'fulfilled',$3,$4)`,
      [grantId, attachmentId, ATTACHMENT_REASON.GRANT_FULFILLED, occurredAt],
    )
  }

  async issueReadGrant(
    input: Readonly<{
      attachmentId: string
      workflowId: string
      participantId: string
      now: Date
      expiresAt?: Date
    }>,
  ): Promise<IssuedAttachmentGrant> {
    const expiresAt = input.expiresAt ?? new Date(input.now.getTime() + this.readGrantTtlSeconds * 1_000)
    if (!validLifetime(input.now, expiresAt)) {
      throw new AttachmentAccessError(ATTACHMENT_REASON.GRANT_INVALID)
    }
    const token = issueToken()
    await runInTransaction(this.pool, async (tx) => {
      const evidence = await this.attachments.ownedEvidence(
        tx,
        input.attachmentId,
        input.workflowId,
        input.participantId,
      )
      if (evidence === undefined) throw new AttachmentAccessError(ATTACHMENT_REASON.OWNERSHIP_MISMATCH)
      if ((await this.attachments.currentSecurityState(tx, input.attachmentId)) !== 'clean') {
        throw new AttachmentAccessError(ATTACHMENT_REASON.ATTACHMENT_NOT_CLEAN)
      }
      const grant = await tx.query(
        `INSERT INTO attachment_access_grants (
           kind, token_digest, workflow_id, participant_id, attachment_id, expires_at, created_at
         ) VALUES ('read',$1,$2,$3,$4,$5,$6) RETURNING id`,
        [tokenDigest(token), input.workflowId, input.participantId, input.attachmentId, expiresAt, input.now],
      )
      const grantId = grant.rows[0]?.id
      if (typeof grantId !== 'string') throw new Error('read grant insert returned no id')
      await tx.query(
        `INSERT INTO attachment_grant_events (grant_id, attachment_id, event_type, reason_code, occurred_at)
         VALUES ($1,$2,'issued',$3,$4)`,
        [grantId, input.attachmentId, ATTACHMENT_REASON.GRANT_ISSUED, input.now],
      )
    })
    return { token, expiresAt }
  }

  async consumeReadGrant(
    input: Readonly<{
      token: string
      workflowId: string
      participantId: string
      now: Date
    }>,
  ): Promise<SignedAttachmentRead> {
    const consumed = await runInTransaction(this.pool, async (tx) => {
      const result = await tx.query(
        `UPDATE attachment_access_grants
            SET consumed_at = $5
          WHERE token_digest = $1 AND kind = 'read'
            AND workflow_id = $2 AND participant_id = $3
            AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > $4
        RETURNING id, attachment_id, expires_at`,
        [tokenDigest(input.token), input.workflowId, input.participantId, input.now, input.now],
      )
      const row = result.rows[0]
      const grantId = row?.id
      const attachmentId = row?.attachment_id
      const expiresAt = row?.expires_at
      if (typeof grantId !== 'string' || typeof attachmentId !== 'string' || !(expiresAt instanceof Date)) {
        throw new AttachmentAccessError(ATTACHMENT_REASON.GRANT_INVALID)
      }
      const evidence = await this.attachments.ownedEvidence(tx, attachmentId, input.workflowId, input.participantId)
      if (evidence === undefined) throw new AttachmentAccessError(ATTACHMENT_REASON.GRANT_INVALID)
      if ((await this.attachments.currentSecurityState(tx, attachmentId)) !== 'clean') {
        throw new AttachmentAccessError(ATTACHMENT_REASON.ATTACHMENT_NOT_CLEAN)
      }
      await tx.query(
        `INSERT INTO attachment_grant_events (grant_id, attachment_id, event_type, reason_code, occurred_at)
         VALUES ($1,$2,'consumed',$3,$4)`,
        [grantId, attachmentId, ATTACHMENT_REASON.GRANT_CONSUMED, input.now],
      )
      return { evidence, expiresAt }
    })
    return this.storage.signRead({
      storageReference: consumed.evidence.storageReference,
      contentHash: consumed.evidence.contentHash,
      now: input.now,
      expiresAt: consumed.expiresAt,
    })
  }

  async revokeGrant(token: string, occurredAt: Date): Promise<boolean> {
    return runInTransaction(this.pool, async (tx) => {
      const result = await tx.query(
        `UPDATE attachment_access_grants SET revoked_at = $2
          WHERE token_digest = $1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > $2
        RETURNING id, attachment_id`,
        [tokenDigest(token), occurredAt],
      )
      const row = result.rows[0]
      if (row === undefined) return false
      await tx.query(
        `INSERT INTO attachment_grant_events (grant_id, attachment_id, event_type, reason_code, occurred_at)
         VALUES ($1,$2,'revoked',$3,$4)`,
        [row.id, row.attachment_id, ATTACHMENT_REASON.GRANT_REVOKED, occurredAt],
      )
      return true
    })
  }
}
