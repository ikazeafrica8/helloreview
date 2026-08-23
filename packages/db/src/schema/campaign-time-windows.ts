import { boolean, index, pgEnum, pgTable, time, unique, uuid } from 'drizzle-orm/pg-core'
import { tstz } from '../columns.js'
import { campaignRules } from './campaign-rules.js'

// Allowed reservation windows, per weekday (PRD §16.7, §17.2, FR-RES-004/005, T22).
//
// BOUND TO A RULE VERSION, NOT TO A CAMPAIGN. This is the decision the whole table turns on. If
// windows hung off the campaign, editing one would retroactively change what "valid" meant for
// every reservation already validated against the old windows — the silent retroactive rule
// application FR-CAM-007 forbids. Hanging them off `campaign_rules.id` means a window set is part
// of an immutable published version, so a past validation can still be explained.
//
// MULTIPLE WINDOWS PER WEEKDAY, and all of them are evaluated. A business open 11:00–14:00 and
// again 17:00–21:00 is the ordinary case, not an exotic one, and §16.7's Time check reads "Time
// falls inside AT LEAST ONE allowed interval". A schema with one start and one end per weekday
// cannot express the lunch break, and the workaround — one window spanning it — silently accepts
// reservations at 15:00 when the business is closed.
//
// BOUNDARY INCLUSIVITY IS PER WINDOW, not a global setting. §16.7 lists Boundary as its own check
// with the failure action "Apply configured inclusive/exclusive rule". A shop may accept a booking
// AT closing time for a 10-minute service and refuse it for a 90-minute one, and that is a property
// of the window, not of the platform.

/** ISO-8601 weekday numbering: 1 = Monday through 7 = Sunday. */
export const weekdayEnum = pgEnum('weekday', ['1', '2', '3', '4', '5', '6', '7'])

export const campaignTimeWindows = pgTable(
  'campaign_time_windows',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * The rule version this window belongs to.
     *
     * CASCADE on delete is safe here and only here: a window has no meaning without its version,
     * and the version itself cannot be deleted once published (the 0005 trigger refuses). So the
     * only cascade that can ever fire is from deleting a DRAFT, which is exactly when discarding
     * its windows is correct.
     */
    campaignRuleId: uuid('campaign_rule_id')
      .notNull()
      .references(() => campaignRules.id, { onDelete: 'cascade' }),

    weekday: weekdayEnum('weekday').notNull(),

    /**
     * Local wall-clock times in the campaign's timezone (Asia/Seoul per §16.7's Timezone check).
     *
     * `time` without a zone, deliberately. "Open at 11:00" is a wall-clock fact about the business
     * that does not shift with the date; storing it as timestamptz would attach it to a particular
     * day and make it wrong across a DST boundary in any timezone that has one. Korea has no DST
     * today, which is exactly why this decision must be written down rather than discovered later
     * by whoever adds a second country.
     */
    startsAt: time('starts_at').notNull(),
    endsAt: time('ends_at').notNull(),

    /** Is a reservation exactly at `startsAt` inside the window? Usually yes. */
    startInclusive: boolean('start_inclusive').notNull().default(true),
    /**
     * Is a reservation exactly at `endsAt` inside the window?
     *
     * Defaults to FALSE, and the asymmetry is deliberate: a window written as 11:00–14:00 normally
     * means the business stops taking bookings at 14:00, not that 14:00 is the last acceptable
     * slot. Defaulting both ends to inclusive would make adjacent windows overlap at their shared
     * boundary, so 14:00 would fall in both the morning and the afternoon window.
     */
    endInclusive: boolean('end_inclusive').notNull().default(false),

    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (table) => [
    // The validator loads every window for one version and weekday, which is exactly this.
    index('campaign_time_windows_lookup_idx').on(table.campaignRuleId, table.weekday),

    // Two IDENTICAL windows are a configuration mistake, not a second opportunity — they would be
    // evaluated twice to the same answer. Distinct overlapping windows remain legal: 11:00–14:00
    // and 13:00–15:00 is unusual but coherent, and refusing it would be the schema overreaching
    // into a judgement T25's activation validation is better placed to make.
    unique('campaign_time_windows_no_duplicate_key').on(
      table.campaignRuleId,
      table.weekday,
      table.startsAt,
      table.endsAt,
    ),
  ],
)

export type CampaignTimeWindowRow = typeof campaignTimeWindows.$inferSelect
export type NewCampaignTimeWindowRow = typeof campaignTimeWindows.$inferInsert
