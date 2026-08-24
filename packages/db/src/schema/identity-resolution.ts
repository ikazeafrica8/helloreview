import { sql } from 'drizzle-orm'
import { boolean, check, index, jsonb, pgEnum, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core'
import { tstz } from '../columns.js'
import { applications } from './applications.js'
import { campaigns } from './campaigns.js'
import { channelIdentities, participants } from './participants.js'

export const identityMatchCategoryEnum = pgEnum('identity_match_category', [
  'verified',
  'strong_match',
  'weak_match',
  'ambiguous',
  'no_match',
])

export const identityResolutionStatusEnum = pgEnum('identity_resolution_status', [
  'verified',
  'strong_match',
  'weak_match',
  'ambiguous',
  'no_match',
  'campaign_disambiguation_required',
  'security_review_required',
])

/** Website-issued token evidence. Only a keyed digest is retained; the bearer token is never stored. */
export const applicationVerificationTokens = pgTable(
  'application_verification_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'restrict' }),
    tokenDigest: text('token_digest').notNull(),
    issuedAt: tstz('issued_at').notNull(),
    expiresAt: tstz('expires_at').notNull(),
    consumedAt: tstz('consumed_at'),
    consumedByParticipantId: uuid('consumed_by_participant_id').references(() => participants.id, {
      onDelete: 'restrict',
    }),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique('application_verification_tokens_digest_key').on(table.tokenDigest),
    index('application_verification_tokens_expiry_idx').on(table.expiresAt),
    index('application_verification_tokens_application_idx').on(table.applicationId),
    check('application_verification_tokens_digest_shape', sql`${table.tokenDigest} ~ '^[0-9a-f]{64}$'`),
    check('application_verification_tokens_valid_window', sql`${table.expiresAt} > ${table.issuedAt}`),
    check(
      'application_verification_tokens_valid_consumption',
      sql`${table.consumedAt} is null or (${table.consumedAt} >= ${table.issuedAt} and ${table.consumedByParticipantId} is not null)`,
    ),
  ],
)

/** One persisted result from the deterministic T29 table plus T31 campaign/security context. */
export const identityResolutionCases = pgTable(
  'identity_resolution_cases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Stable inbound/contact evidence key. Replay must not create a second resolution or task. */
    sourceKey: text('source_key').notNull(),
    participantId: uuid('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'restrict' }),
    channelIdentityId: uuid('channel_identity_id').references(() => channelIdentities.id, { onDelete: 'restrict' }),
    campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'restrict' }),
    matchCategory: identityMatchCategoryEnum('match_category').notNull(),
    status: identityResolutionStatusEnum('status').notNull(),
    matchMethod: text('match_method').notNull(),
    evidenceCategory: text('evidence_category').notNull(),
    reasonCode: text('reason_code').notNull(),
    /** Internal identifiers only. This field is never used to render participant-facing output. */
    candidateApplicationIds: jsonb('candidate_application_ids').notNull(),
    campaignSpecificTransitionsAllowed: boolean('campaign_specific_transitions_allowed').notNull().default(false),
    participantMessagePurpose: text('participant_message_purpose'),
    decidedAt: tstz('decided_at').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    unique('identity_resolution_cases_source_key').on(table.sourceKey),
    index('identity_resolution_cases_participant_idx').on(table.participantId, table.decidedAt),
    index('identity_resolution_cases_status_idx').on(table.status, table.decidedAt),
    index('identity_resolution_cases_campaign_idx').on(table.campaignId, table.decidedAt),
    check('identity_resolution_cases_reason_code', sql`${table.reasonCode} ~ '^[A-Z][A-Z0-9_]*$'`),
    check('identity_resolution_cases_valid_source_key', sql`char_length(${table.sourceKey}) between 1 and 256`),
    check(
      'identity_resolution_cases_transition_gate',
      sql`not ${table.campaignSpecificTransitionsAllowed} or ${table.status} in ('verified', 'strong_match')`,
    ),
  ],
)

export type ApplicationVerificationTokenRow = typeof applicationVerificationTokens.$inferSelect
export type NewApplicationVerificationTokenRow = typeof applicationVerificationTokens.$inferInsert
export type IdentityResolutionCaseRow = typeof identityResolutionCases.$inferSelect
export type NewIdentityResolutionCaseRow = typeof identityResolutionCases.$inferInsert
