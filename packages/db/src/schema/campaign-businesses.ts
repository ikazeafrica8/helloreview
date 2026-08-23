import { index, integer, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { tstz } from '../columns.js'
import { campaigns } from './campaigns.js'
import { campaignRuleStatusEnum } from './campaign-rules.js'

// The business a campaign sends participants to, versioned (FR-CAM-004, PRD §16.7, T23).
//
// WHY THIS IS VERSIONED AT ALL. §16.7's Business check validates a booking against "exact
// normalized name or approved alias and branch". A business that renames itself, or moves branch,
// changes what a valid booking looks like — and a reservation validated last month must still be
// explicable against the details that were approved then. Same argument as campaign_rules, and it
// reuses that table's status enum so the two lifecycles cannot drift apart.
//
// BRANCH IS ITS OWN COLUMN, which is T23's third acceptance criterion. Folding it into the name
// ("스타벅스 강남점") would make a booking at the right business but the wrong branch
// indistinguishable from a booking at an entirely different business — and §16.7 gives those
// different failure actions. Keeping them apart is what lets the correction message be accurate.
//
// NORMALIZED FORMS ARE STORED ALONGSIDE THE ORIGINALS. The original is what a participant is shown;
// the normalized form is what comparison uses, and storing it means the match can be an indexed
// equality rather than a scan that normalizes every row. They are written by
// business-name-normalizer.ts, which is pure precisely so a stored value stays valid.

export const campaignBusinesses = pgTable(
  'campaign_businesses',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    campaignId: uuid('campaign_id')
      .notNull()
      // RESTRICT, as with campaign_rules: deleting a campaign would delete the evidence behind
      // every reservation validated against it.
      .references(() => campaigns.id, { onDelete: 'restrict' }),

    /** Monotonic per campaign. Numbers are never reused. */
    version: integer('version').notNull(),
    status: campaignRuleStatusEnum('status').notNull().default('draft'),

    /** As the business writes it. This is what a participant is shown; never the normalized form. */
    name: text('name').notNull(),
    /**
     * `normalizeBusinessName(name)`. Written by the application, compared by the database.
     *
     * Denormalized deliberately: comparison happens on every reservation validation, and
     * normalizing every candidate row at query time would turn an index lookup into a scan.
     */
    normalizedName: text('normalized_name').notNull(),

    /** Null for a single-location business, which should not have to invent a branch. */
    branch: text('branch'),
    normalizedBranch: text('normalized_branch'),

    /**
     * The number a Visit A participant is told to call (§13.8).
     *
     * A business phone, not a participant's — so it is ordinary configuration rather than PII, and
     * it is the one phone number in this system that may appear in a message body verbatim.
     */
    phone: text('phone'),
    /** Where a Visit B or C participant books (§13.9, §13.10). */
    bookingUrl: text('booking_url'),

    effectiveFrom: tstz('effective_from').notNull(),
    effectiveTo: tstz('effective_to'),

    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique('campaign_businesses_version_key').on(table.campaignId, table.version),
    index('campaign_businesses_lookup_idx').on(table.campaignId, table.effectiveFrom),
    // Matching starts from the normalized name, so that is what carries the index.
    index('campaign_businesses_normalized_idx').on(table.normalizedName),

    // At most one open-ended published version per campaign — the same reasoning as
    // campaign_rules_one_current_idx: two would give "the current business" two answers.
    uniqueIndex('campaign_businesses_one_current_idx')
      .on(table.campaignId)
      .where(sql`${table.effectiveTo} is null and ${table.status} = 'published'`),
  ],
)

// Approved alternative names (FR-CAM-004, T23).
//
// A TABLE, NOT A DELIMITED STRING. A business is genuinely known by several names — its legal name,
// the name on its sign, its Naver listing — and packing them into one column breaks the first time
// one of those names contains the delimiter. Which, for Korean business names full of middle dots
// and parentheses, is soon.
//
// AN ALIAS IS AN AUTHORIZATION, not a convenience. §16.7 validates against "approved alias", and a
// plausible-looking nickname that nobody approved must not validate a booking. That is why the list
// is explicit and versioned with the business rather than inferred.
export const campaignBusinessAliases = pgTable(
  'campaign_business_aliases',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * CASCADE is safe for the same reason it is on the time windows: a published business version
     * cannot be deleted (the 0007 trigger refuses), so the only cascade that can fire is from
     * discarding a draft.
     */
    campaignBusinessId: uuid('campaign_business_id')
      .notNull()
      .references(() => campaignBusinesses.id, { onDelete: 'cascade' }),

    alias: text('alias').notNull(),
    normalizedAlias: text('normalized_alias').notNull(),

    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (table) => [
    // Two aliases that normalize identically are the same alias written twice.
    unique('campaign_business_aliases_key').on(table.campaignBusinessId, table.normalizedAlias),
    index('campaign_business_aliases_normalized_idx').on(table.normalizedAlias),
  ],
)

export type CampaignBusinessRow = typeof campaignBusinesses.$inferSelect
export type NewCampaignBusinessRow = typeof campaignBusinesses.$inferInsert
export type CampaignBusinessAliasRow = typeof campaignBusinessAliases.$inferSelect
export type NewCampaignBusinessAliasRow = typeof campaignBusinessAliases.$inferInsert
