import { date, index, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core'
import { tstz } from '../columns.js'
import { campaignRules } from './campaign-rules.js'

// Dates on which no reservation is valid (PRD §16.7, §17.2, T22).
//
// Bound to a rule version for the same reason the time windows are: a blackout added today must not
// retroactively invalidate a reservation that was correctly accepted last week. §16.7's Blackout
// check reads the version that was in force when the reservation was made.
//
// A DATE, NOT A TIMESTAMP. A blackout is a calendar fact — "we are closed on Seollal" — and the day
// it refers to is a day in Asia/Seoul, not an instant. Storing it as timestamptz would force every
// comparison to pick a time of day, and the natural choice, midnight UTC, is 09:00 in Seoul: a
// reservation at 08:00 Seoul on a blacked-out day would compare as belonging to the previous date
// and pass. §16.7's Timezone check exists precisely because this class of mistake is easy.

export const campaignBlackouts = pgTable(
  'campaign_blackouts',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** CASCADE is safe only because a published version cannot be deleted — see the 0005 trigger. */
    campaignRuleId: uuid('campaign_rule_id')
      .notNull()
      .references(() => campaignRules.id, { onDelete: 'cascade' }),

    /** The calendar date, interpreted in the campaign's timezone. */
    blackoutDate: date('blackout_date').notNull(),

    /**
     * Why. Free text, and shown to nobody outside operations.
     *
     * §16.7's failure action is a "Blackout-date correction" message, and that message comes from
     * an approved template — never from this field. A participant-facing message assembled from
     * operator free text is how an internal note reaches a participant.
     */
    reason: text('reason'),

    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (table) => [
    // PRD §17.2: "Unique campaign/version/date". The version is the campaign here, transitively.
    unique('campaign_blackouts_date_key').on(table.campaignRuleId, table.blackoutDate),
    index('campaign_blackouts_lookup_idx').on(table.campaignRuleId, table.blackoutDate),
  ],
)

export type CampaignBlackoutRow = typeof campaignBlackouts.$inferSelect
export type NewCampaignBlackoutRow = typeof campaignBlackouts.$inferInsert
