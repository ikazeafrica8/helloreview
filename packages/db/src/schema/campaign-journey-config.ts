import { sql } from 'drizzle-orm'
import { boolean, check, index, integer, pgEnum, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { tstz } from '../columns.js'
import { campaigns } from './campaigns.js'
import { campaignRuleStatusEnum } from './campaign-rules.js'

// Versioned journey configuration and notification ownership (T136, PRD §14.5, §21.9, FR-SC-002).
//
// WHAT THE JOURNEYS ASSUMED BUT COULD NOT RESOLVE. PRD §14.5 makes "Campaign application URL exists"
// a mandatory guard on Not Applied -> Application Requested, and §32.1's template interpolates
// `{{application_url}}` — but there was nowhere to store one, so the guard could not be evaluated
// and the message could not be composed.
//
// VERSIONED FOR THE SAME REASON AS campaign_businesses. A participant told to apply at one URL last
// month must still be explicable against the URL that was current then. These tables reuse
// `campaign_rule_status` and the effective-dating shape so the three configuration lifecycles cannot
// drift apart, and migration 0034 freezes published versions with the same trigger pattern.

/**
 * Who is authoritatively responsible for sending one message purpose during the Aligo cutover.
 *
 * Three real answers, and no `unknown` member. Absence of a row IS "not decided", and it is what the
 * activation validator refuses on — making it a storable value would let a campaign activate while
 * declaring that nobody in particular owns its participant messages.
 */
export const messageAuthoritativeSenderEnum = pgEnum('message_authoritative_sender', [
  /** The existing website/Aligo trigger keeps sending this. The platform must suppress. */
  'website_legacy_trigger',
  /** This platform owns it. Only reachable once the legacy trigger has been audited — see the CHECK. */
  'helloreview_platform',
  /** Neither automation sends it; an operator does, deliberately. */
  'operator_manual',
])

/**
 * How much is actually known about the legacy trigger for this purpose.
 *
 * `not_audited` is the honest default and the reason the CHECK below exists: T148's inventory of
 * every existing website/Aligo send has not happened, and until it does, claiming the platform owns
 * a purpose is claiming to know something nobody has checked. Duplicate participant messages are the
 * failure this prevents.
 */
export const messageTriggerAuditStatusEnum = pgEnum('message_trigger_audit_status', [
  'not_audited',
  'audited_no_legacy_trigger',
  'audited_legacy_trigger_exists',
])

/** Versioned per-campaign journey facts the participant-facing routes need before activation. */
export const campaignJourneyConfigurations = pgTable(
  'campaign_journey_configurations',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    campaignId: uuid('campaign_id')
      .notNull()
      // RESTRICT as everywhere else in campaign configuration: deleting a campaign would delete the
      // evidence behind every message that cited this version.
      .references(() => campaigns.id, { onDelete: 'restrict' }),

    /** Monotonic per campaign. Numbers are never reused. */
    version: integer('version').notNull(),
    status: campaignRuleStatusEnum('status').notNull().default('draft'),

    /**
     * The website application URL a participant is sent to (PRD §32.1).
     *
     * This string is interpolated into a participant message verbatim, which is why the CHECKs are
     * strict: HTTPS only, no userinfo, and no query string. A URL carrying `?token=` would turn a
     * broadcast template into a credential leak, and `http://` would send a Korean participant to a
     * page that their browser marks unsafe.
     */
    applicationUrl: text('application_url'),

    effectiveFrom: tstz('effective_from').notNull(),
    effectiveTo: tstz('effective_to'),

    publishedBy: text('published_by'),
    publishedAt: tstz('published_at'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique('campaign_journey_configurations_version_key').on(table.campaignId, table.version),
    index('campaign_journey_configurations_lookup_idx').on(table.campaignId, table.effectiveFrom),
    uniqueIndex('campaign_journey_configurations_one_current_idx')
      .on(table.campaignId)
      .where(sql`${table.effectiveTo} is null and ${table.status} = 'published'`),
    check('campaign_journey_configurations_positive_version', sql`${table.version} > 0`),
    check(
      'campaign_journey_configurations_https_application_url',
      sql`${table.applicationUrl} is null or ${table.applicationUrl} ~ '^https://[A-Za-z0-9.-]+(/[^[:space:]]*)?$'`,
    ),
    check(
      'campaign_journey_configurations_credential_free_url',
      sql`${table.applicationUrl} is null
          or (${table.applicationUrl} !~ '@' and ${table.applicationUrl} !~ '\\?' and ${table.applicationUrl} !~ '#')`,
    ),
    check(
      'campaign_journey_configurations_url_length',
      sql`${table.applicationUrl} is null or char_length(${table.applicationUrl}) between 12 and 500`,
    ),
    check(
      'campaign_journey_configurations_effective_order',
      sql`${table.effectiveTo} is null or ${table.effectiveTo} > ${table.effectiveFrom}`,
    ),
  ],
)

/**
 * Which sender owns each participant-facing message purpose, per campaign.
 *
 * PER CAMPAIGN, not global: cutover happens one campaign at a time, and a global switch would move
 * every campaign at once. It also matches how T152 activates only allowlisted campaigns.
 *
 * `purpose_stem` holds the STEM, not a parameterised purpose. Ownership is a property of the message
 * family — nobody owns `RESERVATION_CORRECTION:INVALID_TIME` separately from
 * `RESERVATION_CORRECTION:WRONG_BUSINESS`.
 */
export const messagePurposeOwnership = pgTable(
  'message_purpose_ownership',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'restrict' }),

    purposeStem: text('purpose_stem').notNull(),
    authoritativeSender: messageAuthoritativeSenderEnum('authoritative_sender').notNull(),
    triggerAuditStatus: messageTriggerAuditStatusEnum('trigger_audit_status').notNull().default('not_audited'),

    /**
     * A pseudonymous reference to the legacy trigger, for the T148 inventory.
     *
     * Deliberately not credentials, an account id, or a provider API key: this table is read by the
     * operator console, and "queryable without secrets" is one of T136's acceptance criteria.
     */
    legacyTriggerReference: text('legacy_trigger_reference'),

    /** Whether this platform must suppress its own send because the legacy sender still fires. */
    platformSuppressionRequired: boolean('platform_suppression_required').notNull().default(false),

    version: integer('version').notNull(),
    status: campaignRuleStatusEnum('status').notNull().default('draft'),
    effectiveFrom: tstz('effective_from').notNull(),
    effectiveTo: tstz('effective_to'),

    approvedBy: text('approved_by'),
    approvedAt: tstz('approved_at'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique('message_purpose_ownership_version_key').on(table.campaignId, table.purposeStem, table.version),
    index('message_purpose_ownership_lookup_idx').on(table.campaignId, table.purposeStem, table.effectiveFrom),
    index('message_purpose_ownership_audit_idx').on(table.triggerAuditStatus, table.campaignId),
    uniqueIndex('message_purpose_ownership_one_current_idx')
      .on(table.campaignId, table.purposeStem)
      .where(sql`${table.effectiveTo} is null and ${table.status} = 'published'`),
    check('message_purpose_ownership_positive_version', sql`${table.version} > 0`),
    check('message_purpose_ownership_purpose_stem', sql`${table.purposeStem} ~ '^[A-Z][A-Z0-9_]*$'`),

    // THE LOAD-BEARING CONSTRAINT. This platform cannot claim a purpose whose legacy trigger has
    // never been audited. Without it, a campaign could activate believing it owns a message that the
    // website also still sends, and the participant would receive both.
    check(
      'message_purpose_ownership_audit_before_platform',
      sql`${table.authoritativeSender} <> 'helloreview_platform' or ${table.triggerAuditStatus} <> 'not_audited'`,
    ),

    // Suppression only means something when something else is sending.
    check(
      'message_purpose_ownership_suppression_coherence',
      sql`not ${table.platformSuppressionRequired} or ${table.authoritativeSender} <> 'helloreview_platform'`,
    ),

    // A legacy sender that nobody can point at is not an audited fact.
    check(
      'message_purpose_ownership_legacy_reference',
      sql`${table.authoritativeSender} <> 'website_legacy_trigger' or ${table.legacyTriggerReference} is not null`,
    ),
    check(
      'message_purpose_ownership_reference_shape',
      sql`${table.legacyTriggerReference} is null
          or (char_length(${table.legacyTriggerReference}) between 1 and 200
              and ${table.legacyTriggerReference} ~ '^[A-Za-z0-9][A-Za-z0-9:._/-]*$')`,
    ),
    check(
      'message_purpose_ownership_effective_order',
      sql`${table.effectiveTo} is null or ${table.effectiveTo} > ${table.effectiveFrom}`,
    ),
  ],
)

export type CampaignJourneyConfigurationRow = typeof campaignJourneyConfigurations.$inferSelect
export type NewCampaignJourneyConfigurationRow = typeof campaignJourneyConfigurations.$inferInsert
export type MessagePurposeOwnershipRow = typeof messagePurposeOwnership.$inferSelect
export type NewMessagePurposeOwnershipRow = typeof messagePurposeOwnership.$inferInsert
