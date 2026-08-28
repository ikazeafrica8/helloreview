import { createHash } from 'node:crypto'
import { Inject, Injectable } from '@nestjs/common'
import { POSTGRES_POOL, runInTransaction, type DbTransaction } from '@helloreview/db'
import type { Pool } from 'pg'
import { CONVERSATION_ERROR, CONVERSATION_REASON, ConversationServiceError } from './reason-codes.js'

export type ConversationState = 'active' | 'closed_by_provider' | 'deleted_by_provider' | 'ambiguous'

export type ConversationSnapshot = Readonly<{
  id: string
  provider: string
  providerConversationId: string
  channelIdentityId: string | null
  participantId: string | null
  campaignId: string | null
  workflowId: string | null
  state: ConversationState
  firstObservedAt: Date
  lastObservedAt: Date
}>

export type ObserveConversationInput = Readonly<{
  provider: string
  providerConversationId: string
  observedAt: Date
  actorReference: string
}>

export type BindConversationParticipantInput = Readonly<{
  conversationId: string
  participantId: string
  channelIdentityId?: string | null
  campaignId?: string | null
  /** How the binding was justified. Reuses the T29 identity evidence vocabulary. */
  evidenceCategory: string
  actorReference: string
  occurredAt: Date
}>

export type BindConversationWorkflowInput = Readonly<{
  conversationId: string
  workflowId: string
  evidenceCategory: string
  actorReference: string
  occurredAt: Date
}>

export type ConversationLifecycleInput = Readonly<{
  conversationId: string
  state: Exclude<ConversationState, 'active'> | 'active'
  evidenceCategory: string
  actorReference: string
  occurredAt: Date
}>

const PROVIDER = /^[a-z][a-z0-9_.-]{2,63}$/
const CODE = /^[A-Z][A-Z0-9_]*$/

const digest = (value: string): string => createHash('sha256').update(value).digest('hex')

const asString = (row: Record<string, unknown>, column: string): string => {
  const value = row[column]
  if (typeof value === 'string') return value
  throw new Error(`conversation query returned invalid ${column}`)
}

const nullableString = (value: unknown): string | null => (typeof value === 'string' ? value : null)

const asDate = (row: Record<string, unknown>, column: string): Date => {
  const value = row[column]
  if (value instanceof Date) return value
  throw new Error(`conversation query returned invalid ${column}`)
}

const asState = (value: unknown): ConversationState => {
  if (value === 'active' || value === 'closed_by_provider' || value === 'deleted_by_provider' || value === 'ambiguous')
    return value
  throw new Error('conversation query returned invalid state')
}

const snapshot = (row: Record<string, unknown>): ConversationSnapshot => ({
  id: asString(row, 'id'),
  provider: asString(row, 'provider'),
  providerConversationId: asString(row, 'provider_conversation_id'),
  channelIdentityId: nullableString(row.channel_identity_id),
  participantId: nullableString(row.participant_id),
  campaignId: nullableString(row.campaign_id),
  workflowId: nullableString(row.workflow_id),
  state: asState(row.state),
  firstObservedAt: asDate(row, 'first_observed_at'),
  lastObservedAt: asDate(row, 'last_observed_at'),
})

const COLUMNS = `id, provider, provider_conversation_id, channel_identity_id, participant_id,
                 campaign_id, workflow_id, state, first_observed_at, last_observed_at`

/**
 * The durable record of a provider conversation thread and how it came to be attributed.
 *
 * This service owns the mutable head and its append-only history together, in one transaction, so
 * the two cannot disagree. It does NOT decide who a conversation belongs to — identity resolution
 * does that (T28–T31) and hands the decision here with the evidence category that justified it.
 * Nothing in this module reads or writes a workflow state dimension, sends a message, or lets a
 * classification bind an application.
 */
@Injectable()
export class ConversationService {
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  /**
   * Idempotent first sight of a thread.
   *
   * The unique (provider, provider_conversation_id) pair is what makes this safe under a provider
   * retry: the second call updates `last_observed_at` and returns the same row rather than creating
   * a rival conversation for the same thread.
   */
  async observe(
    input: ObserveConversationInput,
  ): Promise<Readonly<{ conversation: ConversationSnapshot; created: boolean }>> {
    if (!PROVIDER.test(input.provider)) throw new ConversationServiceError(CONVERSATION_ERROR.PROVIDER_INVALID)
    if (input.providerConversationId.length < 1 || input.providerConversationId.length > 512)
      throw new ConversationServiceError(CONVERSATION_ERROR.THREAD_ID_INVALID)
    this.assertActorReference(input.actorReference)

    return runInTransaction(this.pool, async (tx) => {
      const inserted = await tx.query(
        `INSERT INTO conversations (provider, provider_conversation_id, first_observed_at, last_observed_at)
         VALUES ($1,$2,$3,$3)
         ON CONFLICT (provider, provider_conversation_id) DO NOTHING
         RETURNING ${COLUMNS}`,
        [input.provider, input.providerConversationId, input.observedAt],
      )
      const created = inserted.rows[0] !== undefined
      if (created) {
        const conversation = snapshot(inserted.rows[0] ?? {})
        await this.appendEvent(tx, {
          conversationId: conversation.id,
          eventType: 'observed',
          reasonCode: CONVERSATION_REASON.OBSERVED,
          evidenceCategory: 'PROVIDER_DELIVERY',
          actorReference: input.actorReference,
          occurredAt: input.observedAt,
          deduplicationKey: digest(`conversation-observed|${conversation.id}`),
        })
        return { conversation, created }
      }
      // A later delivery only moves the observation window forward; an out-of-order redelivery
      // must not rewind it, so GREATEST rather than an assignment.
      const updated = await tx.query(
        `UPDATE conversations
            SET last_observed_at = GREATEST(last_observed_at, $3::timestamptz), updated_at = $3
          WHERE provider = $1 AND provider_conversation_id = $2
        RETURNING ${COLUMNS}`,
        [input.provider, input.providerConversationId, input.observedAt],
      )
      const row = updated.rows[0]
      if (row === undefined) throw new ConversationServiceError(CONVERSATION_ERROR.NOT_FOUND)
      return { conversation: snapshot(row), created }
    })
  }

  /**
   * Attribute a thread to a participant, or move it to a different one.
   *
   * A rebinding is a separate event type carrying both sides, because the previous belief is
   * evidence: an identity dispute needs to see that we once routed this thread elsewhere, and an
   * in-place overwrite would destroy exactly that.
   */
  async bindParticipant(input: BindConversationParticipantInput): Promise<ConversationSnapshot> {
    this.assertEvidence(input.evidenceCategory, input.actorReference)
    return runInTransaction(this.pool, async (tx) => {
      const current = await this.lock(tx, input.conversationId)
      if (
        current.participantId === input.participantId &&
        current.channelIdentityId === (input.channelIdentityId ?? current.channelIdentityId)
      )
        throw new ConversationServiceError(CONVERSATION_ERROR.BINDING_UNCHANGED)
      const rebinding = current.participantId !== null && current.participantId !== input.participantId
      const updated = await tx.query(
        `UPDATE conversations
            SET participant_id = $2,
                channel_identity_id = COALESCE($3, channel_identity_id),
                campaign_id = COALESCE($4, campaign_id),
                updated_at = $5
          WHERE id = $1
        RETURNING ${COLUMNS}`,
        [
          input.conversationId,
          input.participantId,
          input.channelIdentityId ?? null,
          input.campaignId ?? null,
          input.occurredAt,
        ],
      )
      const row = updated.rows[0]
      if (row === undefined) throw new ConversationServiceError(CONVERSATION_ERROR.NOT_FOUND)
      await this.appendEvent(tx, {
        conversationId: input.conversationId,
        eventType: rebinding ? 'participant_rebound' : 'participant_bound',
        reasonCode: rebinding ? CONVERSATION_REASON.PARTICIPANT_REBOUND : CONVERSATION_REASON.PARTICIPANT_BOUND,
        evidenceCategory: input.evidenceCategory,
        actorReference: input.actorReference,
        occurredAt: input.occurredAt,
        fromParticipantId: rebinding ? current.participantId : null,
        toParticipantId: input.participantId,
        deduplicationKey: digest(
          `conversation-participant|${input.conversationId}|${current.participantId ?? 'none'}|${input.participantId}`,
        ),
      })
      return snapshot(row)
    })
  }

  /** A workflow binding requires a participant binding first; the CHECK enforces it, this explains it. */
  async bindWorkflow(input: BindConversationWorkflowInput): Promise<ConversationSnapshot> {
    this.assertEvidence(input.evidenceCategory, input.actorReference)
    return runInTransaction(this.pool, async (tx) => {
      const current = await this.lock(tx, input.conversationId)
      if (current.participantId === null) throw new ConversationServiceError(CONVERSATION_ERROR.PARTICIPANT_REQUIRED)
      if (current.workflowId === input.workflowId)
        throw new ConversationServiceError(CONVERSATION_ERROR.BINDING_UNCHANGED)
      const rebinding = current.workflowId !== null
      const updated = await tx.query(
        `UPDATE conversations SET workflow_id = $2, updated_at = $3 WHERE id = $1 RETURNING ${COLUMNS}`,
        [input.conversationId, input.workflowId, input.occurredAt],
      )
      const row = updated.rows[0]
      if (row === undefined) throw new ConversationServiceError(CONVERSATION_ERROR.NOT_FOUND)
      await this.appendEvent(tx, {
        conversationId: input.conversationId,
        eventType: rebinding ? 'workflow_rebound' : 'workflow_bound',
        reasonCode: rebinding ? CONVERSATION_REASON.WORKFLOW_REBOUND : CONVERSATION_REASON.WORKFLOW_BOUND,
        evidenceCategory: input.evidenceCategory,
        actorReference: input.actorReference,
        occurredAt: input.occurredAt,
        fromWorkflowId: rebinding ? current.workflowId : null,
        toWorkflowId: input.workflowId,
        deduplicationKey: digest(
          `conversation-workflow|${input.conversationId}|${current.workflowId ?? 'none'}|${input.workflowId}`,
        ),
      })
      return snapshot(row)
    })
  }

  /**
   * Provider-driven and operator-driven lifecycle transitions.
   *
   * `deleted_by_provider` is terminal: once the provider says the thread is gone, our copy is the
   * only record and reopening it would assert something we cannot verify.
   */
  async recordLifecycle(input: ConversationLifecycleInput): Promise<ConversationSnapshot> {
    this.assertEvidence(input.evidenceCategory, input.actorReference)
    return runInTransaction(this.pool, async (tx) => {
      const current = await this.lock(tx, input.conversationId)
      if (current.state === 'deleted_by_provider') throw new ConversationServiceError(CONVERSATION_ERROR.TERMINAL_STATE)
      if (current.state === input.state) throw new ConversationServiceError(CONVERSATION_ERROR.BINDING_UNCHANGED)
      const eventType =
        input.state === 'closed_by_provider'
          ? 'closed_by_provider'
          : input.state === 'deleted_by_provider'
            ? 'deleted_by_provider'
            : input.state === 'ambiguous'
              ? 'marked_ambiguous'
              : 'ambiguity_resolved'
      const reasonCode =
        input.state === 'closed_by_provider'
          ? CONVERSATION_REASON.CLOSED_BY_PROVIDER
          : input.state === 'deleted_by_provider'
            ? CONVERSATION_REASON.DELETED_BY_PROVIDER
            : input.state === 'ambiguous'
              ? CONVERSATION_REASON.MARKED_AMBIGUOUS
              : CONVERSATION_REASON.AMBIGUITY_RESOLVED
      const updated = await tx.query(
        `UPDATE conversations SET state = $2, updated_at = $3 WHERE id = $1 RETURNING ${COLUMNS}`,
        [input.conversationId, input.state, input.occurredAt],
      )
      const row = updated.rows[0]
      if (row === undefined) throw new ConversationServiceError(CONVERSATION_ERROR.NOT_FOUND)
      await this.appendEvent(tx, {
        conversationId: input.conversationId,
        eventType,
        reasonCode,
        evidenceCategory: input.evidenceCategory,
        actorReference: input.actorReference,
        occurredAt: input.occurredAt,
        deduplicationKey: digest(`conversation-lifecycle|${input.conversationId}|${current.state}|${input.state}`),
      })
      return snapshot(row)
    })
  }

  async current(provider: string, providerConversationId: string): Promise<ConversationSnapshot | null> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM conversations WHERE provider = $1 AND provider_conversation_id = $2`,
      [provider, providerConversationId],
    )
    const row = result.rows[0]
    return row === undefined ? null : snapshot(row)
  }

  /** Coded history only. No message body ever reaches this projection. */
  async history(
    conversationId: string,
  ): Promise<
    readonly Readonly<{ eventType: string; reasonCode: string; evidenceCategory: string; occurredAt: Date }>[]
  > {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT event_type, reason_code, evidence_category, occurred_at
         FROM conversation_events WHERE conversation_id = $1 ORDER BY occurred_at ASC, id ASC`,
      [conversationId],
    )
    return result.rows.map((row) => ({
      eventType: asString(row, 'event_type'),
      reasonCode: asString(row, 'reason_code'),
      evidenceCategory: asString(row, 'evidence_category'),
      occurredAt: asDate(row, 'occurred_at'),
    }))
  }

  private async lock(tx: DbTransaction, conversationId: string): Promise<ConversationSnapshot> {
    const result = await tx.query(`SELECT ${COLUMNS} FROM conversations WHERE id = $1 FOR UPDATE`, [conversationId])
    const row = result.rows[0]
    if (row === undefined) throw new ConversationServiceError(CONVERSATION_ERROR.NOT_FOUND)
    return snapshot(row)
  }

  private assertActorReference(actorReference: string): void {
    if (actorReference.length < 1 || actorReference.length > 200)
      throw new ConversationServiceError(CONVERSATION_ERROR.ACTOR_REFERENCE_INVALID)
  }

  private assertEvidence(evidenceCategory: string, actorReference: string): void {
    if (!CODE.test(evidenceCategory)) throw new ConversationServiceError(CONVERSATION_ERROR.EVIDENCE_CATEGORY_INVALID)
    this.assertActorReference(actorReference)
  }

  private async appendEvent(
    tx: DbTransaction,
    event: Readonly<{
      conversationId: string
      eventType: string
      reasonCode: string
      evidenceCategory: string
      actorReference: string
      occurredAt: Date
      deduplicationKey: string
      fromParticipantId?: string | null
      toParticipantId?: string | null
      fromWorkflowId?: string | null
      toWorkflowId?: string | null
    }>,
  ): Promise<void> {
    // ON CONFLICT DO NOTHING, not an error: a replayed binding decision is the same fact arriving
    // twice, and refusing it would turn a safe retry into an incident.
    await tx.query(
      `INSERT INTO conversation_events (
         conversation_id, event_type, reason_code, from_participant_id, to_participant_id,
         from_workflow_id, to_workflow_id, evidence_category, actor_reference,
         deduplication_key, occurred_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (deduplication_key) DO NOTHING`,
      [
        event.conversationId,
        event.eventType,
        event.reasonCode,
        event.fromParticipantId ?? null,
        event.toParticipantId ?? null,
        event.fromWorkflowId ?? null,
        event.toWorkflowId ?? null,
        event.evidenceCategory,
        event.actorReference,
        event.deduplicationKey,
        event.occurredAt,
      ],
    )
  }
}
