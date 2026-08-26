import type { HumanReviewPriority } from './handoff-priority.js'

export const HUMAN_REVIEW_SLA_MISSING = 'SLA_POLICY_MISSING' as const

export type HumanReviewSlaTarget = Readonly<{
  responseMinutes: number
  escalationMinutes: number
}>

export type HumanReviewSlaPolicy = Readonly<{
  version: string
  timezone: 'Asia/Seoul'
  serviceWeekdays: readonly number[]
  serviceStartMinute: number
  serviceEndMinute: number
  holidayDates: readonly string[]
  targets: Readonly<Record<HumanReviewPriority, HumanReviewSlaTarget>>
}>

export type HumanReviewSlaSchedule =
  | Readonly<{ state: typeof HUMAN_REVIEW_SLA_MISSING }>
  | Readonly<{
      state: 'scheduled'
      policyVersion: string
      dueAt: Date
      escalationAt: Date
    }>

const POLICY_VERSION = /^[a-z][a-z0-9-]*-v[0-9]+$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const SEOUL_OFFSET_MS = 9 * 60 * 60 * 1_000
const MINUTE_MS = 60_000
const MAX_SLA_MINUTES = 366 * 24 * 60

const isCanonicalDate = (value: string): boolean => {
  if (!DATE.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

const validatePolicy = (policy: HumanReviewSlaPolicy): void => {
  if (!POLICY_VERSION.test(policy.version)) throw new Error('SLA policy version is invalid')
  if (
    !Number.isInteger(policy.serviceStartMinute) ||
    !Number.isInteger(policy.serviceEndMinute) ||
    policy.serviceStartMinute < 0 ||
    policy.serviceEndMinute > 24 * 60 ||
    policy.serviceStartMinute >= policy.serviceEndMinute
  ) {
    throw new Error('SLA service window is invalid')
  }
  if (
    policy.serviceWeekdays.length === 0 ||
    new Set(policy.serviceWeekdays).size !== policy.serviceWeekdays.length ||
    policy.serviceWeekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)
  ) {
    throw new Error('SLA service weekdays are invalid')
  }
  if (
    new Set(policy.holidayDates).size !== policy.holidayDates.length ||
    policy.holidayDates.some((day) => !isCanonicalDate(day))
  ) {
    throw new Error('SLA holiday dates are invalid')
  }
  for (const target of Object.values(policy.targets)) {
    if (
      !Number.isInteger(target.responseMinutes) ||
      !Number.isInteger(target.escalationMinutes) ||
      target.responseMinutes <= 0 ||
      target.escalationMinutes < target.responseMinutes ||
      target.escalationMinutes > MAX_SLA_MINUTES
    ) {
      throw new Error('SLA target is invalid')
    }
  }
}

const seoulParts = (instant: Date): Readonly<{ weekday: number; date: string; minute: number }> => {
  const local = new Date(instant.getTime() + SEOUL_OFFSET_MS)
  const weekday = local.getUTCDay() === 0 ? 7 : local.getUTCDay()
  return {
    weekday,
    date: local.toISOString().slice(0, 10),
    minute: local.getUTCHours() * 60 + local.getUTCMinutes(),
  }
}

const isServiceMinute = (instant: Date, policy: HumanReviewSlaPolicy, holidays: ReadonlySet<string>): boolean => {
  const local = seoulParts(instant)
  return (
    policy.serviceWeekdays.includes(local.weekday) &&
    !holidays.has(local.date) &&
    local.minute >= policy.serviceStartMinute &&
    local.minute < policy.serviceEndMinute
  )
}

const addServiceMinutes = (start: Date, minutes: number, policy: HumanReviewSlaPolicy): Date => {
  const holidays = new Set(policy.holidayDates)
  let remaining = minutes
  let current = new Date(start)
  while (remaining > 0) {
    if (isServiceMinute(current, policy, holidays)) remaining -= 1
    current = new Date(current.getTime() + MINUTE_MS)
  }
  return current
}

export const scheduleHumanReviewSla = (
  createdAt: Date,
  priority: HumanReviewPriority,
  policy: HumanReviewSlaPolicy | null,
): HumanReviewSlaSchedule => {
  if (Number.isNaN(createdAt.getTime())) throw new Error('SLA creation time is invalid')
  if (policy === null) return { state: HUMAN_REVIEW_SLA_MISSING }
  validatePolicy(policy)
  const target = policy.targets[priority]
  return {
    state: 'scheduled',
    policyVersion: policy.version,
    dueAt: addServiceMinutes(createdAt, target.responseMinutes, policy),
    escalationAt: addServiceMinutes(createdAt, target.escalationMinutes, policy),
  }
}
