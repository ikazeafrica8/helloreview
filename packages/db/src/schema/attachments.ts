import { sql } from 'drizzle-orm'
import { check, index, integer, pgEnum, pgTable, text, unique, uuid, varchar } from 'drizzle-orm/pg-core'
import { tstz } from '../columns.js'
import { participants } from './participants.js'
import { workflowInstances } from './workflow-instances.js'

export const attachmentSecurityStateEnum = pgEnum('attachment_security_state', [
  'quarantined',
  'scanning',
  'clean',
  'rejected',
  'scan_failed',
])

export const attachmentLifecycleEventTypeEnum = pgEnum('attachment_lifecycle_event_type', [
  'evidence_linked',
  'operator_review_required',
  'legal_hold_applied',
  'legal_hold_released',
  'deletion_eligible',
  'deletion_blocked_policy_missing',
  'deletion_blocked_legal_hold',
  'deleted',
])

export const attachmentGrantKindEnum = pgEnum('attachment_grant_kind', ['upload', 'read'])
export const attachmentGrantEventTypeEnum = pgEnum('attachment_grant_event_type', [
  'issued',
  'consumed',
  'fulfilled',
  'revoked',
])

/** Immutable attachment evidence. State changes live only in append-only event tables below. */
export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflowInstances.id, { onDelete: 'restrict' }),
    participantId: uuid('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'restrict' }),
    sourceMessageReference: text('source_message_reference').notNull(),
    providerReference: text('provider_reference').notNull(),
    declaredType: text('declared_type').notNull(),
    detectedType: text('detected_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    contentHash: varchar('content_hash', { length: 64 }).notNull(),
    /** Provider-neutral opaque reference. Never a URL, access key, or signed grant. */
    storageReference: text('storage_reference').notNull(),
    createdAt: tstz('created_at').notNull(),
  },
  (table) => [
    unique('attachments_workflow_provider_reference_key').on(table.workflowId, table.providerReference),
    index('attachments_content_hash_idx').on(table.contentHash),
    index('attachments_owner_idx').on(table.workflowId, table.participantId, table.createdAt),
    check('attachments_positive_size', sql`${table.sizeBytes} > 0`),
    check('attachments_sha256', sql`${table.contentHash} ~ '^[a-f0-9]{64}$'`),
    check('attachments_source_reference_length', sql`char_length(${table.sourceMessageReference}) between 1 and 500`),
    check('attachments_provider_reference_length', sql`char_length(${table.providerReference}) between 1 and 500`),
    check('attachments_declared_type_length', sql`char_length(${table.declaredType}) between 1 and 200`),
    check('attachments_detected_type_length', sql`char_length(${table.detectedType}) between 1 and 200`),
    check('attachments_opaque_storage_reference', sql`${table.storageReference} !~* '^https?://'`),
  ],
)

/** Append-only security history; the latest row is the current state. */
export const attachmentSecurityEvents = pgTable(
  'attachment_security_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    attachmentId: uuid('attachment_id')
      .notNull()
      .references(() => attachments.id, { onDelete: 'restrict' }),
    state: attachmentSecurityStateEnum('state').notNull(),
    reasonCode: text('reason_code').notNull(),
    scannerProvider: text('scanner_provider'),
    occurredAt: tstz('occurred_at').notNull(),
  },
  (table) => [
    index('attachment_security_events_current_idx').on(table.attachmentId, table.occurredAt, table.id),
    check('attachment_security_events_reason_code', sql`${table.reasonCode} ~ '^[A-Z][A-Z0-9_]*$'`),
  ],
)

/** Append-only lifecycle, retention, and legal-hold evidence. */
export const attachmentLifecycleEvents = pgTable(
  'attachment_lifecycle_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    attachmentId: uuid('attachment_id')
      .notNull()
      .references(() => attachments.id, { onDelete: 'restrict' }),
    eventType: attachmentLifecycleEventTypeEnum('event_type').notNull(),
    reasonCode: text('reason_code').notNull(),
    policyReference: text('policy_reference'),
    actorReference: text('actor_reference').notNull(),
    deduplicationKey: text('deduplication_key').notNull(),
    occurredAt: tstz('occurred_at').notNull(),
  },
  (table) => [
    unique('attachment_lifecycle_events_dedupe_key').on(table.deduplicationKey),
    index('attachment_lifecycle_events_timeline_idx').on(table.attachmentId, table.occurredAt, table.id),
    check('attachment_lifecycle_events_reason_code', sql`${table.reasonCode} ~ '^[A-Z][A-Z0-9_]*$'`),
    check('attachment_lifecycle_events_actor_length', sql`char_length(${table.actorReference}) between 1 and 200`),
    check(
      'attachment_lifecycle_events_policy_reference_length',
      sql`${table.policyReference} is null or char_length(${table.policyReference}) between 1 and 200`,
    ),
  ],
)

/** Mutable only for atomic consumption/revocation; raw one-time tokens are never persisted. */
export const attachmentAccessGrants = pgTable(
  'attachment_access_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: attachmentGrantKindEnum('kind').notNull(),
    tokenDigest: varchar('token_digest', { length: 64 }).notNull(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflowInstances.id, { onDelete: 'restrict' }),
    participantId: uuid('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'restrict' }),
    attachmentId: uuid('attachment_id').references(() => attachments.id, { onDelete: 'restrict' }),
    expectedDeclaredType: text('expected_declared_type'),
    maxBytes: integer('max_bytes'),
    expiresAt: tstz('expires_at').notNull(),
    consumedAt: tstz('consumed_at'),
    revokedAt: tstz('revoked_at'),
    createdAt: tstz('created_at').notNull(),
  },
  (table) => [
    unique('attachment_access_grants_token_digest_key').on(table.tokenDigest),
    index('attachment_access_grants_scope_idx').on(table.workflowId, table.participantId, table.expiresAt),
    check('attachment_access_grants_sha256', sql`${table.tokenDigest} ~ '^[a-f0-9]{64}$'`),
    check('attachment_access_grants_expiry', sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      'attachment_access_grants_kind_coherence',
      sql`(${table.kind} = 'upload' and ${table.attachmentId} is null and ${table.expectedDeclaredType} is not null and ${table.maxBytes} > 0)
          or (${table.kind} = 'read' and ${table.attachmentId} is not null and ${table.expectedDeclaredType} is null and ${table.maxBytes} is null)`,
    ),
    check(
      'attachment_access_grants_terminal_time',
      sql`(${table.consumedAt} is null or ${table.consumedAt} >= ${table.createdAt})
          and (${table.revokedAt} is null or ${table.revokedAt} >= ${table.createdAt})
          and not (${table.consumedAt} is not null and ${table.revokedAt} is not null)`,
    ),
  ],
)

/** Append-only audit of grant issue, consumption, fulfillment, and revocation. */
export const attachmentGrantEvents = pgTable(
  'attachment_grant_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    grantId: uuid('grant_id')
      .notNull()
      .references(() => attachmentAccessGrants.id, { onDelete: 'restrict' }),
    attachmentId: uuid('attachment_id').references(() => attachments.id, { onDelete: 'restrict' }),
    eventType: attachmentGrantEventTypeEnum('event_type').notNull(),
    reasonCode: text('reason_code').notNull(),
    occurredAt: tstz('occurred_at').notNull(),
  },
  (table) => [
    index('attachment_grant_events_timeline_idx').on(table.grantId, table.occurredAt, table.id),
    check('attachment_grant_events_reason_code', sql`${table.reasonCode} ~ '^[A-Z][A-Z0-9_]*$'`),
  ],
)

export type AttachmentRow = typeof attachments.$inferSelect
export type NewAttachmentRow = typeof attachments.$inferInsert
export type AttachmentSecurityEventRow = typeof attachmentSecurityEvents.$inferSelect
export type AttachmentLifecycleEventRow = typeof attachmentLifecycleEvents.$inferSelect
export type AttachmentAccessGrantRow = typeof attachmentAccessGrants.$inferSelect
export type AttachmentGrantEventRow = typeof attachmentGrantEvents.$inferSelect
