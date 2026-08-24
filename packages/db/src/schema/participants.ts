import { sql } from 'drizzle-orm'
import { check, index, pgEnum, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core'
import { tstz } from '../columns.js'

// Canonical participants and their provider identities (PRD §13.2, §17.2, T28).
//
// A PARTICIPANT IS NOT A PHONE NUMBER. Families and organizations can share one number, so phone
// is indexed for candidate lookup but deliberately has no UNIQUE constraint (FR-ID-005). The same
// applies to a blog URL: it is matching evidence, not an identity key on its own.

export const channelIdentityVerificationStateEnum = pgEnum('channel_identity_verification_state', [
  'unverified',
  'verified',
  'revoked',
])

export const participants = pgTable(
  'participants',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** Source/display form only; name by itself can never bind an application (FR-ID-001). */
    name: text('name'),
    /** Canonical E.164 Korean mobile form produced by normalizeKoreanMobilePhone(). */
    phoneNormalized: text('phone_normalized'),
    blogUrl: text('blog_url'),

    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('participants_phone_idx').on(table.phoneNormalized),
    index('participants_blog_url_idx').on(table.blogUrl),
    check('participants_valid_name', sql`${table.name} is null or char_length(${table.name}) between 1 and 200`),
    check(
      'participants_normalized_korean_mobile',
      sql`${table.phoneNormalized} is null or ${table.phoneNormalized} ~ '^[+]8210[0-9]{8}$'`,
    ),
    check('participants_http_blog_url', sql`${table.blogUrl} is null or ${table.blogUrl} ~ '^https?://'`),
  ],
)

export const channelIdentities = pgTable(
  'channel_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    participantId: uuid('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),

    /** Normalized lowercase adapter/provider namespace, never a participant-facing label. */
    provider: text('provider').notNull(),
    /** Opaque provider identifier. It is unique only inside the provider namespace. */
    externalUserId: text('external_user_id').notNull(),
    verificationState: channelIdentityVerificationStateEnum('verification_state').notNull().default('unverified'),
    verifiedAt: tstz('verified_at'),

    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    unique('channel_identities_provider_external_user_key').on(table.provider, table.externalUserId),
    index('channel_identities_participant_idx').on(table.participantId),
    check('channel_identities_valid_provider', sql`${table.provider} ~ '^[a-z][a-z0-9_.-]{2,63}$'`),
    check('channel_identities_valid_external_user_id', sql`char_length(${table.externalUserId}) between 1 and 512`),
    check(
      'channel_identities_verified_at_required',
      sql`${table.verificationState} <> 'verified' or ${table.verifiedAt} is not null`,
    ),
  ],
)

export type ParticipantRow = typeof participants.$inferSelect
export type NewParticipantRow = typeof participants.$inferInsert
export type ChannelIdentityRow = typeof channelIdentities.$inferSelect
export type NewChannelIdentityRow = typeof channelIdentities.$inferInsert
