import { z } from 'zod'
import type { SelectionPolicy } from './recommendation-evaluator.js'

/**
 * The only visitor metric period this platform can currently produce.
 *
 * The website exports `블로그일평균방문자수` — average daily blog visitors — into
 * `applications.blog_daily_visitors`. Naming the period after the column's real meaning is what
 * makes a policy that claims previous-day traffic FAIL rather than silently score a relabelled
 * metric. A separately sourced previous-day metric would be a new member here and a new evidence
 * source, not a rename of this one.
 */
export const VISITOR_MEASUREMENT_PERIODS = ['website_average_daily'] as const
export type VisitorMeasurementPeriod = (typeof VISITOR_MEASUREMENT_PERIODS)[number]

export const SOURCE_VISITOR_MEASUREMENT_PERIOD: VisitorMeasurementPeriod = 'website_average_daily'

/**
 * Whether a non-selected applicant is told.
 *
 * PRD §14.1 purpose 7 makes the non-selection notice campaign policy rather than a default, because
 * the right answer differs by campaign and neither choice is safe to assume.
 */
export const NON_SELECTION_POLICIES = ['send_notice', 'suppress_notice'] as const
export type NonSelectionPolicy = (typeof NON_SELECTION_POLICIES)[number]

export type SelectionRuleConfiguration = Readonly<{
  measurementPeriod: VisitorMeasurementPeriod
  eligibleLevels: readonly number[]
  minimumDailyVisitors: number
  /**
   * The lower threshold for a blogger the campaign-region mapping says is regional.
   *
   * The product owner described regional bloggers remaining eligible around 300 visitors. Storing it
   * as versioned campaign policy is what makes that a decision somebody published rather than a
   * number a service invented.
   */
  regionalMinimumDailyVisitors: number
  reviewBand: Readonly<{ lowerInclusive: number; upperInclusive: number }>
  /** Source region string -> mapped region name. Both sides are campaign policy, never inferred. */
  regionMapping: Readonly<Record<string, string>>
  eligibleMappedRegions: readonly string[]
  regionalMappedRegions: readonly string[]
  nonSelectionPolicy: NonSelectionPolicy
  /**
   * Pinned false. Present so the field is provably false rather than absent and assumed.
   *
   * T129 is the only task that may ever change it, and it carries its own approval gate: the metric
   * period, region matching, provenance, thresholds, legal review, and measured shadow performance
   * all have to land first. Until then the schema refuses to store `true`.
   */
  automaticSelectionEnabled: false
}>

const region = z.string().trim().min(1).max(100)

const selectionRuleConfigurationSchema = z
  .strictObject({
    measurementPeriod: z.enum(VISITOR_MEASUREMENT_PERIODS),
    eligibleLevels: z.array(z.number().int().min(1).max(10)).min(1).max(10),
    minimumDailyVisitors: z.number().int().min(0).max(10_000_000),
    regionalMinimumDailyVisitors: z.number().int().min(0).max(10_000_000),
    reviewBand: z.strictObject({
      lowerInclusive: z.number().int().min(0).max(10_000_000),
      upperInclusive: z.number().int().min(0).max(10_000_000),
    }),
    regionMapping: z.record(region, region),
    eligibleMappedRegions: z.array(region).min(1).max(100),
    regionalMappedRegions: z.array(region).max(100),
    nonSelectionPolicy: z.enum(NON_SELECTION_POLICIES),
    automaticSelectionEnabled: z.literal(false),
  })
  .superRefine((configuration, context) => {
    if (configuration.reviewBand.upperInclusive < configuration.reviewBand.lowerInclusive)
      context.addIssue({ code: 'custom', path: ['reviewBand'], message: 'review band must not be inverted' })
    if (new Set(configuration.eligibleLevels).size !== configuration.eligibleLevels.length)
      context.addIssue({ code: 'custom', path: ['eligibleLevels'], message: 'eligible levels must be unique' })
    if (new Set(configuration.eligibleMappedRegions).size !== configuration.eligibleMappedRegions.length)
      context.addIssue({ code: 'custom', path: ['eligibleMappedRegions'], message: 'regions must be unique' })
    // A regional region the campaign does not consider eligible at all is a contradiction, and the
    // regional threshold below would silently never apply.
    for (const regional of configuration.regionalMappedRegions)
      if (!configuration.eligibleMappedRegions.includes(regional))
        context.addIssue({
          code: 'custom',
          path: ['regionalMappedRegions'],
          message: 'a regional region must also be an eligible region',
        })
    // Every mapping target has to be a region the campaign actually recognises, or the mapping
    // produces a value no threshold is defined for.
    for (const mapped of Object.values(configuration.regionMapping))
      if (!configuration.eligibleMappedRegions.includes(mapped))
        context.addIssue({
          code: 'custom',
          path: ['regionMapping'],
          message: 'every mapped region must be an eligible region',
        })
  })

/**
 * Parse a published `campaign_rules` selection configuration.
 *
 * Undefined rather than a throw, matching `parseReservationRuleConfiguration`: an unparseable
 * configuration is a configuration error the evaluator reports as human review, not a crash. Nothing
 * here supplies a default — a threshold this function invented would be a selection policy nobody
 * approved.
 */
export const parseSelectionRuleConfiguration = (value: unknown): SelectionRuleConfiguration | undefined => {
  const parsed = selectionRuleConfigurationSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

/** Project a published configuration onto the evaluator's policy shape. */
export const selectionPolicyFrom = (
  configuration: SelectionRuleConfiguration,
  ruleVersion: number,
): SelectionPolicy => ({
  version: `selection-rule-v${String(ruleVersion)}`,
  eligibleLevels: [...configuration.eligibleLevels],
  minimumDailyVisitors: configuration.minimumDailyVisitors,
  reviewBand: { ...configuration.reviewBand },
  eligibleMappedRegions: [...configuration.eligibleMappedRegions],
  measurementPeriod: configuration.measurementPeriod,
})
