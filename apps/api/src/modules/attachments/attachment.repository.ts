import { Injectable } from '@nestjs/common'
import type { DbTransaction } from '@helloreview/db'

export type AttachmentSecurityState = 'quarantined' | 'scanning' | 'clean' | 'rejected' | 'scan_failed'
export type AttachmentLifecycleEventType =
  | 'evidence_linked'
  | 'operator_review_required'
  | 'legal_hold_applied'
  | 'legal_hold_released'
  | 'deletion_eligible'
  | 'deletion_blocked_policy_missing'
  | 'deletion_blocked_legal_hold'
  | 'deleted'

export type AttachmentEvidence = Readonly<{
  id: string
  workflowId: string
  participantId: string
  sourceMessageReference: string
  providerReference: string
  declaredType: string
  detectedType: string
  sizeBytes: number
  contentHash: string
  storageReference: string
  createdAt: Date
}>

const text = (row: Record<string, unknown>, column: string): string => {
  const value = row[column]
  if (typeof value === 'string') return value
  throw new Error(`attachment query returned invalid ${column}`)
}

const date = (row: Record<string, unknown>, column: string): Date => {
  const value = row[column]
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value
  throw new Error(`attachment query returned invalid ${column}`)
}

const evidenceFromRow = (row: Record<string, unknown>): AttachmentEvidence => ({
  id: text(row, 'id'),
  workflowId: text(row, 'workflow_id'),
  participantId: text(row, 'participant_id'),
  sourceMessageReference: text(row, 'source_message_reference'),
  providerReference: text(row, 'provider_reference'),
  declaredType: text(row, 'declared_type'),
  detectedType: text(row, 'detected_type'),
  sizeBytes: Number(row.size_bytes),
  contentHash: text(row, 'content_hash'),
  storageReference: text(row, 'storage_reference'),
  createdAt: date(row, 'created_at'),
})

const EVIDENCE_COLUMNS = `id, workflow_id, participant_id, source_message_reference, provider_reference,
                          declared_type, detected_type, size_bytes, content_hash, storage_reference, created_at`

@Injectable()
export class AttachmentRepository {
  async workflowOwnedBy(tx: DbTransaction, workflowId: string, participantId: string): Promise<boolean> {
    const result = await tx.query(`SELECT 1 FROM workflow_instances WHERE id = $1 AND participant_id = $2`, [
      workflowId,
      participantId,
    ])
    return result.rows.length === 1
  }

  async findBySource(
    tx: DbTransaction,
    workflowId: string,
    providerReference: string,
  ): Promise<AttachmentEvidence | undefined> {
    const result = await tx.query(
      `SELECT ${EVIDENCE_COLUMNS} FROM attachments WHERE workflow_id = $1 AND provider_reference = $2`,
      [workflowId, providerReference],
    )
    const row = result.rows[0]
    return row === undefined ? undefined : evidenceFromRow(row)
  }

  async ownedEvidence(
    tx: DbTransaction,
    attachmentId: string,
    workflowId: string,
    participantId: string,
    lock = false,
  ): Promise<AttachmentEvidence | undefined> {
    const result = await tx.query(
      `SELECT ${EVIDENCE_COLUMNS}
         FROM attachments
        WHERE id = $1 AND workflow_id = $2 AND participant_id = $3${lock ? ' FOR UPDATE' : ''}`,
      [attachmentId, workflowId, participantId],
    )
    const row = result.rows[0]
    return row === undefined ? undefined : evidenceFromRow(row)
  }

  async createEvidence(tx: DbTransaction, input: Omit<AttachmentEvidence, 'id'>): Promise<AttachmentEvidence> {
    const result = await tx.query(
      `INSERT INTO attachments (
         workflow_id, participant_id, source_message_reference, provider_reference,
         declared_type, detected_type, size_bytes, content_hash, storage_reference, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING ${EVIDENCE_COLUMNS}`,
      [
        input.workflowId,
        input.participantId,
        input.sourceMessageReference,
        input.providerReference,
        input.declaredType,
        input.detectedType,
        input.sizeBytes,
        input.contentHash,
        input.storageReference,
        input.createdAt,
      ],
    )
    const row = result.rows[0]
    if (row === undefined) throw new Error('attachment insert returned no row')
    return evidenceFromRow(row)
  }

  async appendSecurityEvent(
    tx: DbTransaction,
    input: Readonly<{
      attachmentId: string
      state: AttachmentSecurityState
      reasonCode: string
      scannerProvider: string | null
      occurredAt: Date
    }>,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO attachment_security_events (
         attachment_id, state, reason_code, scanner_provider, occurred_at
       ) VALUES ($1,$2,$3,$4,$5)`,
      [input.attachmentId, input.state, input.reasonCode, input.scannerProvider, input.occurredAt],
    )
  }

  async currentSecurityState(tx: DbTransaction, attachmentId: string): Promise<AttachmentSecurityState | undefined> {
    const result = await tx.query(
      `SELECT state FROM attachment_security_events
        WHERE attachment_id = $1 ORDER BY occurred_at DESC, id DESC LIMIT 1`,
      [attachmentId],
    )
    const value = result.rows[0]?.state
    if (value === undefined) return undefined
    if (
      value === 'quarantined' ||
      value === 'scanning' ||
      value === 'clean' ||
      value === 'rejected' ||
      value === 'scan_failed'
    ) {
      return value
    }
    throw new Error('attachment security query returned invalid state')
  }

  async appendLifecycleEvent(
    tx: DbTransaction,
    input: Readonly<{
      attachmentId: string
      eventType: AttachmentLifecycleEventType
      reasonCode: string
      policyReference: string | null
      actorReference: string
      deduplicationKey: string
      occurredAt: Date
    }>,
  ): Promise<boolean> {
    const result = await tx.query(
      `INSERT INTO attachment_lifecycle_events (
         attachment_id, event_type, reason_code, policy_reference,
         actor_reference, deduplication_key, occurred_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (deduplication_key) DO NOTHING RETURNING id`,
      [
        input.attachmentId,
        input.eventType,
        input.reasonCode,
        input.policyReference,
        input.actorReference,
        input.deduplicationKey,
        input.occurredAt,
      ],
    )
    return result.rows.length === 1
  }

  async legalHoldActive(tx: DbTransaction, attachmentId: string): Promise<boolean> {
    const result = await tx.query(
      `SELECT event_type FROM attachment_lifecycle_events
        WHERE attachment_id = $1 AND event_type IN ('legal_hold_applied', 'legal_hold_released')
        ORDER BY occurred_at DESC, id DESC LIMIT 1`,
      [attachmentId],
    )
    return result.rows[0]?.event_type === 'legal_hold_applied'
  }

  async activeStorageReferenceCount(tx: DbTransaction, storageReference: string): Promise<number> {
    const result = await tx.query(
      `SELECT count(*)::integer AS count
         FROM attachments a
        WHERE a.storage_reference = $1
          AND NOT EXISTS (
            SELECT 1 FROM attachment_lifecycle_events e
             WHERE e.attachment_id = a.id AND e.event_type = 'deleted'
          )`,
      [storageReference],
    )
    return Number(result.rows[0]?.count ?? 0)
  }
}
