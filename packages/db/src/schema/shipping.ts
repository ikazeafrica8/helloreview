import { sql } from 'drizzle-orm'
import { check, index, integer, jsonb, pgEnum, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core'
import { tstz } from '../columns.js'
import { campaigns } from './campaigns.js'
import { participants } from './participants.js'
import { outboundNotifications } from './outbound-notifications.js'
import { workflowInstances } from './workflow-instances.js'

export const shippingAddressValidationStateEnum = pgEnum('shipping_address_validation_state', ['incomplete', 'valid'])
export const shippingAddressChangeSourceEnum = pgEnum('shipping_address_change_source', [
  'participant_form',
  'authorized_operator',
])

/** Encrypted immutable versions. Ordinary reads use masked_summary only. */
export const shippingAddresses = pgTable(
  'shipping_addresses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflowInstances.id, { onDelete: 'restrict' }),
    participantId: uuid('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'restrict' }),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    encryptedPayload: text('encrypted_payload').notNull(),
    addressFingerprint: text('address_fingerprint').notNull(),
    maskedSummary: text('masked_summary').notNull(),
    validationState: shippingAddressValidationStateEnum('validation_state').notNull(),
    validationEvidence: jsonb('validation_evidence').notNull(),
    policyVersion: text('policy_version').notNull(),
    changeSource: shippingAddressChangeSourceEnum('change_source').notNull(),
    actorReference: text('actor_reference').notNull(),
    createdAt: tstz('created_at').notNull(),
  },
  (table) => [
    unique('shipping_addresses_workflow_version_key').on(table.workflowId, table.version),
    index('shipping_addresses_workflow_timeline_idx').on(table.workflowId, table.createdAt),
    check('shipping_addresses_positive_version', sql`${table.version} > 0`),
    check('shipping_addresses_fingerprint', sql`${table.addressFingerprint} ~ '^[0-9a-f]{64}$'`),
  ],
)

export const shippingAddressHeads = pgTable('shipping_address_heads', {
  workflowId: uuid('workflow_id')
    .primaryKey()
    .references(() => workflowInstances.id, { onDelete: 'restrict' }),
  addressId: uuid('address_id')
    .notNull()
    .unique()
    .references(() => shippingAddresses.id, { onDelete: 'restrict' }),
  updatedAt: tstz('updated_at').notNull(),
})

/** The raw form token never reaches the database. This mutable row is consumed exactly once. */
export const shippingFormGrants = pgTable(
  'shipping_form_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflowInstances.id, { onDelete: 'restrict' }),
    participantId: uuid('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'restrict' }),
    tokenDigest: text('token_digest').notNull().unique(),
    deduplicationKey: text('deduplication_key').notNull().unique(),
    expiresAt: tstz('expires_at').notNull(),
    consumedAt: tstz('consumed_at'),
    revokedAt: tstz('revoked_at'),
    outboundNotificationId: uuid('outbound_notification_id').references(() => outboundNotifications.id, {
      onDelete: 'restrict',
    }),
    createdAt: tstz('created_at').notNull(),
  },
  (table) => [
    index('shipping_form_grants_workflow_idx').on(table.workflowId, table.createdAt),
    check('shipping_form_grants_token_digest', sql`${table.tokenDigest} ~ '^[0-9a-f]{64}$'`),
    check('shipping_form_grants_valid_expiry', sql`${table.expiresAt} > ${table.createdAt}`),
    check('shipping_form_grants_single_terminal_state', sql`${table.consumedAt} is null or ${table.revokedAt} is null`),
  ],
)

/** Explicit full-address access ledger. No plaintext is copied into this table. */
export const shippingAddressReveals = pgTable(
  'shipping_address_reveals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    addressId: uuid('address_id')
      .notNull()
      .references(() => shippingAddresses.id, { onDelete: 'restrict' }),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflowInstances.id, { onDelete: 'restrict' }),
    actorReference: text('actor_reference').notNull(),
    reasonCode: text('reason_code').notNull(),
    correlationId: text('correlation_id').notNull(),
    occurredAt: tstz('occurred_at').notNull(),
  },
  (table) => [
    index('shipping_address_reveals_address_idx').on(table.addressId, table.occurredAt),
    check('shipping_address_reveals_reason_code', sql`${table.reasonCode} ~ '^[A-Z][A-Z0-9_]*$'`),
  ],
)

export type ShippingAddressRow = typeof shippingAddresses.$inferSelect
export type ShippingFormGrantRow = typeof shippingFormGrants.$inferSelect
export type ShippingAddressRevealRow = typeof shippingAddressReveals.$inferSelect
