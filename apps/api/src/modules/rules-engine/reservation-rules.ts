import { evaluateRule, type DeterministicRule, type RuleEvaluationResult } from './rule-evaluator.js'
import { z } from 'zod'
import {
  RESERVATION_CORRECTION,
  RESERVATION_RULE,
  type ReservationCorrectionCode,
  type ReservationRuleCode,
} from './reason-codes.js'

export type ReservationWindow = Readonly<{
  startsAt: string
  endsAt: string
  startInclusive: boolean
  endInclusive: boolean
}>

export type ReservationEvidence = Readonly<{
  campaignId: string
  normalizedBusinessName: string
  normalizedBranchName: string
  localDate: string
  localTime: string
  timezone: string
  bookingMethod: 'visit_a' | 'visit_b' | 'visit_c'
  businessApprovalState:
    | 'not_required'
    | 'not_requested'
    | 'pending'
    | 'approved'
    | 'rejected'
    | 'expired'
    | 'revoked'
    | 'human_review_required'
  reservationStatus: 'completed' | 'incomplete' | 'cancelled' | 'replaced'
  campaignStatus: 'draft' | 'active' | 'paused' | 'closed'
  capacityAvailable?: boolean | undefined
}>

export type ReservationRuleConfiguration = Readonly<{
  expectedCampaignId: string
  businesses: readonly Readonly<{ normalizedName: string; normalizedBranch: string }>[]
  campaignStartsOn: string
  campaignEndsOn: string
  allowedIsoWeekdays: readonly number[]
  windowsByIsoWeekday: Readonly<Record<string, readonly ReservationWindow[]>>
  timezone: 'Asia/Seoul'
  bookingMethod: 'visit_a' | 'visit_b' | 'visit_c'
  requireCurrentBusinessApproval: boolean
  acceptedReservationStatus: 'completed'
  minimumLeadMinutes: number
  blackoutDates: readonly string[]
  requiredCampaignStatus: 'active'
  capacityRestrictionConfigured: boolean
}>

export type ReservationRuleSet = Readonly<{
  version: number
  configuration?: ReservationRuleConfiguration
}>

/**
 * ONE definition, used by both the complete-configuration parser and the BUSINESS rule's own
 * parser. They previously disagreed about `normalizedBranch`: the complete parser accepted an
 * empty branch while the rule parser required one, so a valid single-location campaign published
 * without a branch parsed at the top level and then failed the rule as a configuration error.
 *
 * An empty branch is the correct representation of a business with no branch: the evidence side
 * produces `normalizeBusinessName('')` for a participant who named no branch, so an empty
 * configured branch and an empty submitted branch match, and a branch the configuration does not
 * name still fails as WRONG_BUSINESS rather than as a configuration error.
 */
const businessEntrySchema = z.strictObject({
  normalizedName: z.string().trim().min(1),
  normalizedBranch: z.string(),
})

const completeReservationConfigurationSchema = z.strictObject({
  expectedCampaignId: z.string().trim().min(1),
  businesses: z.array(businessEntrySchema).min(1),
  campaignStartsOn: z.iso.date(),
  campaignEndsOn: z.iso.date(),
  allowedIsoWeekdays: z.array(z.number().int().min(1).max(7)).min(1),
  windowsByIsoWeekday: z.record(
    z.string().regex(/^[1-7]$/),
    z.array(
      z.strictObject({
        startsAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/),
        endsAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/),
        startInclusive: z.boolean(),
        endInclusive: z.boolean(),
      }),
    ),
  ),
  timezone: z.literal('Asia/Seoul'),
  bookingMethod: z.enum(['visit_a', 'visit_b', 'visit_c']),
  requireCurrentBusinessApproval: z.boolean(),
  acceptedReservationStatus: z.literal('completed'),
  minimumLeadMinutes: z.number().int().nonnegative(),
  blackoutDates: z.array(z.iso.date()),
  requiredCampaignStatus: z.literal('active'),
  capacityRestrictionConfigured: z.boolean(),
})

export const parseReservationRuleConfiguration = (value: unknown): ReservationRuleConfiguration | undefined => {
  const parsed = completeReservationConfigurationSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

export type ReservationValidation = Readonly<{
  outcome: 'pass' | 'fail' | 'configuration_error'
  ruleVersion: number
  results: readonly RuleEvaluationResult<ReservationRuleCode, ReservationCorrectionCode>[]
  failures: readonly RuleEvaluationResult<ReservationRuleCode, ReservationCorrectionCode>[]
}>

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const LOCAL_TIME = /^(\d{2}):(\d{2}):(\d{2})$/

const isLeapYear = (year: number): boolean => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
const daysInMonth = (year: number, month: number): number | undefined =>
  [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]

const dateParts = (value: string): Readonly<{ year: number; month: number; day: number }> | undefined => {
  const match = ISO_DATE.exec(value)
  if (match === null) return undefined
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const maximumDay = daysInMonth(year, month)
  return maximumDay !== undefined && day >= 1 && day <= maximumDay ? { year, month, day } : undefined
}

const timeSeconds = (value: string): number | undefined => {
  const match = LOCAL_TIME.exec(value)
  if (match === null) return undefined
  const hour = Number(match[1])
  const minute = Number(match[2])
  const second = Number(match[3])
  return hour <= 23 && minute <= 59 && second <= 59 ? hour * 3_600 + minute * 60 + second : undefined
}

const isoWeekday = (value: string): number | undefined => {
  const parts = dateParts(value)
  if (parts === undefined) return undefined
  const utcDay = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay()
  return utcDay === 0 ? 7 : utcDay
}

const reservationInstant = (evidence: ReservationEvidence): number | undefined => {
  const parts = dateParts(evidence.localDate)
  const seconds = timeSeconds(evidence.localTime)
  if (parts === undefined || seconds === undefined || evidence.timezone !== 'Asia/Seoul') return undefined
  const hour = Math.floor(seconds / 3_600)
  const minute = Math.floor((seconds % 3_600) / 60)
  const second = seconds % 60
  return Date.UTC(parts.year, parts.month - 1, parts.day, hour - 9, minute, second)
}

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value : undefined

const stringArray = (value: unknown): readonly string[] | undefined =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : undefined

const positiveInteger = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined

const booleanConfig = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined)

const dateConfig = (value: unknown): string | undefined => {
  const parsed = nonEmptyString(value)
  return parsed !== undefined && dateParts(parsed) !== undefined ? parsed : undefined
}

const weekdaysConfig = (value: unknown): readonly number[] | undefined =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((entry) => Number.isInteger(entry) && entry >= 1 && entry <= 7)
    ? value
    : undefined

const businessConfigurationSchema = z.array(businessEntrySchema).min(1)

const businessConfig = (
  value: unknown,
): readonly Readonly<{ normalizedName: string; normalizedBranch: string }>[] | undefined => {
  const result = businessConfigurationSchema.safeParse(value)
  return result.success ? result.data : undefined
}

const reservationWindowSchema = z
  .object({
    startsAt: z.string(),
    endsAt: z.string(),
    startInclusive: z.boolean(),
    endInclusive: z.boolean(),
  })
  .refine((window) => {
    const start = timeSeconds(window.startsAt)
    const end = timeSeconds(window.endsAt)
    return start !== undefined && end !== undefined && start < end
  })

const windowsConfigurationSchema = z.record(z.string().regex(/^[1-7]$/), z.array(reservationWindowSchema).min(1))

const windowsConfig = (value: unknown): Readonly<Record<string, readonly ReservationWindow[]>> | undefined => {
  const result = windowsConfigurationSchema.safeParse(value)
  return result.success && Object.keys(result.data).length > 0 ? result.data : undefined
}

const bookingMethodConfig = (value: unknown): ReservationEvidence['bookingMethod'] | undefined =>
  value === 'visit_a' || value === 'visit_b' || value === 'visit_c' ? value : undefined

const windowsForEvidence = (
  evidence: ReservationEvidence,
  configuration: Readonly<Record<string, readonly ReservationWindow[]>>,
): readonly ReservationWindow[] => {
  const weekday = isoWeekday(evidence.localDate)
  return weekday === undefined ? [] : (configuration[String(weekday)] ?? [])
}

const inAnyWindow = (
  evidence: ReservationEvidence,
  configuration: Readonly<Record<string, readonly ReservationWindow[]>>,
): boolean => {
  const submitted = timeSeconds(evidence.localTime)
  if (submitted === undefined) return false
  return windowsForEvidence(evidence, configuration).some((window) => {
    const start = timeSeconds(window.startsAt)
    const end = timeSeconds(window.endsAt)
    return start !== undefined && end !== undefined && submitted >= start && submitted <= end
  })
}

const boundaryAllowed = (
  evidence: ReservationEvidence,
  configuration: Readonly<Record<string, readonly ReservationWindow[]>>,
): boolean => {
  const submitted = timeSeconds(evidence.localTime)
  if (submitted === undefined) return false
  const boundaries = windowsForEvidence(evidence, configuration).filter((window) => {
    const start = timeSeconds(window.startsAt)
    const end = timeSeconds(window.endsAt)
    return submitted === start || submitted === end
  })
  if (boundaries.length === 0) return true
  return boundaries.some((window) => {
    const start = timeSeconds(window.startsAt)
    return submitted === start ? window.startInclusive : window.endInclusive
  })
}

const rule = <Configuration>(
  ruleCode: ReservationRuleCode,
  version: number,
  configuration: unknown,
  parseConfiguration: (value: unknown) => Configuration | undefined,
  submittedValue: (evidence: ReservationEvidence) => unknown,
  expectedCondition: (value: Configuration | undefined) => string,
  passes: (evidence: ReservationEvidence, value: Configuration, now: Date) => boolean,
  correction: ReservationCorrectionCode,
  retryEligible: boolean,
  reviewRequired: boolean,
): DeterministicRule<ReservationEvidence, Configuration, ReservationRuleCode, ReservationCorrectionCode> => ({
  ruleCode,
  ruleVersion: version,
  configuration,
  parseConfiguration,
  submittedValue,
  expectedCondition,
  passes,
  correction,
  retryEligible,
  reviewRequired,
  configurationCorrection: RESERVATION_CORRECTION.CONFIGURATION_REVIEW,
})

export const evaluateReservationRules = (
  evidence: ReservationEvidence,
  ruleSet: ReservationRuleSet,
  now: Date,
): ReservationValidation => {
  const config = ruleSet.configuration
  const version = ruleSet.version
  const results: readonly RuleEvaluationResult<ReservationRuleCode, ReservationCorrectionCode>[] = [
    evaluateRule(
      evidence,
      rule(
        RESERVATION_RULE.CAMPAIGN,
        version,
        config?.expectedCampaignId,
        nonEmptyString,
        (item) => item.campaignId,
        (expected) => expected ?? 'configured campaign id',
        (item, expected) => item.campaignId === expected,
        RESERVATION_CORRECTION.CAMPAIGN_REVIEW,
        true,
        true,
      ),
      now,
    ),
    evaluateRule(
      evidence,
      rule(
        RESERVATION_RULE.BUSINESS,
        version,
        config?.businesses,
        businessConfig,
        (item) => ({ name: item.normalizedBusinessName, branch: item.normalizedBranchName }),
        () => 'exact normalized business or approved alias and branch',
        (item, businesses) =>
          businesses.some(
            (business) =>
              business.normalizedName === item.normalizedBusinessName &&
              business.normalizedBranch === item.normalizedBranchName,
          ),
        RESERVATION_CORRECTION.WRONG_BUSINESS,
        true,
        false,
      ),
      now,
    ),
    evaluateRule(
      evidence,
      rule(
        RESERVATION_RULE.DATE_PERIOD,
        version,
        config === undefined ? undefined : { startsOn: config.campaignStartsOn, endsOn: config.campaignEndsOn },
        (value) => {
          if (typeof value !== 'object' || value === null || !('startsOn' in value) || !('endsOn' in value))
            return undefined
          const startsOn = dateConfig(value.startsOn)
          const endsOn = dateConfig(value.endsOn)
          return startsOn !== undefined && endsOn !== undefined && startsOn <= endsOn ? { startsOn, endsOn } : undefined
        },
        (item) => item.localDate,
        (expected) =>
          expected === undefined
            ? 'configured campaign date period'
            : `${expected.startsOn} through ${expected.endsOn}`,
        (item, expected) =>
          dateParts(item.localDate) !== undefined &&
          item.localDate >= expected.startsOn &&
          item.localDate <= expected.endsOn,
        RESERVATION_CORRECTION.INVALID_DATE,
        true,
        false,
      ),
      now,
    ),
    evaluateRule(
      evidence,
      rule(
        RESERVATION_RULE.WEEKDAY,
        version,
        config?.allowedIsoWeekdays,
        weekdaysConfig,
        (item) => isoWeekday(item.localDate) ?? item.localDate,
        (expected) => (expected === undefined ? 'configured allowed weekdays' : `ISO weekdays ${expected.join(',')}`),
        (item, expected) => {
          const submitted = isoWeekday(item.localDate)
          return submitted !== undefined && expected.includes(submitted)
        },
        RESERVATION_CORRECTION.INVALID_WEEKDAY,
        true,
        false,
      ),
      now,
    ),
    evaluateRule(
      evidence,
      rule(
        RESERVATION_RULE.TIME,
        version,
        config?.windowsByIsoWeekday,
        windowsConfig,
        (item) => item.localTime,
        () => 'inside at least one allowed interval',
        inAnyWindow,
        RESERVATION_CORRECTION.INVALID_TIME,
        true,
        false,
      ),
      now,
    ),
    evaluateRule(
      evidence,
      rule(
        RESERVATION_RULE.BOUNDARY,
        version,
        config?.windowsByIsoWeekday,
        windowsConfig,
        (item) => item.localTime,
        () => 'configured inclusive or exclusive start/end behavior',
        boundaryAllowed,
        RESERVATION_CORRECTION.INVALID_BOUNDARY,
        true,
        false,
      ),
      now,
    ),
    evaluateRule(
      evidence,
      rule(
        RESERVATION_RULE.TIMEZONE,
        version,
        config?.timezone,
        (value) => (value === 'Asia/Seoul' ? value : undefined),
        (item) => item.timezone,
        (expected) => expected ?? 'Asia/Seoul',
        (item, expected) => item.timezone === expected,
        RESERVATION_CORRECTION.CLARIFY_TIMEZONE,
        true,
        false,
      ),
      now,
    ),
    evaluateRule(
      evidence,
      rule(
        RESERVATION_RULE.BOOKING_METHOD,
        version,
        config?.bookingMethod,
        bookingMethodConfig,
        (item) => item.bookingMethod,
        (expected) => expected ?? 'configured visit method',
        (item, expected) => item.bookingMethod === expected,
        RESERVATION_CORRECTION.WRONG_BOOKING_METHOD,
        true,
        false,
      ),
      now,
    ),
    evaluateRule(
      evidence,
      rule(
        RESERVATION_RULE.VISIT_C_APPROVAL,
        version,
        config?.requireCurrentBusinessApproval,
        booleanConfig,
        (item) => item.businessApprovalState,
        (required) => (required === false ? 'approval not required' : 'current approval is approved'),
        (item, required) => !required || item.businessApprovalState === 'approved',
        RESERVATION_CORRECTION.APPROVAL_REVIEW,
        false,
        true,
      ),
      now,
    ),
    evaluateRule(
      evidence,
      rule(
        RESERVATION_RULE.STATUS,
        version,
        config?.acceptedReservationStatus,
        (value) => (value === 'completed' ? value : undefined),
        (item) => item.reservationStatus,
        () => 'completed and current',
        (item) => item.reservationStatus === 'completed',
        RESERVATION_CORRECTION.COMPLETE_BOOKING,
        true,
        false,
      ),
      now,
    ),
    evaluateRule(
      evidence,
      rule(
        RESERVATION_RULE.LEAD_TIME,
        version,
        config?.minimumLeadMinutes,
        positiveInteger,
        (item) => ({ localDate: item.localDate, localTime: item.localTime }),
        (minutes) =>
          minutes === undefined ? 'configured minimum lead time' : `at least ${String(minutes)} minutes in advance`,
        (item, minutes, evaluatedAt) => {
          const instant = reservationInstant(item)
          return instant !== undefined && instant - evaluatedAt.getTime() >= minutes * 60_000
        },
        RESERVATION_CORRECTION.INSUFFICIENT_LEAD_TIME,
        true,
        false,
      ),
      now,
    ),
    evaluateRule(
      evidence,
      rule(
        RESERVATION_RULE.BLACKOUT,
        version,
        config?.blackoutDates,
        stringArray,
        (item) => item.localDate,
        () => 'date is not restricted',
        (item, blackouts) => dateParts(item.localDate) !== undefined && !blackouts.includes(item.localDate),
        RESERVATION_CORRECTION.BLACKOUT_DATE,
        true,
        false,
      ),
      now,
    ),
    evaluateRule(
      evidence,
      rule(
        RESERVATION_RULE.CAMPAIGN_STATUS,
        version,
        config?.requiredCampaignStatus,
        (value) => (value === 'active' ? value : undefined),
        (item) => item.campaignStatus,
        () => 'campaign is active',
        (item) => item.campaignStatus === 'active',
        RESERVATION_CORRECTION.CAMPAIGN_CLOSED,
        false,
        true,
      ),
      now,
    ),
    evaluateRule(
      evidence,
      rule(
        RESERVATION_RULE.CAPACITY,
        version,
        config?.capacityRestrictionConfigured,
        booleanConfig,
        (item) => item.capacityAvailable ?? null,
        (configured) => (configured === false ? 'no capacity restriction' : 'configured capacity restriction passes'),
        (item, configured) => !configured || item.capacityAvailable === true,
        RESERVATION_CORRECTION.CAPACITY_REVIEW,
        true,
        true,
      ),
      now,
    ),
  ]
  const failures = results.filter((result) => result.outcome !== 'pass')
  const outcome = results.some((result) => result.outcome === 'configuration_error')
    ? 'configuration_error'
    : failures.length > 0
      ? 'fail'
      : 'pass'
  return { outcome, ruleVersion: version, results, failures }
}
