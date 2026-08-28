import {
  RESERVATION_CORRECTION,
  type ReservationCorrectionCode,
  type ReservationEvidence,
  type ReservationRuleCode,
  type ReservationRuleConfiguration,
  type RuleEvaluationResult,
} from '../rules-engine/index.js'

/**
 * The two template variables every reservation-correction message receives.
 *
 * A correction that names only a reason code makes the participant guess what to change. These are
 * the "what you sent" and "what is expected" halves of a specific Korean explanation.
 *
 * Two rules govern what may appear here, and both are enforced below rather than left to the
 * caller:
 *
 *   1. NOTHING INTERNAL. A rule's `submittedValue` and `expectedCondition` are engineering
 *      evidence - campaign UUIDs, workflow state codes, English condition text. They are useful in
 *      an audit trail and wrong in a participant message, so each correction has its own explicit
 *      Korean rendering and the engineering strings are never passed through.
 *   2. FAIL TOWARDS SILENCE. Where the failing fact is an internal identifier or a state the
 *      participant cannot act on, the message says an operator will follow up rather than exposing
 *      it. A vaguer message is the correct trade against leaking campaign or workflow internals.
 */
export type ReservationCorrectionVariables = Readonly<{
  submitted_value: string
  expected_condition: string
}>

export type ReservationCorrectionInput = Readonly<{
  /** The first failed rule, or null when extraction never reached deterministic validation. */
  failure: RuleEvaluationResult<ReservationRuleCode, ReservationCorrectionCode> | null
  /** The normalized evidence that was judged, or null when there is none. */
  evidence: ReservationEvidence | null
  /** The rule version's configuration, absent when it could not be parsed. */
  configuration: ReservationRuleConfiguration | undefined
}>

const MAXIMUM_VALUE_CHARACTERS = 200
const WITHHELD = '확인 필요'
const OPERATOR_FOLLOW_UP = '담당자 확인 후 안내드리겠습니다'
const NOT_EXTRACTED = '확인하지 못했습니다'
const NOT_PROVIDED = '입력 없음'
const DATE_TIME_EXAMPLE = '예약 날짜와 시간 (예: 2026-08-26 14:00)'

const KOREAN_WEEKDAYS = ['월', '화', '수', '목', '금', '토', '일'] as const

const BOOKING_METHOD_LABELS: Readonly<Record<ReservationEvidence['bookingMethod'], string>> = {
  visit_a: '매장 전화 예약',
  visit_b: '네이버 예약',
  visit_c: '승인 후 예약',
}

const RESERVATION_STATUS_LABELS: Readonly<Record<ReservationEvidence['reservationStatus'], string>> = {
  completed: '예약 완료',
  incomplete: '예약 미완료',
  cancelled: '예약 취소',
  replaced: '예약 변경',
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const LOCAL_TIME = /^(\d{2}):(\d{2}):(\d{2})$/

/** Bounded, control-character-free, and never empty, whatever the upstream value turned out to be. */
const safe = (value: string, fallback: string): string => {
  const cleaned = value
    .normalize('NFKC')
    .replace(/\p{Cc}|\p{Cf}/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (cleaned.length === 0) return fallback
  return cleaned.length > MAXIMUM_VALUE_CHARACTERS ? `${cleaned.slice(0, MAXIMUM_VALUE_CHARACTERS - 1)}…` : cleaned
}

const isoWeekday = (localDate: string): number | null => {
  const match = ISO_DATE.exec(localDate)
  if (match === null) return null
  const utcDay = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay()
  return utcDay === 0 ? 7 : utcDay
}

/** "HH:MM:SS" is the storage shape; a participant reads "HH:MM". */
const shortTime = (localTime: string): string | null => {
  const match = LOCAL_TIME.exec(localTime)
  return match === null ? null : `${match[1] ?? ''}:${match[2] ?? ''}`
}

const dateAndTime = (evidence: ReservationEvidence | null): string => {
  if (evidence === null) return NOT_EXTRACTED
  const time = shortTime(evidence.localTime)
  if (evidence.localDate === '' && time === null) return NOT_PROVIDED
  if (time === null) return safe(evidence.localDate, NOT_PROVIDED)
  return safe(`${evidence.localDate} ${time}`.trim(), NOT_PROVIDED)
}

const businessLabel = (name: string, branch: string): string => safe(`${name} ${branch}`.trim(), NOT_PROVIDED)

const configuredBusinesses = (configuration: ReservationRuleConfiguration | undefined): string | null => {
  if (configuration === undefined || configuration.businesses.length === 0) return null
  return safe(
    configuration.businesses
      .map((business) => `${business.normalizedName} ${business.normalizedBranch}`.trim())
      .join(', '),
    NOT_PROVIDED,
  )
}

const configuredWeekdays = (configuration: ReservationRuleConfiguration | undefined): string | null => {
  if (configuration === undefined || configuration.allowedIsoWeekdays.length === 0) return null
  const names = [...new Set(configuration.allowedIsoWeekdays)]
    .sort((left, right) => left - right)
    .map((weekday) => KOREAN_WEEKDAYS[weekday - 1])
    .filter((label): label is (typeof KOREAN_WEEKDAYS)[number] => label !== undefined)
  return names.length === 0 ? null : `${names.join(', ')}요일`
}

const configuredWindows = (
  configuration: ReservationRuleConfiguration | undefined,
  evidence: ReservationEvidence | null,
): string | null => {
  if (configuration === undefined || evidence === null) return null
  const weekday = isoWeekday(evidence.localDate)
  const windows = weekday === null ? undefined : configuration.windowsByIsoWeekday[String(weekday)]
  if (windows === undefined || windows.length === 0) return null
  const ranges = windows
    .map((window) => {
      const start = shortTime(window.startsAt)
      const end = shortTime(window.endsAt)
      return start === null || end === null ? null : `${start}~${end}`
    })
    .filter((range): range is string => range !== null)
  return ranges.length === 0 ? null : safe(`${evidence.localDate} ${ranges.join(' 또는 ')}`, NOT_PROVIDED)
}

/**
 * One explicit Korean rendering per correction code.
 *
 * Keyed by correction rather than by rule so that every message a participant can receive is
 * accounted for, including the review-only corrections whose failing fact must stay withheld. The
 * exhaustive `Record` is the guarantee: adding a correction code without a rendering for it fails
 * to compile.
 */
const rendering: Readonly<
  Record<
    ReservationCorrectionCode,
    (input: ReservationCorrectionInput) => Readonly<{ submitted: string; expected: string }>
  >
> = {
  [RESERVATION_CORRECTION.DATE_TIME_CLARIFICATION]: () => ({
    submitted: NOT_EXTRACTED,
    expected: DATE_TIME_EXAMPLE,
  }),
  [RESERVATION_CORRECTION.WRONG_BUSINESS]: ({ evidence, configuration }) => ({
    submitted:
      evidence === null ? NOT_EXTRACTED : businessLabel(evidence.normalizedBusinessName, evidence.normalizedBranchName),
    expected: configuredBusinesses(configuration) ?? OPERATOR_FOLLOW_UP,
  }),
  [RESERVATION_CORRECTION.INVALID_DATE]: ({ evidence, configuration }) => ({
    submitted: evidence === null ? NOT_EXTRACTED : safe(evidence.localDate, NOT_PROVIDED),
    expected:
      configuration === undefined
        ? OPERATOR_FOLLOW_UP
        : `${configuration.campaignStartsOn} ~ ${configuration.campaignEndsOn}`,
  }),
  [RESERVATION_CORRECTION.INVALID_WEEKDAY]: ({ evidence, configuration }) => {
    const weekday = evidence === null ? null : isoWeekday(evidence.localDate)
    const label = weekday === null ? null : (KOREAN_WEEKDAYS[weekday - 1] ?? null)
    return {
      submitted:
        evidence === null
          ? NOT_EXTRACTED
          : safe(label === null ? evidence.localDate : `${evidence.localDate} (${label}요일)`, NOT_PROVIDED),
      expected: configuredWeekdays(configuration) ?? OPERATOR_FOLLOW_UP,
    }
  },
  [RESERVATION_CORRECTION.INVALID_TIME]: ({ evidence, configuration }) => ({
    submitted: dateAndTime(evidence),
    expected: configuredWindows(configuration, evidence) ?? OPERATOR_FOLLOW_UP,
  }),
  [RESERVATION_CORRECTION.INVALID_BOUNDARY]: ({ evidence, configuration }) => ({
    submitted: dateAndTime(evidence),
    expected: configuredWindows(configuration, evidence) ?? OPERATOR_FOLLOW_UP,
  }),
  [RESERVATION_CORRECTION.CLARIFY_TIMEZONE]: ({ evidence }) => ({
    submitted: evidence === null ? NOT_EXTRACTED : safe(evidence.timezone, NOT_PROVIDED),
    expected: 'Asia/Seoul (한국 시간) 기준',
  }),
  [RESERVATION_CORRECTION.WRONG_BOOKING_METHOD]: ({ evidence, configuration }) => ({
    submitted: evidence === null ? NOT_EXTRACTED : BOOKING_METHOD_LABELS[evidence.bookingMethod],
    expected: configuration === undefined ? OPERATOR_FOLLOW_UP : BOOKING_METHOD_LABELS[configuration.bookingMethod],
  }),
  [RESERVATION_CORRECTION.COMPLETE_BOOKING]: ({ evidence }) => ({
    submitted: evidence === null ? NOT_EXTRACTED : RESERVATION_STATUS_LABELS[evidence.reservationStatus],
    expected: '예약 완료 상태',
  }),
  [RESERVATION_CORRECTION.INSUFFICIENT_LEAD_TIME]: ({ evidence, configuration }) => ({
    submitted: dateAndTime(evidence),
    expected:
      configuration === undefined
        ? OPERATOR_FOLLOW_UP
        : `예약 시각 기준 최소 ${String(configuration.minimumLeadMinutes)}분 전`,
  }),
  [RESERVATION_CORRECTION.BLACKOUT_DATE]: ({ evidence }) => ({
    submitted: evidence === null ? NOT_EXTRACTED : safe(evidence.localDate, NOT_PROVIDED),
    // The full restricted list is campaign configuration, not something a participant needs.
    expected: '예약이 불가능한 날짜를 제외한 날짜',
  }),
  // The remaining corrections fail on a campaign identifier, an approval state, a campaign
  // lifecycle state, or the rule configuration itself. None is something the participant can act on
  // and each would leak internal state, so the failing fact stays withheld.
  [RESERVATION_CORRECTION.CAMPAIGN_REVIEW]: () => ({ submitted: WITHHELD, expected: OPERATOR_FOLLOW_UP }),
  [RESERVATION_CORRECTION.APPROVAL_REVIEW]: () => ({ submitted: WITHHELD, expected: OPERATOR_FOLLOW_UP }),
  [RESERVATION_CORRECTION.CAMPAIGN_CLOSED]: () => ({ submitted: WITHHELD, expected: OPERATOR_FOLLOW_UP }),
  [RESERVATION_CORRECTION.CAPACITY_REVIEW]: () => ({ submitted: WITHHELD, expected: OPERATOR_FOLLOW_UP }),
  [RESERVATION_CORRECTION.CONFIGURATION_REVIEW]: () => ({ submitted: WITHHELD, expected: OPERATOR_FOLLOW_UP }),
}

/**
 * Last resort when a caller holds a rule failure but not the evidence it was judged from - the
 * guideline-readiness path is composed that way today.
 *
 * A rule's `submittedValue` is `unknown` and can be a campaign identifier, a structured object, or
 * free text, so only the two strictly-shaped participant-facing values are accepted. Anything else
 * stays withheld rather than being echoed into a message.
 */
const submittedFromFailure = (failure: ReservationCorrectionInput['failure']): string | null => {
  const value = failure?.submittedValue
  if (typeof value !== 'string') return null
  if (LOCAL_TIME.test(value)) return shortTime(value)
  return ISO_DATE.test(value) ? value : null
}

/** Pure. No clock, no repository, no provider; the caller supplies the evidence and configuration. */
export const reservationCorrectionVariables = (input: ReservationCorrectionInput): ReservationCorrectionVariables => {
  const correction = input.failure?.outcome === 'pass' ? null : (input.failure?.correction ?? null)
  const render = correction === null ? rendering[RESERVATION_CORRECTION.DATE_TIME_CLARIFICATION] : rendering[correction]
  const rendered = render(input)
  // The evidence is authoritative wherever it exists; the failure value only fills the gap the
  // absent evidence left, and only for a correction that was actually raised.
  const submitted =
    input.evidence === null && rendered.submitted === NOT_EXTRACTED && correction !== null
      ? (submittedFromFailure(input.failure) ?? rendered.submitted)
      : rendered.submitted
  return Object.freeze({
    submitted_value: safe(submitted, WITHHELD),
    expected_condition: safe(rendered.expected, OPERATOR_FOLLOW_UP),
  })
}
