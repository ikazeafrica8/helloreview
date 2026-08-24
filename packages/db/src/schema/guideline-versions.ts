import { check, index, integer, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { tstz } from '../columns.js'
import { campaigns } from './campaigns.js'
import { campaignRuleStatusEnum } from './campaign-rules.js'

// Versioned guideline content (PRD §17.2, §17.3, FR-CAM-005, FR-GDL-001/003, T24).
//
// WHAT A GUIDELINE VERSION IS FOR. §13.12 requires a delivery to record which guideline the
// participant actually received, and FR-GDL-003 requires the full evidence of that delivery to be
// reconstructable afterwards. That is only possible if the version number names content that cannot
// have changed since. So the version is the unit of evidence, not a convenience for editors.
//
// REUSES campaign_rules' STATUS ENUM rather than inventing one. draft may be edited, published is
// frozen and referenceable, superseded is a published version a later one replaced — still frozen,
// because the deliveries citing it are not going anywhere. campaign_businesses already reuses this
// enum for the same reason; a third parallel vocabulary for the same three states would mean three
// places to look when asking "is this frozen?".
//
// TEMPLATES TAKE THE OPPOSITE DECISION, deliberately, and the difference is worth stating because
// they look similar. A guideline is EFFECTIVE-DATED — §17.2 describes it as having "active dates" —
// because §16.9's eligibility predicate asks which guideline applied at an instant. A template is
// not: which template was used is recorded ON the message (§17.4 puts template_or_content_version
// in the dedupe key), so it is read back from the message rather than resolved by time. Giving
// templates a window too would create a second, contradictory way to answer the same question.
//
// FREEZING IS ENFORCED BY TRIGGER, not by convention (migration 0010, same shape as 0005). The
// application could simply never issue the UPDATE, and that holds right up until the first admin
// script or well-meaning fix. Only PUBLISHED and SUPERSEDED rows are frozen — a draft is still
// being written.

export const guidelineVersions = pgTable(
  'guideline_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    campaignId: uuid('campaign_id')
      .notNull()
      // RESTRICT, not CASCADE. Deleting a campaign that has published guidelines would delete the
      // evidence behind every guideline delivery made under it — SPEC.md §8 "Never".
      .references(() => campaigns.id, { onDelete: 'restrict' }),

    /**
     * Monotonic per campaign, starting at 1, never reused.
     *
     * An integer because it is compared, not just displayed: `GUIDELINE_DELIVERY:<version>` is a
     * §14.1 dedupe purpose and §23.1 logs `guideline_v4`, and "is this delivery based on a stale
     * guideline?" has to be answerable.
     */
    version: integer('version').notNull(),

    status: campaignRuleStatusEnum('status').notNull().default('draft'),

    /**
     * The guideline itself, as text and/or a reference to a stored file.
     *
     * §17.2 says "content/file reference" — both are legitimate, because a guideline may be a short
     * block of Korean text or a PDF in object storage. The CHECK below requires at least one, since
     * a version with neither is a delivery that cannot be rendered, discovered at send time.
     */
    bodyText: text('body_text'),
    contentUri: text('content_uri'),

    /**
     * When this version applied. §17.2's "active dates".
     *
     * `effectiveTo` is null for the version currently in force. Publishing a successor sets the
     * predecessor's — the one legitimate write to a frozen row, and therefore the single exception
     * the freeze trigger allows.
     */
    effectiveFrom: tstz('effective_from').notNull(),
    effectiveTo: tstz('effective_to'),

    /** Who published it, for §21.2 auditability. Masked or pseudonymous, never a raw name. */
    publishedBy: text('published_by'),
    publishedAt: tstz('published_at'),

    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (table) => [
    // PRD §17.3, verbatim: UNIQUE(guideline_versions.campaign_id, guideline_versions.version).
    unique('guideline_versions_version_key').on(table.campaignId, table.version),

    // "Which guideline applies to this campaign right now" is the query this table exists to serve.
    index('guideline_versions_effective_idx').on(table.campaignId, table.effectiveFrom),

    // AT MOST ONE open-ended published version per campaign. Without it two rows could both have
    // effectiveTo null and "the current guideline" would have two answers, with the resolver
    // silently taking whichever the planner returned first.
    //
    // A partial unique INDEX, not a constraint: PostgreSQL constraints cannot carry a WHERE clause,
    // and an unconditional one would forbid the ordinary case of many superseded versions.
    uniqueIndex('guideline_versions_one_current_idx')
      .on(table.campaignId)
      .where(sql`${table.effectiveTo} is null and ${table.status} = 'published'`),

    // A version with no content at all is unrenderable, and the only place that surfaces is the
    // moment of delivery — which FR-GDL-001 requires to be predictable.
    check('guideline_versions_has_content', sql`${table.bodyText} is not null or ${table.contentUri} is not null`),

    // Version zero/negative values cannot participate in monotonic history or a delivery key.
    check('guideline_versions_positive_version', sql`${table.version} > 0`),

    // A closed interval must contain time. Otherwise no instant can truthfully resolve to it.
    check(
      'guideline_versions_valid_window',
      sql`${table.effectiveTo} is null or ${table.effectiveTo} > ${table.effectiveFrom}`,
    ),

    // UPDATE triggers enforce the lifecycle; this CHECK also covers a direct INSERT as published.
    check(
      'guideline_versions_publish_evidence',
      sql`${table.status} = 'draft' or (${table.publishedBy} is not null and ${table.publishedAt} is not null)`,
    ),
  ],
)

export type GuidelineVersionRow = typeof guidelineVersions.$inferSelect
export type NewGuidelineVersionRow = typeof guidelineVersions.$inferInsert
