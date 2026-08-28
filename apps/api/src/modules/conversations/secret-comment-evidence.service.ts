import { Inject, Injectable } from '@nestjs/common'
import { POSTGRES_POOL, runInTransaction, type DbTransaction } from '@helloreview/db'
import type { Pool } from 'pg'
import { CONVERSATION_ERROR, ConversationServiceError } from './reason-codes.js'

export type SecretCommentEvidenceStatus = 'claimed' | 'screenshot_received' | 'superseded' | 'rejected'

export type SecretCommentEvidenceSnapshot = Readonly<{
  id: string
  workflowId: string
  participantId: string
  version: number
  status: SecretCommentEvidenceStatus
  inboundMessageId: string | null
  attachmentId: string | null
  reasonCode: string
  /** Always true. The column carries a CHECK that pins it, and no input can set it. */
  supportingOnly: true
  supersedesVersionId: string | null
  occurredAt: Date
}>

/**
 * Note what is absent: no application id, no selection outcome, no approval, no verification result.
 * A secret-comment claim is a hint that a deterministic service must still confirm, and a field that
 * does not exist cannot be set by a caller, a migration, or a future refactor that has forgotten why.
 */
export type AppendSecretCommentEvidenceInput = Readonly<{
  workflowId: string
  participantId: string
  status: SecretCommentEvidenceStatus
  inboundMessageId?: string | null
  attachmentId?: string | null
  reasonCode: string
  actorReference: string
  occurredAt: Date
}>

const CODE = /^[A-Z][A-Z0-9_]*$/

const COLUMNS = `id, workflow_id, participant_id, version, status, inbound_message_id, attachment_id,
                 reason_code, supporting_only, supersedes_version_id, occurred_at`

const asString = (row: Record<string, unknown>, column: string): string => {
  const value = row[column]
  if (typeof value === 'string') return value
  throw new Error(`secret comment evidence query returned invalid ${column}`)
}

const nullableString = (value: unknown): string | null => (typeof value === 'string' ? value : null)

const asStatus = (value: unknown): SecretCommentEvidenceStatus => {
  if (value === 'claimed' || value === 'screenshot_received' || value === 'superseded' || value === 'rejected')
    return value
  throw new Error('secret comment evidence query returned invalid status')
}

const snapshot = (row: Record<string, unknown>): SecretCommentEvidenceSnapshot => {
  const occurredAt = row.occurred_at
  const version = row.version
  if (!(occurredAt instanceof Date)) throw new Error('secret comment evidence query returned invalid occurred_at')
  if (typeof version !== 'number' || !Number.isSafeInteger(version))
    throw new Error('secret comment evidence query returned invalid version')
  if (row.supporting_only !== true) throw new Error('secret comment evidence is not supporting-only')
  return {
    id: asString(row, 'id'),
    workflowId: asString(row, 'workflow_id'),
    participantId: asString(row, 'participant_id'),
    version,
    status: asStatus(row.status),
    inboundMessageId: nullableString(row.inbound_message_id),
    attachmentId: nullableString(row.attachment_id),
    reasonCode: asString(row, 'reason_code'),
    supportingOnly: true,
    supersedesVersionId: nullableString(row.supersedes_version_id),
    occurredAt,
  }
}

/**
 * Immutable versions of a participant's secret-comment claim and its screenshot evidence.
 *
 * Versions supersede rather than replace: a replacement screenshot appends a new version pointing at
 * the previous one, so an operator can see that the participant sent a different image the second
 * time. Nothing here verifies the claim, binds an application, or authorizes selection — that stays
 * with the deterministic services and the operator, and T145 owns any automated reading of the
 * screenshot itself.
 */
@Injectable()
export class SecretCommentEvidenceService {
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  async append(input: AppendSecretCommentEvidenceInput): Promise<SecretCommentEvidenceSnapshot> {
    if (!CODE.test(input.reasonCode)) throw new ConversationServiceError(CONVERSATION_ERROR.REASON_CODE_INVALID)
    if (input.actorReference.length < 1 || input.actorReference.length > 200)
      throw new ConversationServiceError(CONVERSATION_ERROR.ACTOR_REFERENCE_INVALID)
    if (input.status === 'screenshot_received' && (input.attachmentId ?? null) === null)
      throw new ConversationServiceError(CONVERSATION_ERROR.EVIDENCE_SCREENSHOT_REQUIRED)

    return runInTransaction(this.pool, async (tx) => {
      const workflow = await tx.query(`SELECT participant_id FROM workflow_instances WHERE id = $1 FOR UPDATE`, [
        input.workflowId,
      ])
      const workflowRow = workflow.rows[0]
      if (workflowRow === undefined) throw new ConversationServiceError(CONVERSATION_ERROR.NOT_FOUND)
      if (workflowRow.participant_id !== input.participantId)
        throw new ConversationServiceError(CONVERSATION_ERROR.EVIDENCE_WORKFLOW_MISMATCH)

      const head = await this.head(tx, input.workflowId)
      if (head !== null && input.occurredAt.getTime() < head.occurredAt.getTime())
        throw new ConversationServiceError(CONVERSATION_ERROR.EVIDENCE_STALE_EVENT)

      const inserted = await tx.query(
        `INSERT INTO secret_comment_evidence_versions (
           workflow_id, participant_id, version, status, inbound_message_id, attachment_id,
           reason_code, supersedes_version_id, actor_reference, occurred_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING ${COLUMNS}`,
        [
          input.workflowId,
          input.participantId,
          head === null ? 1 : head.version + 1,
          input.status,
          input.inboundMessageId ?? null,
          input.attachmentId ?? null,
          input.reasonCode,
          head?.id ?? null,
          input.actorReference,
          input.occurredAt,
        ],
      )
      const row = inserted.rows[0]
      if (row === undefined) throw new Error('secret comment evidence version was not visible')
      return snapshot(row)
    })
  }

  async current(workflowId: string): Promise<SecretCommentEvidenceSnapshot | null> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM secret_comment_evidence_versions
        WHERE workflow_id = $1 ORDER BY version DESC LIMIT 1`,
      [workflowId],
    )
    const row = result.rows[0]
    return row === undefined ? null : snapshot(row)
  }

  async history(workflowId: string): Promise<readonly SecretCommentEvidenceSnapshot[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM secret_comment_evidence_versions WHERE workflow_id = $1 ORDER BY version ASC`,
      [workflowId],
    )
    return result.rows.map(snapshot)
  }

  private async head(
    tx: DbTransaction,
    workflowId: string,
  ): Promise<Readonly<{ id: string; version: number; occurredAt: Date }> | null> {
    const result = await tx.query(
      `SELECT id, version, occurred_at FROM secret_comment_evidence_versions
        WHERE workflow_id = $1 ORDER BY version DESC LIMIT 1`,
      [workflowId],
    )
    const row = result.rows[0]
    if (row === undefined) return null
    const version = row.version
    const occurredAt = row.occurred_at
    if (typeof version !== 'number' || !(occurredAt instanceof Date))
      throw new Error('secret comment evidence query returned an invalid head')
    return { id: asString(row, 'id'), version, occurredAt }
  }
}
