import { boolean, check, index, integer, pgEnum, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { tstz } from '../columns.js'

// Versioned, legally-classified message templates (PRD §17.2, §17.3, §21.9, FR-CAM-005, T24).
//
// GLOBAL, NOT PER CAMPAIGN. §17.3's constraint is UNIQUE(purpose_code, version) with no campaign in
// it, and §32's templates are written once with campaign specifics as variables ({{campaign_name}},
// {{business_name}}, {{payback_terms}}). That is not an omission to work around: §21.9 legal review
// and Alimtalk approval attach to the TEXT, so per-campaign copies would mean submitting identical
// wording for provider approval N times and N chances for one copy to drift out of review.
//
// The consequence, stated plainly because it constrains the product: a campaign cannot have bespoke
// wording. Genuinely different wording needs a new purpose code — a reviewed change to
// packages/contracts/src/purposes.ts, which gets its own dedupe namespace.
//
// THE PURPOSE CODE HERE IS THE APPROVED TEMPLATE NAMESPACE. §32 has 33 templates but
// packages/contracts/src/purposes.ts has 20 codes, because seven §32 templates are all reservation
// corrections. Those variants include the rule parameter, while delivery-specific parameters stay
// in the outbound dedupe purpose and do not multiply approved templates:
//
//     RESERVATION_CORRECTION:INVALID_WEEKDAY
//     GUIDELINE_DELIVERY
//
// which satisfies §17.3 exactly as written while letting all 33 templates coexist. The registry in
// purposes.ts still holds STEMS only — a stem plus its parameter is composed, never spelled by hand
// at a call site, so one purpose cannot end up with two spellings and therefore two dedupe
// namespaces that look like one.
//
// LANGUAGE IS NOT IN THE UNIQUE KEY, following §17.3 literally. A version number therefore
// identifies exactly one piece of approved content, which is what a §17.4 dedupe key and an audit
// record want. The cost is real and accepted: a second language for the same version needs a
// migration widening the constraint. The product is Korean-only (§32 is entirely Korean).

/**
 * A template's lifecycle. FOUR states, where campaign_rules has three, and the difference is the
 * point rather than an inconsistency.
 *
 * For a rule version, freezing and taking effect are one event: publishing IS putting it in force.
 * For a template they are separated by days. Content must freeze when legal review signs off — so
 * the §21.9 classification describes exact bytes, and so the text submitted to Kakao for Alimtalk
 * approval is the text that was reviewed — but it is not sendable until an operator activates it.
 *
 * `retired` rather than `superseded` for the same reason: a template can be withdrawn with NO
 * successor (counsel pulls a "potentially advertising" template, or a purpose is discontinued).
 * Under the three-state enum that is unrepresentable — you either invent a phantom successor or
 * leave it published, and published means the resolver keeps returning it.
 */
export const messageTemplateStatusEnum = pgEnum('message_template_status', [
  /** Being written. The only editable state. */
  'draft',
  /** Legal review complete; content frozen. Not sendable. */
  'approved',
  /** Frozen and in force. At most one per purpose code. */
  'active',
  /** Frozen and out of force, with or without a successor. */
  'retired',
])

/**
 * The §21.9 classification. Exactly the five the PRD names — not a superset, not renamed.
 *
 * NOT NULL and deliberately WITHOUT a default. A default here would mean a schema author making a
 * legal determination for every template nobody classified, which is the quiet version of the thing
 * §21.9 exists to prevent.
 */
export const messageLegalClassificationEnum = pgEnum('message_legal_classification', [
  'operational_transactional',
  'consent_related',
  'service_notice',
  'potentially_advertising',
  'definitely_advertising',
])

export const messageTemplates = pgTable(
  'message_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * The full §14.1 purpose, parameter included. See the note at the top of this file.
     *
     * Validated at the boundary rather than by a pg enum: the parameterised forms are open-ended
     * (one per §16.7 reservation rule), and an enum would mean a migration every time a correction
     * rule is added — with the failure landing at insert time in production rather than at review.
     */
    purposeCode: text('purpose_code').notNull(),

    /**
     * §17.2 calls this "language", so this column does too. ISO 639-1.
     *
     * Present but NOT in the unique key — see the note at the top. It exists so a template can say
     * what it is rather than leaving readers to infer Korean from the content.
     */
    language: text('language').notNull().default('ko'),

    /** Monotonic per purpose code, starting at 1, never reused. */
    version: integer('version').notNull(),

    status: messageTemplateStatusEnum('status').notNull().default('draft'),

    legalClassification: messageLegalClassificationEnum('legal_classification').notNull(),

    /**
     * The template text, with {{variable}} placeholders.
     *
     * Stored rather than referenced: §21.9 review is of exact bytes, and a template whose content
     * lives elsewhere can change without the version changing.
     */
    body: text('body').notNull(),

    /**
     * The §21.9 review OUTCOMES, recorded rather than derived.
     *
     * Deriving these from the classification with a lookup table would be the same
     * automated-legal-determination problem one level down: it would mean a code change silently
     * reclassifying already-approved templates. These are what a reviewer decided about THIS text.
     */
    requiresPriorConsent: boolean('requires_prior_consent').notNull().default(false),
    respectsQuietHours: boolean('respects_quiet_hours').notNull().default(true),
    requiresOptOutNotice: boolean('requires_opt_out_notice').notNull().default(false),
    requiresSenderIdentification: boolean('requires_sender_identification').notNull().default(false),
    /** Whether this text needs Alimtalk template approval from the provider before it can send. */
    requiresProviderApproval: boolean('requires_provider_approval').notNull().default(false),
    /** The provider's identifier for the approved template, once it has one. */
    providerTemplateCode: text('provider_template_code'),

    /** Who completed §21.9 review, and when. Masked or pseudonymous, never a raw name. */
    approvedBy: text('approved_by'),
    approvedAt: tstz('approved_at'),
    activatedAt: tstz('activated_at'),
    retiredAt: tstz('retired_at'),

    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (table) => [
    // PRD §17.3, verbatim: UNIQUE(message_templates.purpose_code, message_templates.version).
    unique('message_templates_version_key').on(table.purposeCode, table.version),

    // AT MOST ONE active version per purpose. Without it "the template to send" has two answers.
    uniqueIndex('message_templates_one_active_idx')
      .on(table.purposeCode)
      .where(sql`${table.status} = 'active'`),

    index('message_templates_status_idx').on(table.status),

    check('message_templates_positive_version', sql`${table.version} > 0`),
    check('message_templates_nonempty_body', sql`length(btrim(${table.body})) > 0`),

    // These checks cover direct INSERTs; the trigger covers legal UPDATE transitions.
    check(
      'message_templates_approval_evidence',
      sql`${table.status} = 'draft' or (${table.approvedBy} is not null and ${table.approvedAt} is not null)`,
    ),
    check(
      'message_templates_activation_evidence',
      sql`${table.status} <> 'active' or ${table.activatedAt} is not null`,
    ),
    check('message_templates_retirement_evidence', sql`${table.status} <> 'retired' or ${table.retiredAt} is not null`),
    check(
      'message_templates_provider_approval',
      sql`${table.status} <> 'active' or not ${table.requiresProviderApproval} or ${table.providerTemplateCode} is not null`,
    ),
  ],
)

export type MessageTemplateRow = typeof messageTemplates.$inferSelect
export type NewMessageTemplateRow = typeof messageTemplates.$inferInsert
