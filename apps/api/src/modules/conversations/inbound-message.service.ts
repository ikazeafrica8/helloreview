import { createHash } from 'node:crypto'
import { Inject, Injectable } from '@nestjs/common'
import { POSTGRES_POOL, runInTransaction } from '@helloreview/db'
import type { Pool } from 'pg'
import { CONVERSATION_ERROR, ConversationServiceError } from './reason-codes.js'

export type InboundMessageKind = 'text' | 'attachment' | 'mixed' | 'unsupported'

export type InboundMessageSnapshot = Readonly<{
  id: string
  conversationId: string
  providerMessageId: string
  eventInboxId: string | null
  participantId: string | null
  workflowId: string | null
  messageKind: InboundMessageKind
  classifiedPurposeCode: string | null
  contentDigest: string
  providerSentAt: Date
  receivedAt: Date
  supersedesMessageId: string | null
}>

export type RecordInboundMessageInput = Readonly<{
  conversationId: string
  providerMessageId: string
  eventInboxId?: string | null
  participantId?: string | null
  workflowId?: string | null
  messageKind: InboundMessageKind
  /** Participant text. Stored as `conversation_content`; no read path in this module returns it. */
  bodyText?: string | null
  /** Evidence for routing only. It can never decide a protected state. */
  classifiedPurposeCode?: string | null
  providerSentAt: Date
  receivedAt: Date
  supersedesMessageId?: string | null
}>

export type RecordedInboundMessage = Readonly<{
  message: InboundMessageSnapshot
  /** True when the provider redelivered a message identity we already hold. */
  deduplicated: boolean
}>

const PURPOSE = /^[A-Z][A-Z0-9_:]*$/
const MAXIMUM_BODY_CHARACTERS = 8_000

const COLUMNS = `id, conversation_id, provider_message_id, event_inbox_id, participant_id, workflow_id,
                 message_kind, classified_purpose_code, content_digest, provider_sent_at, received_at,
                 supersedes_message_id`

const asString = (row: Record<string, unknown>, column: string): string => {
  const value = row[column]
  if (typeof value === 'string') return value
  throw new Error(`inbound message query returned invalid ${column}`)
}

const nullableString = (value: unknown): string | null => (typeof value === 'string' ? value : null)

const asDate = (row: Record<string, unknown>, column: string): Date => {
  const value = row[column]
  if (value instanceof Date) return value
  throw new Error(`inbound message query returned invalid ${column}`)
}

const asKind = (value: unknown): InboundMessageKind => {
  if (value === 'text' || value === 'attachment' || value === 'mixed' || value === 'unsupported') return value
  throw new Error('inbound message query returned invalid message_kind')
}

const snapshot = (row: Record<string, unknown>): InboundMessageSnapshot => ({
  id: asString(row, 'id'),
  conversationId: asString(row, 'conversation_id'),
  providerMessageId: asString(row, 'provider_message_id'),
  eventInboxId: nullableString(row.event_inbox_id),
  participantId: nullableString(row.participant_id),
  workflowId: nullableString(row.workflow_id),
  messageKind: asKind(row.message_kind),
  classifiedPurposeCode: nullableString(row.classified_purpose_code),
  contentDigest: asString(row, 'content_digest'),
  providerSentAt: asDate(row, 'provider_sent_at'),
  receivedAt: asDate(row, 'received_at'),
  supersedesMessageId: nullableString(row.supersedes_message_id),
})

/**
 * The durable record of what a participant actually sent.
 *
 * TWO KINDS OF DUPLICATE, and they are not the same fact. A provider redelivering message `m1` is
 * ONE message arriving twice — the unique (conversation_id, provider_message_id) pair collapses it
 * and `deduplicated` says so. A participant sending the same words again is TWO messages, and
 * `content_digest` lets an operator see that without the two being merged. Collapsing the second
 * case would lose a real participant action.
 *
 * The digest is computed HERE, from the normalized body, rather than accepted from the caller. A
 * caller-supplied digest could be made to match anything, and duplicate detection that a caller can
 * steer is not duplicate detection.
 */
@Injectable()
export class InboundMessageService {
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  async record(input: RecordInboundMessageInput): Promise<RecordedInboundMessage> {
    if (input.providerMessageId.length < 1 || input.providerMessageId.length > 512)
      throw new ConversationServiceError(CONVERSATION_ERROR.MESSAGE_ID_INVALID)
    const bodyText = input.bodyText ?? null
    if (input.messageKind === 'text' && (bodyText === null || bodyText.length === 0))
      throw new ConversationServiceError(CONVERSATION_ERROR.MESSAGE_BODY_REQUIRED)
    if (bodyText !== null && bodyText.length > MAXIMUM_BODY_CHARACTERS)
      throw new ConversationServiceError(CONVERSATION_ERROR.MESSAGE_BODY_TOO_LONG)
    if (input.classifiedPurposeCode != null && !PURPOSE.test(input.classifiedPurposeCode))
      throw new ConversationServiceError(CONVERSATION_ERROR.MESSAGE_PURPOSE_INVALID)
    if (Number.isNaN(input.providerSentAt.getTime()) || Number.isNaN(input.receivedAt.getTime()))
      throw new ConversationServiceError(CONVERSATION_ERROR.MESSAGE_TIME_INVALID)

    const contentDigest = createHash('sha256')
      .update(`${input.messageKind}|${bodyText === null ? '' : bodyText.normalize('NFKC').trim()}`)
      .digest('hex')

    return runInTransaction(this.pool, async (tx) => {
      const inserted = await tx.query(
        `INSERT INTO inbound_messages (
           conversation_id, provider_message_id, event_inbox_id, participant_id, workflow_id,
           message_kind, classified_purpose_code, body_text, content_digest,
           provider_sent_at, received_at, supersedes_message_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (conversation_id, provider_message_id) DO NOTHING
         RETURNING ${COLUMNS}`,
        [
          input.conversationId,
          input.providerMessageId,
          input.eventInboxId ?? null,
          input.participantId ?? null,
          input.workflowId ?? null,
          input.messageKind,
          input.classifiedPurposeCode ?? null,
          bodyText,
          contentDigest,
          input.providerSentAt,
          input.receivedAt,
          input.supersedesMessageId ?? null,
        ],
      )
      const row = inserted.rows[0]
      if (row !== undefined) return { message: snapshot(row), deduplicated: false }

      const existing = await tx.query(
        `SELECT ${COLUMNS} FROM inbound_messages WHERE conversation_id = $1 AND provider_message_id = $2`,
        [input.conversationId, input.providerMessageId],
      )
      const existingRow = existing.rows[0]
      if (existingRow === undefined) throw new ConversationServiceError(CONVERSATION_ERROR.NOT_FOUND)
      return { message: snapshot(existingRow), deduplicated: true }
    })
  }

  /** Coded metadata only. `body_text` is deliberately absent from every column list in this file. */
  async thread(conversationId: string): Promise<readonly InboundMessageSnapshot[]> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM inbound_messages WHERE conversation_id = $1
        ORDER BY provider_sent_at ASC, id ASC`,
      [conversationId],
    )
    return result.rows.map(snapshot)
  }

  /**
   * How many times this exact content already arrived in this thread.
   *
   * Lets a caller tell "the participant repeated themselves" from "the provider retried" without
   * either being silently merged.
   */
  async repeatedContentCount(conversationId: string, contentDigest: string): Promise<number> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT count(*)::integer AS count FROM inbound_messages
        WHERE conversation_id = $1 AND content_digest = $2`,
      [conversationId, contentDigest],
    )
    const value = result.rows[0]?.count
    return typeof value === 'number' ? value : 0
  }
}
