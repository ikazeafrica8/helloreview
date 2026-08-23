import { index, pgEnum, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core'
import { tstz } from '../columns.js'
import { campaignTypeEnum, visitMethodEnum } from './enums.js'

// Campaign master (PRD §17.2, §13.5, T21).
//
// TYPE AND VISIT METHOD ARE ENUMS, NEVER TEXT. FR-CAM-001 and FR-CAM-002 say so, and the acceptance
// condition explains why: "Routing never depends on repeated free-text interpretation." A campaign
// whose type is a string is a campaign whose routing is decided by a comparison someone has to get
// right in every module that reads it — and the failure mode is not an error, it is a participant
// silently routed down the wrong workflow.
//
// visit_method is NOT NULL, using the `not_applicable` member rather than a null. §14.2 lists that
// as a real state for shipping and payback campaigns, and it is what keeps §16.4's routing table
// TOTAL: every (type, visit_method) pair has a defined row, so the rules engine never has to decide
// what a null means. Whether the pair is COHERENT — a shipping campaign claiming Visit B — is T25's
// activation validation, because that is the moment the combination has to make sense.

/**
 * Where a campaign is in its own lifecycle.
 *
 * FR-CAM-006: "Missing required configuration prevents the campaign from entering automated mode."
 * So `draft` is not a formality — it is the state a campaign sits in until T25's validation passes,
 * and the transition out of it is the gate. §16.7's "Campaign status / Campaign is open" check
 * reads this.
 *
 * `paused` is distinct from `closed`: paused stops new work while leaving in-flight participants
 * addressable, closed is terminal. Collapsing them would make "stop accepting applications but
 * finish the ones we have" unexpressible, which is the ordinary way a campaign ends.
 */
export const campaignStatusEnum = pgEnum('campaign_status', ['draft', 'active', 'paused', 'closed'])

export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** The identifier operators use in conversation and in the admin console. */
    code: text('code').notNull(),
    name: text('name').notNull(),

    /** FR-CAM-001. Shipping, Payback or Visit — never inferred from text. */
    type: campaignTypeEnum('type').notNull(),
    /** FR-CAM-002. `not_applicable` for shipping and payback; see the note above. */
    visitMethod: visitMethodEnum('visit_method').notNull().default('not_applicable'),

    status: campaignStatusEnum('status').notNull().default('draft'),

    /**
     * Campaign operating period.
     *
     * §16.7's "Date period" check compares a reservation date against these, so both are required:
     * an open-ended campaign would make that check unimplementable rather than permissive.
     */
    startsAt: tstz('starts_at').notNull(),
    endsAt: tstz('ends_at').notNull(),

    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    // Operators refer to campaigns by code; two campaigns sharing one would make every
    // conversational reference ambiguous.
    unique('campaigns_code_key').on(table.code),
    index('campaigns_status_idx').on(table.status),
    index('campaigns_period_idx').on(table.startsAt, table.endsAt),
  ],
)

export type CampaignRow = typeof campaigns.$inferSelect
export type NewCampaignRow = typeof campaigns.$inferInsert
