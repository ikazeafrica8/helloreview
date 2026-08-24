import { sql } from 'drizzle-orm'
import { check, index, integer, jsonb, pgEnum, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core'
import { tstz } from '../columns.js'
import { campaigns } from './campaigns.js'

// Website-owned applications synchronized into a current projection plus immutable change history
// (PRD §13.1, §17.2, T26/T27).
//
// The website remains authoritative. There is deliberately no participant-message source in the
// sync-method enum and no column that could turn a chat claim into a completed application. The two
// authorized paths are a validated website EVENT and a record read back from the website during
// RECONCILIATION.

export const applicationStatusEnum = pgEnum('application_status', [
  'received',
  'completed',
  'matched',
  'ambiguous',
  'cancelled',
  'synchronized_late',
])

export const applicationSyncMethodEnum = pgEnum('application_sync_method', ['event', 'reconciliation'])

export const applications = pgTable(
  'applications',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** Stable upstream namespace and identifier; together they are FR-APP-002's identity. */
    sourceSystem: text('source_system').notNull(),
    sourceApplicationId: text('source_application_id').notNull(),

    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'restrict' }),

    /** Platform timeline state; sourceStatus retains the exact normalized website state. */
    status: applicationStatusEnum('status').notNull(),
    sourceStatus: applicationStatusEnum('source_status').notNull(),

    /** PII copied from the source of truth for deterministic identity matching in T28. */
    applicantName: text('applicant_name').notNull(),
    phoneNormalized: text('phone_normalized').notNull(),
    blogUrl: text('blog_url'),

    /** Source-owned blogger ranking evidence; unrelated to the application lifecycle status. */
    bloggerLevel: integer('blogger_level'),
    blogDailyVisitors: integer('blog_daily_visitors'),
    /** Coarse `지역` category only. Detailed website address fields are never copied. */
    bloggerRegion: text('blogger_region'),

    /** Monotonic source-record version. Older arrivals cannot reverse this projection. */
    sourceVersion: integer('source_version').notNull(),
    submittedAt: tstz('submitted_at').notNull(),

    /** The source evidence behind the CURRENT projection; every prior value remains in changes. */
    lastSourceEventId: text('last_source_event_id').notNull(),
    lastSourceOccurredAt: tstz('last_source_occurred_at').notNull(),
    lastSynchronizedAt: tstz('last_synchronized_at').notNull(),

    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    unique('applications_source_id_key').on(table.sourceSystem, table.sourceApplicationId),
    index('applications_campaign_status_idx').on(table.campaignId, table.status),
    index('applications_campaign_blogger_ranking_idx').on(
      table.campaignId,
      table.bloggerLevel,
      table.blogDailyVisitors,
    ),
    index('applications_phone_campaign_idx').on(table.phoneNormalized, table.campaignId),
    index('applications_source_freshness_idx').on(table.sourceSystem, table.lastSynchronizedAt),
    check('applications_positive_source_version', sql`${table.sourceVersion} > 0`),
    check('applications_positive_blogger_level', sql`${table.bloggerLevel} is null or ${table.bloggerLevel} > 0`),
    check(
      'applications_nonnegative_blog_daily_visitors',
      sql`${table.blogDailyVisitors} is null or ${table.blogDailyVisitors} >= 0`,
    ),
    check(
      'applications_valid_blogger_region',
      sql`${table.bloggerRegion} is null or char_length(${table.bloggerRegion}) between 1 and 100`,
    ),
  ],
)

/**
 * One logical projection change. Append-only by trigger in migration 0013.
 *
 * `UNIQUE(source_system, source_event_id)` makes event replay idempotent. Source VERSION provides
 * the second line of defence: a poll can apply version 7 and a later webhook with a different event
 * id but the same version still cannot create a second transition.
 */
export const applicationChanges = pgTable(
  'application_changes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'restrict' }),
    sourceSystem: text('source_system').notNull(),
    sourceEventId: text('source_event_id').notNull(),
    sourceOccurredAt: tstz('source_occurred_at').notNull(),
    sourceVersion: integer('source_version').notNull(),
    applicationStatus: applicationStatusEnum('application_status').notNull(),
    sourceStatus: applicationStatusEnum('source_status').notNull(),
    synchronizationMethod: applicationSyncMethodEnum('synchronization_method').notNull(),
    /** Field names only, never their PII-bearing old/new values. */
    changedFields: jsonb('changed_fields').notNull(),
    synchronizedAt: tstz('synchronized_at').notNull(),
  },
  (table) => [
    unique('application_changes_source_event_key').on(table.sourceSystem, table.sourceEventId),
    unique('application_changes_source_version_key').on(table.applicationId, table.sourceVersion),
    index('application_changes_timeline_idx').on(table.applicationId, table.sourceVersion),
    check('application_changes_positive_source_version', sql`${table.sourceVersion} > 0`),
  ],
)

export const reconciliationStatusEnum = pgEnum('application_reconciliation_status', [
  'pending',
  'resolved',
  'no_match',
  'failed',
])

/** A participant claim's bounded retry window, without storing participant PII in the job payload. */
export const applicationReconciliations = pgTable(
  'application_reconciliations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceSystem: text('source_system').notNull(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'restrict' }),
    status: reconciliationStatusEnum('status').notNull().default('pending'),
    claimedAt: tstz('claimed_at').notNull(),
    retryDeadlineAt: tstz('retry_deadline_at').notNull(),
    nextAttemptAt: tstz('next_attempt_at').notNull(),
    lastAttemptAt: tstz('last_attempt_at'),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastFailureReason: text('last_failure_reason'),
    resolvedApplicationId: uuid('resolved_application_id').references(() => applications.id, {
      onDelete: 'restrict',
    }),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('application_reconciliations_due_idx').on(table.status, table.nextAttemptAt),
    index('application_reconciliations_campaign_idx').on(table.campaignId, table.claimedAt),
    check('application_reconciliations_valid_window', sql`${table.retryDeadlineAt} > ${table.claimedAt}`),
    check('application_reconciliations_nonnegative_attempts', sql`${table.attemptCount} >= 0`),
    check(
      'application_reconciliations_resolution_evidence',
      sql`${table.status} <> 'resolved' or ${table.resolvedApplicationId} is not null`,
    ),
  ],
)

/** Per-source health, so freshness is queryable even when no participant claim is active. */
export const applicationSourceFreshness = pgTable(
  'application_source_freshness',
  {
    sourceSystem: text('source_system').primaryKey(),
    lastAttemptedAt: tstz('last_attempted_at'),
    lastSuccessfulReconciliationAt: tstz('last_successful_reconciliation_at'),
    consecutiveFailureCount: integer('consecutive_failure_count').notNull().default(0),
    lastFailureReason: text('last_failure_reason'),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (table) => [check('application_source_freshness_nonnegative_failures', sql`${table.consecutiveFailureCount} >= 0`)],
)

/** Audit evidence for a completed operator import, without retaining the PII-bearing CSV itself. */
export const applicationImportBatches = pgTable(
  'application_import_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceSystem: text('source_system').notNull(),
    /** Keyed digest over source, export time, and file bytes; not a reversible plain file hash. */
    fileDigest: text('file_digest').notNull(),
    exportedAt: tstz('exported_at').notNull(),
    importedAt: tstz('imported_at').notNull(),
    rowCount: integer('row_count').notNull(),
    appliedCount: integer('applied_count').notNull(),
    duplicateCount: integer('duplicate_count').notNull(),
    staleCount: integer('stale_count').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique('application_import_batches_source_file_key').on(table.sourceSystem, table.fileDigest),
    index('application_import_batches_source_exported_idx').on(table.sourceSystem, table.exportedAt),
    check('application_import_batches_valid_digest', sql`${table.fileDigest} ~ '^[0-9a-f]{64}$'`),
    check(
      'application_import_batches_nonnegative_counts',
      sql`${table.rowCount} >= 0 and ${table.appliedCount} >= 0 and ${table.duplicateCount} >= 0 and ${table.staleCount} >= 0`,
    ),
    check(
      'application_import_batches_counts_sum',
      sql`${table.rowCount} = ${table.appliedCount} + ${table.duplicateCount} + ${table.staleCount}`,
    ),
  ],
)

export type ApplicationRow = typeof applications.$inferSelect
export type NewApplicationRow = typeof applications.$inferInsert
export type ApplicationChangeRow = typeof applicationChanges.$inferSelect
export type NewApplicationChangeRow = typeof applicationChanges.$inferInsert
export type ApplicationReconciliationRow = typeof applicationReconciliations.$inferSelect
export type NewApplicationReconciliationRow = typeof applicationReconciliations.$inferInsert
export type ApplicationSourceFreshnessRow = typeof applicationSourceFreshness.$inferSelect
export type NewApplicationSourceFreshnessRow = typeof applicationSourceFreshness.$inferInsert
export type ApplicationImportBatchRow = typeof applicationImportBatches.$inferSelect
export type NewApplicationImportBatchRow = typeof applicationImportBatches.$inferInsert
