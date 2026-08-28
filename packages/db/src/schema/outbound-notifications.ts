import { sql } from 'drizzle-orm'
import { check, index, integer, pgEnum, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { tstz } from '../columns.js'
import { conversations } from './conversations.js'
import { messageTemplates } from './message-templates.js'
import { workflowInstances } from './workflow-instances.js'

export const outboundNotificationStatusEnum = pgEnum('outbound_notification_status', [
  'pending',
  'claimed',
  'sending',
  'accepted',
  'unknown',
  'delivered',
  'failed',
  'suppressed',
])

export const outboundIntentSourceEnum = pgEnum('outbound_intent_source', ['automated', 'operator', 'system_notice'])

export const outboundNotificationEventTypeEnum = pgEnum('outbound_notification_event_type', [
  'created',
  'claimed',
  'send_started',
  'send_accepted',
  'delivery_unknown',
  'delivered',
  'failed',
  'retry_scheduled',
  'suppressed',
])

/** Durable transactional outbox and current delivery projection (PRD §17.2, FR-MSG-003/004). */
export const outboundNotifications = pgTable(
  'outbound_notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflowInstances.id, { onDelete: 'restrict' }),
    /** The conversation this message belongs to (T135). Nullable: not every purpose has a thread. */
    conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'restrict' }),
    channel: text('channel').notNull(),
    recipientReference: text('recipient_reference').notNull(),
    purposeCode: text('purpose_code').notNull(),
    contentVersion: text('content_version').notNull(),
    businessEventVersion: text('business_event_version'),
    authorizedRedeliveryId: text('authorized_redelivery_id'),
    deduplicationKey: text('deduplication_key').notNull(),
    intentSource: outboundIntentSourceEnum('intent_source').notNull(),

    templateId: uuid('template_id')
      .notNull()
      .references(() => messageTemplates.id, { onDelete: 'restrict' }),
    templateVersion: integer('template_version').notNull(),
    renderedContent: text('rendered_content').notNull(),
    providerTemplateCode: text('provider_template_code'),

    providerName: text('provider_name'),
    providerMessageId: text('provider_message_id'),
    status: outboundNotificationStatusEnum('status').notNull().default('pending'),
    retryCount: integer('retry_count').notNull().default(0),
    suppressionReason: text('suppression_reason'),
    lastFailureCode: text('last_failure_code'),
    nextAttemptAt: tstz('next_attempt_at').notNull(),
    claimedAt: tstz('claimed_at'),
    claimedBy: text('claimed_by'),
    lastAttemptAt: tstz('last_attempt_at'),
    deliveredAt: tstz('delivered_at'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    unique('outbound_notifications_deduplication_key_key').on(table.deduplicationKey),
    index('outbound_notifications_dispatch_idx').on(table.status, table.nextAttemptAt, table.createdAt),
    index('outbound_notifications_workflow_idx').on(table.workflowId, table.createdAt),
    index('outbound_notifications_conversation_idx').on(table.conversationId, table.createdAt),
    index('outbound_notifications_provider_message_idx').on(table.providerName, table.providerMessageId),
    check('outbound_notifications_positive_template_version', sql`${table.templateVersion} > 0`),
    check('outbound_notifications_nonnegative_retry_count', sql`${table.retryCount} >= 0`),
    check('outbound_notifications_channel_code', sql`${table.channel} ~ '^[A-Z][A-Z0-9_]*$'`),
    check('outbound_notifications_purpose_code', sql`${table.purposeCode} ~ '^[A-Z][A-Z0-9_:]*$'`),
    check('outbound_notifications_nonempty_recipient', sql`length(btrim(${table.recipientReference})) > 0`),
    check('outbound_notifications_nonempty_content', sql`length(${table.renderedContent}) > 0`),
    check(
      'outbound_notifications_suppression_coherence',
      sql`(${table.status} = 'suppressed') = (${table.suppressionReason} is not null)`,
    ),
    check(
      'outbound_notifications_claim_coherence',
      sql`(${table.status} in ('claimed', 'sending')) = (${table.claimedAt} is not null and ${table.claimedBy} is not null)`,
    ),
    check(
      'outbound_notifications_delivery_evidence',
      sql`${table.status} <> 'delivered' or (${table.providerMessageId} is not null and ${table.deliveredAt} is not null)`,
    ),
  ],
)

/** Append-only evidence for every outbox state change, including suppression reasons. */
export const outboundNotificationEvents = pgTable(
  'outbound_notification_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    notificationId: uuid('notification_id')
      .notNull()
      .references(() => outboundNotifications.id, { onDelete: 'restrict' }),
    eventType: outboundNotificationEventTypeEnum('event_type').notNull(),
    status: outboundNotificationStatusEnum('status').notNull(),
    reasonCode: text('reason_code').notNull(),
    providerMessageId: text('provider_message_id'),
    retryCount: integer('retry_count').notNull().default(0),
    actorId: text('actor_id').notNull(),
    occurredAt: tstz('occurred_at').notNull(),
  },
  (table) => [
    index('outbound_notification_events_timeline_idx').on(table.notificationId, table.occurredAt),
    check('outbound_notification_events_reason_code', sql`${table.reasonCode} ~ '^[A-Z][A-Z0-9_]*$'`),
    check('outbound_notification_events_nonnegative_retry_count', sql`${table.retryCount} >= 0`),
  ],
)

/** Human ownership lease. A partial unique index permits only one active holder per workflow. */
export const operatorAssignments = pgTable(
  'operator_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflowInstances.id, { onDelete: 'restrict' }),
    operatorId: text('operator_id').notNull(),
    reasonCode: text('reason_code').notNull(),
    startedAt: tstz('started_at').notNull(),
    endedAt: tstz('ended_at'),
    endedBy: text('ended_by'),
  },
  (table) => [
    uniqueIndex('operator_assignments_one_active_idx')
      .on(table.workflowId)
      .where(sql`${table.endedAt} is null`),
    index('operator_assignments_timeline_idx').on(table.workflowId, table.startedAt),
    check('operator_assignments_reason_code', sql`${table.reasonCode} ~ '^[A-Z][A-Z0-9_]*$'`),
    check(
      'operator_assignments_end_coherence',
      sql`(${table.endedAt} is null and ${table.endedBy} is null) or (${table.endedAt} is not null and ${table.endedBy} is not null)`,
    ),
  ],
)

export type OutboundNotificationRow = typeof outboundNotifications.$inferSelect
export type NewOutboundNotificationRow = typeof outboundNotifications.$inferInsert
export type OutboundNotificationEventRow = typeof outboundNotificationEvents.$inferSelect
export type OperatorAssignmentRow = typeof operatorAssignments.$inferSelect
