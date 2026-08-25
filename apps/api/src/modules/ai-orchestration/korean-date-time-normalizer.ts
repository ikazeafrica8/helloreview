import type { AiDateTimeEvidence } from '@helloreview/contracts'

export const KOREAN_DATE_TIME_REASON = {
  MISSING_CAMPAIGN_TIMEZONE: 'MISSING_CAMPAIGN_TIMEZONE',
  UNSUPPORTED_CAMPAIGN_TIMEZONE: 'UNSUPPORTED_CAMPAIGN_TIMEZONE',
  MISSING_YEAR: 'MISSING_YEAR',
  MISSING_DAY_PERIOD: 'MISSING_DAY_PERIOD',
  IMPOSSIBLE_DATE: 'IMPOSSIBLE_DATE',
  IMPOSSIBLE_TIME: 'IMPOSSIBLE_TIME',
  CONFLICTING_DATE_EXPRESSIONS: 'CONFLICTING_DATE_EXPRESSIONS',
  CONFLICTING_TIME_EXPRESSIONS: 'CONFLICTING_TIME_EXPRESSIONS',
  DATE_IN_PAST: 'DATE_IN_PAST',
  MISSING_DATE: 'MISSING_DATE',
  MISSING_TIME: 'MISSING_TIME',
  UNSUPPORTED_DATE_TIME_EXPRESSION: 'UNSUPPORTED_DATE_TIME_EXPRESSION',
} as const

export type SeoulCalendarDate = Readonly<{ year: number; month: number; day: number }>
export type KoreanDateTimeNormalization = Readonly<{
  evidence: AiDateTimeEvidence
  complete: boolean
  recognizedExpression: boolean
}>

type DatePart = Readonly<{ text: string; normalized: string | null }>
type TimePart = Readonly<{ text: string; normalized: string | null; start: number; end: number }>

const pad = (value: number): string => String(value).padStart(2, '0')
const isoDate = ({ year, month, day }: SeoulCalendarDate): string =>
  `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`
const leapYear = (year: number): boolean => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
const daysInMonth = (year: number, month: number): number =>
  [31, leapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0
const validDate = ({ year, month, day }: SeoulCalendarDate): boolean =>
  year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month)

const addDays = (date: SeoulCalendarDate, amount: number): SeoulCalendarDate => {
  let year = date.year
  let month = date.month
  let day = date.day
  for (let remaining = amount; remaining > 0; remaining -= 1) {
    day += 1
    if (day > daysInMonth(year, month)) {
      day = 1
      month += 1
      if (month > 12) {
        month = 1
        year += 1
      }
    }
  }
  return { year, month, day }
}

const addIssue = (issues: Set<string>, issue: string): void => {
  issues.add(issue)
}

const parseWhole = (value: string | undefined): number | null => {
  if (value === undefined || !/^\d+$/u.test(value)) return null
  return Number(value)
}

const extractDates = (text: string, reference: SeoulCalendarDate, issues: Set<string>): DatePart[] => {
  const dates: DatePart[] = []
  const explicit = /(?<year>\d{4})\s*(?:년|[./-])\s*(?<month>\d{1,2})\s*(?:월|[./-])\s*(?<day>\d{1,2})\s*일?/gu
  for (const match of text.matchAll(explicit)) {
    const value = {
      year: parseWhole(match.groups?.year) ?? 0,
      month: parseWhole(match.groups?.month) ?? 0,
      day: parseWhole(match.groups?.day) ?? 0,
    }
    if (!validDate(value)) addIssue(issues, KOREAN_DATE_TIME_REASON.IMPOSSIBLE_DATE)
    dates.push({ text: match[0], normalized: validDate(value) ? isoDate(value) : null })
  }

  if (dates.length === 0) {
    const monthDay = /(?<month>\d{1,2})\s*월\s*(?<day>\d{1,2})\s*일/gu
    for (const match of text.matchAll(monthDay)) {
      const value = {
        year: reference.year,
        month: parseWhole(match.groups?.month) ?? 0,
        day: parseWhole(match.groups?.day) ?? 0,
      }
      addIssue(issues, KOREAN_DATE_TIME_REASON.MISSING_YEAR)
      if (!validDate(value)) addIssue(issues, KOREAN_DATE_TIME_REASON.IMPOSSIBLE_DATE)
      dates.push({ text: match[0], normalized: null })
    }
  }

  const relativeMatches = [...text.matchAll(/오늘|내일|모레/gu)]
  for (const match of relativeMatches) {
    const offset = match[0] === '오늘' ? 0 : match[0] === '내일' ? 1 : 2
    dates.push({ text: match[0], normalized: isoDate(addDays(reference, offset)) })
  }
  if (/(이번|다음)\s*주(말)?(?!\s*[월화수목금토일]요일)/u.test(text)) {
    addIssue(issues, KOREAN_DATE_TIME_REASON.UNSUPPORTED_DATE_TIME_EXPRESSION)
  }
  return dates
}

const timeValue = (hour: number, minute: number): string | null => {
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return `${pad(hour)}:${pad(minute)}`
}

const extractTimes = (text: string, issues: Set<string>): TimePart[] => {
  const times: TimePart[] = []
  const add = (match: RegExpExecArray, hour: number, minute: number): void => {
    const start = match.index
    const normalized = timeValue(hour, minute)
    if (normalized === null) addIssue(issues, KOREAN_DATE_TIME_REASON.IMPOSSIBLE_TIME)
    times.push({ text: match[0], normalized, start, end: start + match[0].length })
  }

  for (const match of text.matchAll(/(?<period>오전|오후)\s*(?<hour>\d{1,2})\s*시(?:\s*(?<minute>\d{1,2})\s*분)?/gu)) {
    const rawHour = parseWhole(match.groups?.hour) ?? -1
    const minute = parseWhole(match.groups?.minute) ?? 0
    const validPeriodHour = rawHour >= 1 && rawHour <= 12
    if (!validPeriodHour) addIssue(issues, KOREAN_DATE_TIME_REASON.IMPOSSIBLE_TIME)
    const hour = match.groups?.period === '오후' ? (rawHour % 12) + 12 : rawHour % 12
    add(match, validPeriodHour ? hour : -1, minute)
  }

  for (const match of text.matchAll(/(?<hour>[01]?\d|2[0-3]):(?<minute>[0-5]\d)/gu)) {
    const start = match.index
    if (times.some((item) => start >= item.start && start < item.end)) continue
    add(match, parseWhole(match.groups?.hour) ?? -1, parseWhole(match.groups?.minute) ?? -1)
  }

  for (const match of text.matchAll(/정오|자정/gu)) add(match, match[0] === '정오' ? 12 : 0, 0)

  for (const match of text.matchAll(/(?<hour>\d{1,2})\s*시(?:\s*(?<minute>\d{1,2})\s*분)?/gu)) {
    const start = match.index
    if (times.some((item) => start >= item.start && start < item.end)) continue
    const hour = parseWhole(match.groups?.hour) ?? -1
    const minute = parseWhole(match.groups?.minute) ?? 0
    if (hour >= 1 && hour <= 12) {
      addIssue(issues, KOREAN_DATE_TIME_REASON.MISSING_DAY_PERIOD)
      times.push({ text: match[0], normalized: null, start, end: start + match[0].length })
    } else {
      add(match, hour, minute)
    }
  }
  return times
}

const uniqueNonNull = (values: readonly (string | null)[]): Set<string> =>
  new Set(values.filter((value): value is string => value !== null))

export const normalizeKoreanDateTime = (
  input: Readonly<{
    text: string
    referenceDate: SeoulCalendarDate
    campaignTimezone: string | null
  }>,
): KoreanDateTimeNormalization => {
  const issues = new Set<string>()
  const dates = extractDates(input.text.normalize('NFKC'), input.referenceDate, issues)
  const times = extractTimes(input.text.normalize('NFKC'), issues)
  if (input.campaignTimezone === null || input.campaignTimezone.trim() === '') {
    addIssue(issues, KOREAN_DATE_TIME_REASON.MISSING_CAMPAIGN_TIMEZONE)
  } else if (input.campaignTimezone !== 'Asia/Seoul') {
    addIssue(issues, KOREAN_DATE_TIME_REASON.UNSUPPORTED_CAMPAIGN_TIMEZONE)
  }
  if (dates.length === 0) addIssue(issues, KOREAN_DATE_TIME_REASON.MISSING_DATE)
  if (times.length === 0) addIssue(issues, KOREAN_DATE_TIME_REASON.MISSING_TIME)

  const normalizedDates = uniqueNonNull(dates.map((item) => item.normalized))
  const normalizedTimes = uniqueNonNull(times.map((item) => item.normalized))
  if (normalizedDates.size > 1) addIssue(issues, KOREAN_DATE_TIME_REASON.CONFLICTING_DATE_EXPRESSIONS)
  if (normalizedTimes.size > 1) addIssue(issues, KOREAN_DATE_TIME_REASON.CONFLICTING_TIME_EXPRESSIONS)
  const referenceIso = isoDate(input.referenceDate)
  if ([...normalizedDates].some((value) => value < referenceIso)) addIssue(issues, KOREAN_DATE_TIME_REASON.DATE_IN_PAST)

  const dateParts = dates.length === 0 ? [{ text: null, normalized: null }] : dates
  const timeParts = times.length === 0 ? [{ text: null, normalized: null }] : times
  const candidates: AiDateTimeEvidence['candidates'] = []
  for (const date of dateParts) {
    for (const time of timeParts) {
      if (candidates.length >= 10) break
      candidates.push({
        dateText: date.text,
        timeText: time.text,
        normalizedDate: date.normalized,
        normalizedTime: time.normalized,
        timezone: 'Asia/Seoul',
        confidence: date.normalized !== null && time.normalized !== null ? 1 : 0,
      })
    }
  }

  const ambiguities = [...issues].sort()
  const hardReviewReasons: ReadonlySet<string> = new Set([
    KOREAN_DATE_TIME_REASON.MISSING_CAMPAIGN_TIMEZONE,
    KOREAN_DATE_TIME_REASON.UNSUPPORTED_CAMPAIGN_TIMEZONE,
    KOREAN_DATE_TIME_REASON.IMPOSSIBLE_DATE,
    KOREAN_DATE_TIME_REASON.IMPOSSIBLE_TIME,
    KOREAN_DATE_TIME_REASON.DATE_IN_PAST,
  ])
  const hardReview = ambiguities.some((issue) => hardReviewReasons.has(issue))
  const evidence: AiDateTimeEvidence = {
    task: 'date_time_extraction',
    candidates,
    ambiguities,
    requiresClarification: ambiguities.length > 0 && !hardReview,
    requiresHumanReview: hardReview,
  }
  return {
    evidence,
    complete: ambiguities.length === 0 && candidates.length === 1,
    recognizedExpression: dates.length > 0 || times.length > 0,
  }
}
