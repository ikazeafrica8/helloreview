import { sql } from 'drizzle-orm'
import { check, foreignKey, index, integer, jsonb, pgEnum, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core'
import { tstz } from '../columns.js'
import { participants } from './participants.js'

export const privacyRetentionDataClassEnum = pgEnum('privacy_retention_data_class', [
  'application_sync',
  'conversation_content',
  'attachments',
  'shipping_addresses',
  'consent_records',
  'selection_decisions',
  'audit_logs',
  'delivery_records',
  'failed_integration_payloads',
  'ai_ocr_results',
  'privacy_requests',
])

export const privacyRetentionDispositionEnum = pgEnum('privacy_retention_disposition', ['delete', 'irreversible_mask'])
export const privacyLegalHoldScopeEnum = pgEnum('privacy_legal_hold_scope', [
  'participant',
  'participant_data_class',
  'record',
])
export const privacyLegalHoldEventTypeEnum = pgEnum('privacy_legal_hold_event_type', ['applied', 'released'])
export const privacyDeletionEligibilityDecisionEnum = pgEnum('privacy_deletion_eligibility_decision', [
  'legal_hold_active',
  'policy_missing',
  'retention_active',
  'eligible',
])

/** Immutable approved schedule versions. No row is seeded until real dual approval exists. */
export const privacyRetentionSchedules = pgTable(
  'privacy_retention_schedules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    schemaVersion: text('schema_version').notNull(),
    policyVersion: text('policy_version').notNull(),
    supersedesPolicyVersion: text('supersedes_policy_version'),
    companyApprovalReference: text('company_approval_reference').notNull(),
    legalApprovalReference: text('legal_approval_reference').notNull(),
    approvedAt: tstz('approved_at').notNull(),
    effectiveFrom: tstz('effective_from').notNull(),
    inputDigest: text('input_digest').notNull(),
    publishedByReference: text('published_by_reference').notNull(),
    correlationId: text('correlation_id').notNull(),
    createdAt: tstz('created_at').notNull(),
  },
  (table) => [
    unique('privacy_retention_schedules_policy_version_key').on(table.policyVersion),
    index('privacy_retention_schedules_effective_idx').on(table.effectiveFrom, table.createdAt),
    foreignKey({
      name: 'privacy_retention_schedules_supersedes_fk',
      columns: [table.supersedesPolicyVersion],
      foreignColumns: [table.policyVersion],
    }).onDelete('restrict'),
    check('privacy_retention_schedules_schema_version', sql`${table.schemaVersion} = 'privacy-retention-schedule-v1'`),
    check('privacy_retention_schedules_policy_version', sql`${table.policyVersion} ~ '^[a-z][a-z0-9-]*-v[0-9]+$'`),
    check(
      'privacy_retention_schedules_supersedes_version',
      sql`${table.supersedesPolicyVersion} is null or ${table.supersedesPolicyVersion} ~ '^[a-z][a-z0-9-]*-v[0-9]+$'`,
    ),
    check('privacy_retention_schedules_effective_after_approval', sql`${table.effectiveFrom} >= ${table.approvedAt}`),
    check('privacy_retention_schedules_input_digest', sql`${table.inputDigest} ~ '^[0-9a-f]{64}$'`),
  ],
)

export const privacyRetentionScheduleEntries = pgTable(
  'privacy_retention_schedule_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scheduleId: uuid('schedule_id')
      .notNull()
      .references(() => privacyRetentionSchedules.id, { onDelete: 'restrict' }),
    dataClass: privacyRetentionDataClassEnum('data_class').notNull(),
    retentionDays: integer('retention_days').notNull(),
    disposition: privacyRetentionDispositionEnum('disposition').notNull(),
    createdAt: tstz('created_at').notNull(),
  },
  (table) => [
    unique('privacy_retention_schedule_entries_schedule_class_key').on(table.scheduleId, table.dataClass),
    index('privacy_retention_schedule_entries_class_idx').on(table.dataClass, table.scheduleId),
    check('privacy_retention_schedule_entries_days', sql`${table.retentionDays} between 1 and 36500`),
  ],
)

/** Immutable legal-hold episode. Release is a separate append-only event. */
export const privacyLegalHolds = pgTable(
  'privacy_legal_holds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    holdReference: text('hold_reference').notNull(),
    scope: privacyLegalHoldScopeEnum('scope').notNull(),
    participantId: uuid('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'restrict' }),
    dataClass: privacyRetentionDataClassEnum('data_class'),
    recordReference: text('record_reference'),
    reasonReference: text('reason_reference').notNull(),
    appliedByReference: text('applied_by_reference').notNull(),
    correlationId: text('correlation_id').notNull(),
    inputDigest: text('input_digest').notNull(),
    appliedAt: tstz('applied_at').notNull(),
    createdAt: tstz('created_at').notNull(),
  },
  (table) => [
    unique('privacy_legal_holds_reference_key').on(table.holdReference),
    index('privacy_legal_holds_subject_idx').on(table.participantId, table.dataClass, table.appliedAt),
    check(
      'privacy_legal_holds_scope_target',
      sql`(${table.scope} = 'participant' and ${table.dataClass} is null and ${table.recordReference} is null)
          or (${table.scope} = 'participant_data_class' and ${table.dataClass} is not null and ${table.recordReference} is null)
          or (${table.scope} = 'record' and ${table.dataClass} is not null and ${table.recordReference} is not null)`,
    ),
    check('privacy_legal_holds_input_digest', sql`${table.inputDigest} ~ '^[0-9a-f]{64}$'`),
  ],
)

export const privacyLegalHoldEvents = pgTable(
  'privacy_legal_hold_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    holdId: uuid('hold_id')
      .notNull()
      .references(() => privacyLegalHolds.id, { onDelete: 'restrict' }),
    eventType: privacyLegalHoldEventTypeEnum('event_type').notNull(),
    actorReference: text('actor_reference').notNull(),
    reasonReference: text('reason_reference').notNull(),
    correlationId: text('correlation_id').notNull(),
    deduplicationKey: text('deduplication_key').notNull(),
    inputDigest: text('input_digest').notNull(),
    occurredAt: tstz('occurred_at').notNull(),
  },
  (table) => [
    unique('privacy_legal_hold_events_hold_type_key').on(table.holdId, table.eventType),
    unique('privacy_legal_hold_events_deduplication_key').on(table.deduplicationKey),
    index('privacy_legal_hold_events_timeline_idx').on(table.holdId, table.occurredAt),
    check('privacy_legal_hold_events_input_digest', sql`${table.inputDigest} ~ '^[0-9a-f]{64}$'`),
  ],
)

/** Immutable evidence of each deletion-eligibility decision. It never performs deletion. */
export const privacyDeletionEligibilityEvaluations = pgTable(
  'privacy_deletion_eligibility_evaluations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    evaluationReference: text('evaluation_reference').notNull(),
    participantId: uuid('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'restrict' }),
    dataClass: privacyRetentionDataClassEnum('data_class').notNull(),
    recordReference: text('record_reference').notNull(),
    retentionAnchorAt: tstz('retention_anchor_at').notNull(),
    decision: privacyDeletionEligibilityDecisionEnum('decision').notNull(),
    scheduleId: uuid('schedule_id').references(() => privacyRetentionSchedules.id, { onDelete: 'restrict' }),
    eligibleAt: tstz('eligible_at'),
    activeHoldReferences: jsonb('active_hold_references').notNull(),
    inputDigest: text('input_digest').notNull(),
    actorReference: text('actor_reference').notNull(),
    correlationId: text('correlation_id').notNull(),
    evaluatedAt: tstz('evaluated_at').notNull(),
    createdAt: tstz('created_at').notNull(),
  },
  (table) => [
    unique('privacy_deletion_eligibility_evaluations_reference_key').on(table.evaluationReference),
    index('privacy_deletion_eligibility_evaluations_subject_idx').on(
      table.participantId,
      table.dataClass,
      table.evaluatedAt,
    ),
    check(
      'privacy_deletion_eligibility_evaluations_holds_array',
      sql`jsonb_typeof(${table.activeHoldReferences}) = 'array'`,
    ),
    check('privacy_deletion_eligibility_evaluations_input_digest', sql`${table.inputDigest} ~ '^[0-9a-f]{64}$'`),
    check(
      'privacy_deletion_eligibility_evaluations_coherence',
      sql`(${table.decision} = 'legal_hold_active' and jsonb_array_length(${table.activeHoldReferences}) > 0 and ${table.scheduleId} is null and ${table.eligibleAt} is null)
          or (${table.decision} = 'policy_missing' and jsonb_array_length(${table.activeHoldReferences}) = 0 and ${table.scheduleId} is null and ${table.eligibleAt} is null)
          or (${table.decision} in ('retention_active', 'eligible') and jsonb_array_length(${table.activeHoldReferences}) = 0 and ${table.scheduleId} is not null and ${table.eligibleAt} is not null)`,
    ),
  ],
)

export type PrivacyRetentionScheduleRow = typeof privacyRetentionSchedules.$inferSelect
export type PrivacyLegalHoldRow = typeof privacyLegalHolds.$inferSelect
export type PrivacyDeletionEligibilityEvaluationRow = typeof privacyDeletionEligibilityEvaluations.$inferSelect
