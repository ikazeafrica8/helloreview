import { index, integer, jsonb, pgEnum, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { tstz } from '../columns.js'
import { campaigns } from './campaigns.js'

// Versioned, effective-dated campaign rules (PRD §17.2, FR-CAM-004/005/007, T21).
//
// A RULE VERSION IS NEVER MUTATED. Changing a rule creates a new version; the old one stays exactly
// as it was. That is not tidiness — it is what makes a past decision explicable. PRD §21.2 requires
// a decision to be reconstructable, and §18.7's selection payload carries `rule_version` precisely
// so the reader can go and look at the rules that were in force. If a version could be edited, the
// version number would name something that no longer exists, and every historical decision would
// become unauditable at once.
//
// Enforced by TRIGGER, not by convention. The application could simply never issue an UPDATE, and
// that would hold right up until the first migration, admin script, or well-meaning fix. The same
// reasoning as audit_logs in T13: a guarantee that depends on everyone remembering is not a
// guarantee. Only PUBLISHED versions are frozen — a draft is still being written.
//
// EFFECTIVE DATING, and why it is separate from the version number. The version says WHICH rules;
// the effective window says WHEN they applied. FR-CAM-007 requires rule changes affecting active
// participants to define whether old or new rules apply, and that question is answerable only if
// both facts are recorded: a workflow started under version 3 keeps referencing version 3, while a
// new workflow resolves whatever version is effective now.

/**
 * Which aspect of the campaign a version configures.
 *
 * Separate rule types version INDEPENDENTLY, deliberately. Correcting a blackout date should not
 * invalidate the selection threshold that participants were judged against, and forcing them into
 * one version would mean every edit re-versions everything — making `rule_version` far too coarse
 * to answer "what rules produced this decision?".
 */
export const campaignRuleTypeEnum = pgEnum('campaign_rule_type', [
  /** §16.2 selection thresholds, manual bands, score source and freshness. */
  'selection',
  /** §16.7 date period, weekdays, time windows, boundary inclusivity, lead time, blackouts. */
  'reservation',
  /** §16.9 the guideline readiness predicate and its inputs. */
  'guideline',
  /** §13.7 payback terms and the consent they require. */
  'payback',
  /** §13.6 shipping address collection and its cutoff. */
  'shipping',
])

/**
 * A version's lifecycle.
 *
 * `draft` may be edited freely. `published` is frozen and may be referenced by decisions.
 * `superseded` is a published version that a later one replaced — still frozen, still readable,
 * because the decisions that cite it are not going anywhere.
 */
export const campaignRuleStatusEnum = pgEnum('campaign_rule_status', ['draft', 'published', 'superseded'])

export const campaignRules = pgTable(
  'campaign_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    campaignId: uuid('campaign_id')
      .notNull()
      // A rule version without its campaign is meaningless. RESTRICT rather than CASCADE: deleting
      // a campaign that has published rules would delete the evidence behind every decision made
      // under it, which SPEC.md §8 lists under "Never".
      .references(() => campaigns.id, { onDelete: 'restrict' }),

    ruleType: campaignRuleTypeEnum('rule_type').notNull(),

    /**
     * Monotonic per (campaign, rule type). Version 1 is the first, and numbers are never reused.
     *
     * An integer rather than a semantic string: `rule_version` appears in §18.7 payloads and in
     * §23.1 log lines, and it has to be comparable to answer "is this decision based on stale
     * rules?".
     */
    version: integer('version').notNull(),

    status: campaignRuleStatusEnum('status').notNull().default('draft'),

    /**
     * The rules themselves.
     *
     * jsonb rather than columns per rule type, because the five types have almost nothing in
     * common and a table with the union of their fields would be mostly nulls — with no way for
     * the database to say which nulls are legal for which type. The SHAPE is validated by a Zod
     * schema at the boundary (T25), which is where a rule set is checked before it can be
     * published, and where an unknown field can actually be rejected with a useful message.
     */
    configuration: jsonb('configuration').notNull(),

    /**
     * When this version starts and stops applying.
     *
     * `effectiveTo` is null for the version currently in force. Publishing a new version sets the
     * previous one's `effectiveTo`, which is the one legitimate write to a published row and is
     * therefore the single exception the trigger below allows.
     */
    effectiveFrom: tstz('effective_from').notNull(),
    effectiveTo: tstz('effective_to'),

    /** Who published it, for §21.2 auditability. Masked or pseudonymous, never a raw name. */
    publishedBy: text('published_by'),
    publishedAt: tstz('published_at'),

    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (table) => [
    // PRD §17.2: "Unique campaign + rule type + version". The constraint that makes a version
    // number mean something.
    unique('campaign_rules_version_key').on(table.campaignId, table.ruleType, table.version),

    // Resolving "which version is effective at instant X" is the query the whole table exists to
    // serve, and it filters on exactly these.
    index('campaign_rules_effective_idx').on(table.campaignId, table.ruleType, table.effectiveFrom),
    index('campaign_rules_status_idx').on(table.status),

    // AT MOST ONE version of a rule type may be open-ended per campaign. Without this, two
    // published versions could both have effectiveTo = null and "the current rules" would have two
    // answers — with the resolver silently picking whichever the planner returned first.
    //
    // A partial unique INDEX, not a unique CONSTRAINT: Postgres constraints cannot carry a WHERE
    // clause, and an unconditional constraint here would forbid the ordinary case of many
    // superseded versions all sharing (campaign, rule type).
    uniqueIndex('campaign_rules_one_current_idx')
      .on(table.campaignId, table.ruleType)
      .where(sql`${table.effectiveTo} is null and ${table.status} = 'published'`),
  ],
)

export type CampaignRuleRow = typeof campaignRules.$inferSelect
export type NewCampaignRuleRow = typeof campaignRules.$inferInsert
