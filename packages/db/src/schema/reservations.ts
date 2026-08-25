import { sql } from 'drizzle-orm'
import { check, index, integer, jsonb, pgEnum, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { tstz } from '../columns.js'
import { campaigns } from './campaigns.js'
import { participants } from './participants.js'
import { workflowInstances } from './workflow-instances.js'

export const reservationVersionSourceEnum = pgEnum('reservation_version_source', [
  'participant',
  'operator',
  'ai_assisted',
  'imported',
])
export const reservationValidationStateEnum = pgEnum('reservation_validation_state', [
  'pending',
  'valid',
  'invalid',
  'human_review',
])
export const reservationValidationAuthorityEnum = pgEnum('reservation_validation_authority', [
  'none',
  'deterministic_rules',
])
export const reservationStatusEnum = pgEnum('reservation_status', ['pending', 'confirmed', 'cancelled', 'rescheduled'])

export const reservations = pgTable(
  'reservations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workflowId: uuid('workflow_id')
      .notNull()
      .unique()
      .references(() => workflowInstances.id, { onDelete: 'restrict' }),
    participantId: uuid('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'restrict' }),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'restrict' }),
    createdAt: tstz('created_at').notNull(),
  },
  (table) => [index('reservations_participant_idx').on(table.participantId, table.createdAt)],
)

/** Immutable reservation facts. Supersession adds a new row; it never edits the prior row. */
export const reservationVersions = pgTable(
  'reservation_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reservationId: uuid('reservation_id')
      .notNull()
      .references(() => reservations.id, { onDelete: 'restrict' }),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflowInstances.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    source: reservationVersionSourceEnum('source').notNull(),
    sourceReference: text('source_reference').notNull(),
    extractionProvenance: jsonb('extraction_provenance').notNull(),
    reservedDate: text('reserved_date'),
    reservedTime: text('reserved_time'),
    timezone: text('timezone'),
    businessReference: text('business_reference'),
    visitMethod: text('visit_method'),
    status: reservationStatusEnum('status').notNull(),
    cancellationReason: text('cancellation_reason'),
    validationState: reservationValidationStateEnum('validation_state').notNull(),
    validationAuthority: reservationValidationAuthorityEnum('validation_authority').notNull(),
    ruleVersion: text('rule_version'),
    validationEvidence: jsonb('validation_evidence').notNull(),
    supersedesVersionId: uuid('supersedes_version_id').references((): AnyPgColumn => reservationVersions.id, {
      onDelete: 'restrict',
    }),
    actorReference: text('actor_reference').notNull(),
    occurredAt: tstz('occurred_at').notNull(),
  },
  (table) => [
    unique('reservation_versions_reservation_version_key').on(table.reservationId, table.version),
    unique('reservation_versions_reservation_source_key').on(table.reservationId, table.sourceReference),
    unique('reservation_versions_supersedes_key').on(table.supersedesVersionId),
    index('reservation_versions_workflow_timeline_idx').on(table.workflowId, table.occurredAt),
    check('reservation_versions_positive_version', sql`${table.version} > 0`),
    check(
      'reservation_versions_valid_authority',
      sql`${table.validationState} <> 'valid' or (${table.validationAuthority} = 'deterministic_rules' and ${table.ruleVersion} is not null)`,
    ),
    check(
      'reservation_versions_cancel_reason',
      sql`${table.status} <> 'cancelled' or ${table.cancellationReason} is not null`,
    ),
  ],
)

export const reservationHeads = pgTable('reservation_heads', {
  reservationId: uuid('reservation_id')
    .primaryKey()
    .references(() => reservations.id, { onDelete: 'restrict' }),
  versionId: uuid('version_id')
    .notNull()
    .unique()
    .references(() => reservationVersions.id, { onDelete: 'restrict' }),
  updatedAt: tstz('updated_at').notNull(),
})

export type ReservationRow = typeof reservations.$inferSelect
export type ReservationVersionRow = typeof reservationVersions.$inferSelect
