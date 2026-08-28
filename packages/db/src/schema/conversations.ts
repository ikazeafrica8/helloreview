import { sql } from 'drizzle-orm'
import { check, foreignKey, index, pgEnum, pgTable, text, unique, uuid, varchar } from 'drizzle-orm/pg-core'
import { tstz } from '../columns.js'
import { campaigns } from './campaigns.js'
import { eventInbox } from './event-inbox.js'
import { channelIdentities, participants } from './participants.js'
import { workflowInstances } from './workflow-instances.js'

// Durable inbound conversation and evidence history (T135, PRD §20.3, FR-ADM-004, FR-SC-001–004).
//
// WHAT WAS MISSING. Every business fact a participant produced was durable — selections, consents,
// addresses, reservations — while the conversation that produced them was not. An operator taking
// over could see that a reservation version existed and not that the participant had asked a
// question first, and an audit could not tell a provider's retry from a participant sending the
// same thing twice. `attachments.source_message_reference` has pointed at an inbound message since
// T88 without there being a table to point at.
//
// WHAT IS DELIBERATELY NOT HERE. No raw provider payload. The accepted envelope already lives in
// `event_inbox`, minimized by the T14 schemas, and copying it again would double the retention
// surface for nothing. No selection, identity-binding, or approval authority: secret-comment
// evidence is supporting evidence, and the CHECK below makes the alternative unstorable rather
// than merely discouraged.

/**
 * A conversation's current lifecycle position.
 *
 * `deleted_by_provider` is distinct from `closed_by_provider` because they are different facts: a
 * closed thread can be reopened and its history still reconciles, while a deleted one means the
 * provider will not serve it again and our copy is the only remaining record. Collapsing them would
 * make "why can we no longer fetch this?" unanswerable.
 */
export const conversationStateEnum = pgEnum('conversation_state', [
  'active',
  'closed_by_provider',
  'deleted_by_provider',
  'ambiguous',
])

/**
 * Why a conversation's bindings or lifecycle changed.
 *
 * Rebinding is a SEPARATE value from binding, deliberately. Overwriting `participant_id` in place
 * would erase the fact that we once believed the thread belonged to someone else — which is exactly
 * the fact an identity dispute needs.
 */
export const conversationEventTypeEnum = pgEnum('conversation_event_type', [
  'observed',
  'participant_bound',
  'participant_rebound',
  'workflow_bound',
  'workflow_rebound',
  'closed_by_provider',
  'deleted_by_provider',
  'marked_ambiguous',
  'ambiguity_resolved',
])

export const inboundMessageKindEnum = pgEnum('inbound_message_kind', ['text', 'attachment', 'mixed', 'unsupported'])

/**
 * One row per provider thread. Mutable head; its history is `conversation_events`.
 *
 * THE UNIQUE PAIR IS THE IDEMPOTENCY GUARANTEE, for the same reason `event_inbox` constrains
 * (source, external_event_id) rather than the id alone: two providers each numbering threads from 1
 * is ordinary, and a constraint on the conversation id alone would silently discard the second
 * provider's traffic while looking exactly like successful deduplication.
 */
export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** Normalized adapter namespace, matching `channel_identities.provider`. */
    provider: text('provider').notNull(),
    /** The provider's own thread identifier. Unique only inside the provider namespace. */
    providerConversationId: text('provider_conversation_id').notNull(),

    /** The verified channel identity, once one is known. Null while the thread is unattributed. */
    channelIdentityId: uuid('channel_identity_id').references(() => channelIdentities.id, { onDelete: 'restrict' }),
    participantId: uuid('participant_id').references(() => participants.id, { onDelete: 'restrict' }),
    campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'restrict' }),
    workflowId: uuid('workflow_id').references(() => workflowInstances.id, { onDelete: 'restrict' }),

    state: conversationStateEnum('state').notNull().default('active'),

    firstObservedAt: tstz('first_observed_at').notNull(),
    lastObservedAt: tstz('last_observed_at').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    unique('conversations_provider_thread_key').on(table.provider, table.providerConversationId),
    index('conversations_participant_idx').on(table.participantId, table.lastObservedAt),
    index('conversations_workflow_idx').on(table.workflowId, table.lastObservedAt),
    index('conversations_state_idx').on(table.state, table.lastObservedAt),
    check('conversations_valid_provider', sql`${table.provider} ~ '^[a-z][a-z0-9_.-]{2,63}$'`),
    check('conversations_valid_thread_id', sql`char_length(${table.providerConversationId}) between 1 and 512`),
    check('conversations_observation_order', sql`${table.lastObservedAt} >= ${table.firstObservedAt}`),
    // A workflow or channel identity without a participant would be a binding with no subject.
    check(
      'conversations_binding_coherence',
      sql`(${table.workflowId} is null or ${table.participantId} is not null)
          and (${table.channelIdentityId} is null or ${table.participantId} is not null)`,
    ),
  ],
)

/** Append-only. Every binding change and lifecycle transition, with the evidence that justified it. */
export const conversationEvents = pgTable(
  'conversation_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'restrict' }),
    eventType: conversationEventTypeEnum('event_type').notNull(),
    reasonCode: text('reason_code').notNull(),

    fromParticipantId: uuid('from_participant_id').references(() => participants.id, { onDelete: 'restrict' }),
    toParticipantId: uuid('to_participant_id').references(() => participants.id, { onDelete: 'restrict' }),
    fromWorkflowId: uuid('from_workflow_id').references(() => workflowInstances.id, { onDelete: 'restrict' }),
    toWorkflowId: uuid('to_workflow_id').references(() => workflowInstances.id, { onDelete: 'restrict' }),

    /** How the binding was justified, reusing the T29 identity evidence vocabulary. */
    evidenceCategory: text('evidence_category').notNull(),
    actorReference: text('actor_reference').notNull(),
    deduplicationKey: text('deduplication_key').notNull(),
    occurredAt: tstz('occurred_at').notNull(),
  },
  (table) => [
    unique('conversation_events_deduplication_key').on(table.deduplicationKey),
    index('conversation_events_timeline_idx').on(table.conversationId, table.occurredAt, table.id),
    check('conversation_events_reason_code', sql`${table.reasonCode} ~ '^[A-Z][A-Z0-9_]*$'`),
    check('conversation_events_evidence_category', sql`${table.evidenceCategory} ~ '^[A-Z][A-Z0-9_]*$'`),
    check('conversation_events_actor_length', sql`char_length(${table.actorReference}) between 1 and 200`),
    // A rebinding that does not name both sides, or names the same one twice, records nothing.
    check(
      'conversation_events_participant_rebind_evidence',
      sql`${table.eventType} <> 'participant_rebound'
          or (${table.fromParticipantId} is not null and ${table.toParticipantId} is not null
              and ${table.fromParticipantId} <> ${table.toParticipantId})`,
    ),
    check(
      'conversation_events_workflow_rebind_evidence',
      sql`${table.eventType} <> 'workflow_rebound'
          or (${table.fromWorkflowId} is not null and ${table.toWorkflowId} is not null
              and ${table.fromWorkflowId} <> ${table.toWorkflowId})`,
    ),
  ],
)

/**
 * Append-only. One row per provider message.
 *
 * `body_text` is `conversation_content` under the §21.6 retention classes and is never projected
 * into the operator timeline — the same treatment `outbound_notifications.rendered_content` already
 * gets. Reading it back requires a governed sensitive-access operation that does not exist yet.
 */
export const inboundMessages = pgTable(
  'inbound_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'restrict' }),
    providerMessageId: text('provider_message_id').notNull(),

    /** The accepted envelope that carried this message, tying delivery to inbox idempotency. */
    eventInboxId: uuid('event_inbox_id').references(() => eventInbox.id, { onDelete: 'restrict' }),

    participantId: uuid('participant_id').references(() => participants.id, { onDelete: 'restrict' }),
    workflowId: uuid('workflow_id').references(() => workflowInstances.id, { onDelete: 'restrict' }),

    messageKind: inboundMessageKindEnum('message_kind').notNull(),
    /** AI or deterministic classification. Evidence for routing, never authority over a decision. */
    classifiedPurposeCode: text('classified_purpose_code'),
    bodyText: text('body_text'),
    /** SHA-256 of the normalized body. Distinguishes a provider retry from a repeated participant message. */
    contentDigest: varchar('content_digest', { length: 64 }).notNull(),

    providerSentAt: tstz('provider_sent_at').notNull(),
    /** The gap between this and `provider_sent_at` is the delivery delay. */
    receivedAt: tstz('received_at').notNull(),
    supersedesMessageId: uuid('supersedes_message_id'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique('inbound_messages_conversation_provider_key').on(table.conversationId, table.providerMessageId),
    index('inbound_messages_thread_idx').on(table.conversationId, table.providerSentAt, table.id),
    index('inbound_messages_workflow_idx').on(table.workflowId, table.providerSentAt),
    index('inbound_messages_content_digest_idx').on(table.contentDigest),
    check('inbound_messages_provider_message_id', sql`char_length(${table.providerMessageId}) between 1 and 512`),
    check('inbound_messages_content_digest', sql`${table.contentDigest} ~ '^[a-f0-9]{64}$'`),
    check(
      'inbound_messages_purpose_code',
      sql`${table.classifiedPurposeCode} is null or ${table.classifiedPurposeCode} ~ '^[A-Z][A-Z0-9_:]*$'`,
    ),
    check(
      'inbound_messages_body_length',
      sql`${table.bodyText} is null or char_length(${table.bodyText}) between 1 and 8000`,
    ),
    check('inbound_messages_text_needs_body', sql`${table.messageKind} <> 'text' or ${table.bodyText} is not null`),
    check('inbound_messages_no_self_supersession', sql`${table.supersedesMessageId} is distinct from ${table.id}`),
    foreignKey({
      name: 'inbound_messages_supersedes_fk',
      columns: [table.supersedesMessageId],
      foreignColumns: [table.id],
    }).onDelete('restrict'),
  ],
)

export type ConversationRow = typeof conversations.$inferSelect
export type NewConversationRow = typeof conversations.$inferInsert
export type ConversationEventRow = typeof conversationEvents.$inferSelect
export type NewConversationEventRow = typeof conversationEvents.$inferInsert
export type InboundMessageRow = typeof inboundMessages.$inferSelect
export type NewInboundMessageRow = typeof inboundMessages.$inferInsert
