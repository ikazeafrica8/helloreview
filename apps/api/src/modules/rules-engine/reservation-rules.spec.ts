import { describe, expect, test } from 'vitest'
import {
  evaluateReservationRules,
  parseReservationRuleConfiguration,
  type ReservationEvidence,
  type ReservationRuleConfiguration,
} from './reservation-rules.js'
import { RESERVATION_CORRECTION, RESERVATION_RULE } from './reason-codes.js'

const now = new Date('2026-08-24T00:00:00.000Z') // Sunday 09:00 Seoul

const configuration: ReservationRuleConfiguration = {
  expectedCampaignId: 'campaign-7',
  businesses: [{ normalizedName: 'hellocafe', normalizedBranch: 'gangnam' }],
  campaignStartsOn: '2026-08-01',
  campaignEndsOn: '2026-09-30',
  allowedIsoWeekdays: [1, 2, 3, 4, 5],
  windowsByIsoWeekday: {
    '1': [{ startsAt: '10:00:00', endsAt: '18:00:00', startInclusive: true, endInclusive: false }],
  },
  timezone: 'Asia/Seoul',
  bookingMethod: 'visit_c',
  requireCurrentBusinessApproval: true,
  acceptedReservationStatus: 'completed',
  minimumLeadMinutes: 60,
  blackoutDates: ['2026-09-07'],
  requiredCampaignStatus: 'active',
  capacityRestrictionConfigured: true,
}

const evidence: ReservationEvidence = {
  campaignId: 'campaign-7',
  normalizedBusinessName: 'hellocafe',
  normalizedBranchName: 'gangnam',
  localDate: '2026-08-31', // Monday
  localTime: '10:00:00',
  timezone: 'Asia/Seoul',
  bookingMethod: 'visit_c',
  businessApprovalState: 'approved',
  reservationStatus: 'completed',
  campaignStatus: 'active',
  capacityAvailable: true,
}

const evaluate = (
  submitted: ReservationEvidence = evidence,
  configured: ReservationRuleConfiguration = configuration,
  version = 4,
) => evaluateReservationRules(submitted, { version, configuration: configured }, now)

describe('PRD §16.7 reservation validation', () => {
  test('accepts complete configuration and rejects malformed configuration at the parser boundary', () => {
    expect(parseReservationRuleConfiguration(configuration)).toEqual(configuration)
    expect(parseReservationRuleConfiguration({ ...configuration, unexpectedSetting: true })).toBeUndefined()
  })

  test('evaluates all fourteen named checks with trace evidence', () => {
    const result = evaluate()
    expect(result.outcome).toBe('pass')
    expect(result.results).toHaveLength(14)
    expect(result.results.map((item) => item.ruleCode)).toEqual(Object.values(RESERVATION_RULE))
    expect(
      result.results.every(
        (item) => item.ruleVersion === 4 && item.submittedValue !== undefined && item.expectedCondition.length > 0,
      ),
    ).toBe(true)
  })

  test.each([
    [RESERVATION_RULE.CAMPAIGN, { campaignId: 'wrong' }, RESERVATION_CORRECTION.CAMPAIGN_REVIEW],
    [RESERVATION_RULE.BUSINESS, { normalizedBranchName: 'hongdae' }, RESERVATION_CORRECTION.WRONG_BUSINESS],
    [RESERVATION_RULE.DATE_PERIOD, { localDate: '2026-10-01' }, RESERVATION_CORRECTION.INVALID_DATE],
    [RESERVATION_RULE.WEEKDAY, { localDate: '2026-08-30' }, RESERVATION_CORRECTION.INVALID_WEEKDAY],
    [RESERVATION_RULE.TIME, { localTime: '19:00:00' }, RESERVATION_CORRECTION.INVALID_TIME],
    [RESERVATION_RULE.BOUNDARY, { localTime: '18:00:00' }, RESERVATION_CORRECTION.INVALID_BOUNDARY],
    [RESERVATION_RULE.TIMEZONE, { timezone: 'UTC' }, RESERVATION_CORRECTION.CLARIFY_TIMEZONE],
    [RESERVATION_RULE.BOOKING_METHOD, { bookingMethod: 'visit_b' }, RESERVATION_CORRECTION.WRONG_BOOKING_METHOD],
    [RESERVATION_RULE.VISIT_C_APPROVAL, { businessApprovalState: 'pending' }, RESERVATION_CORRECTION.APPROVAL_REVIEW],
    [RESERVATION_RULE.STATUS, { reservationStatus: 'cancelled' }, RESERVATION_CORRECTION.COMPLETE_BOOKING],
    [
      RESERVATION_RULE.LEAD_TIME,
      { localDate: '2026-08-24', localTime: '09:30:00' },
      RESERVATION_CORRECTION.INSUFFICIENT_LEAD_TIME,
    ],
    [RESERVATION_RULE.BLACKOUT, { localDate: '2026-09-07' }, RESERVATION_CORRECTION.BLACKOUT_DATE],
    [RESERVATION_RULE.CAMPAIGN_STATUS, { campaignStatus: 'paused' }, RESERVATION_CORRECTION.CAMPAIGN_CLOSED],
    [RESERVATION_RULE.CAPACITY, { capacityAvailable: false }, RESERVATION_CORRECTION.CAPACITY_REVIEW],
  ] as const)('%s has its own failure and corrective action', (ruleCode, change, correction) => {
    const result = evaluate({ ...evidence, ...change })
    expect(result.outcome).toBe('fail')
    const failure = result.failures.find((item) => item.ruleCode === ruleCode)
    expect(failure).toMatchObject({ outcome: 'fail', ruleCode, correction })
    expect(typeof (failure !== undefined && failure.outcome !== 'pass' ? failure.retryEligible : undefined)).toBe(
      'boolean',
    )
    expect(typeof (failure !== undefined && failure.outcome !== 'pass' ? failure.reviewRequired : undefined)).toBe(
      'boolean',
    )
  })

  test('applies exact configured start/end inclusivity', () => {
    expect(evaluate({ ...evidence, localTime: '10:00:00' }).failures.map((item) => item.ruleCode)).not.toContain(
      RESERVATION_RULE.BOUNDARY,
    )
    expect(evaluate({ ...evidence, localTime: '18:00:00' }).failures.map((item) => item.ruleCode)).toContain(
      RESERVATION_RULE.BOUNDARY,
    )
    const flipped = {
      ...configuration,
      windowsByIsoWeekday: {
        '1': [{ startsAt: '10:00:00', endsAt: '18:00:00', startInclusive: false, endInclusive: true }],
      },
    }
    expect(evaluate({ ...evidence, localTime: '10:00:00' }, flipped).failures.map((item) => item.ruleCode)).toContain(
      RESERVATION_RULE.BOUNDARY,
    )
    expect(
      evaluate({ ...evidence, localTime: '18:00:00' }, flipped).failures.map((item) => item.ruleCode),
    ).not.toContain(RESERVATION_RULE.BOUNDARY)
  })

  test('missing and malformed configuration fail closed instead of passing', () => {
    const missing = evaluateReservationRules(evidence, { version: 4 }, now)
    expect(missing.outcome).toBe('configuration_error')
    expect(missing.results).toHaveLength(14)
    expect(missing.results.every((item) => item.outcome === 'configuration_error')).toBe(true)

    const malformed = evaluate(evidence, { ...configuration, windowsByIsoWeekday: { '1': [] } })
    expect(malformed.outcome).toBe('configuration_error')
    expect(malformed.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleCode: RESERVATION_RULE.TIME, outcome: 'configuration_error' }),
        expect.objectContaining({ ruleCode: RESERVATION_RULE.BOUNDARY, outcome: 'configuration_error' }),
      ]),
    )
  })

  test('invalid calendar/time input and unknown capacity fail safely', () => {
    const invalid = evaluate({
      ...evidence,
      localDate: '2026-02-30',
      localTime: '25:00:00',
      capacityAvailable: undefined,
    })
    expect(invalid.outcome).toBe('fail')
    expect(invalid.failures.map((item) => item.ruleCode)).toEqual(
      expect.arrayContaining([
        RESERVATION_RULE.DATE_PERIOD,
        RESERVATION_RULE.WEEKDAY,
        RESERVATION_RULE.TIME,
        RESERVATION_RULE.BOUNDARY,
        RESERVATION_RULE.LEAD_TIME,
        RESERVATION_RULE.BLACKOUT,
        RESERVATION_RULE.CAPACITY,
      ]),
    )
  })

  test.each([
    ['2024-02-29', 4],
    ['2100-02-28', 7],
    ['2000-02-29', 2],
  ])('validates leap-century calendar date %s deterministically', (localDate, weekday) => {
    const dated = {
      ...configuration,
      campaignStartsOn: localDate,
      campaignEndsOn: localDate,
      allowedIsoWeekdays: [weekday],
      windowsByIsoWeekday: {
        [String(weekday)]: [{ startsAt: '10:00:00', endsAt: '18:00:00', startInclusive: true, endInclusive: true }],
      },
      minimumLeadMinutes: 0,
    }
    const result = evaluate({ ...evidence, localDate }, dated)
    expect(result.failures.map((item) => item.ruleCode)).not.toEqual(
      expect.arrayContaining([RESERVATION_RULE.DATE_PERIOD, RESERVATION_RULE.WEEKDAY]),
    )
  })

  test('rejects non-shaped dates/times, invalid months, and invalid configured dates', () => {
    const invalidEvidence = evaluate({ ...evidence, localDate: 'not-a-date', localTime: 'not-a-time' })
    expect(invalidEvidence.outcome).toBe('fail')
    expect(evaluate({ ...evidence, localDate: '2026-13-01' }).outcome).toBe('fail')
    expect(evaluate(evidence, { ...configuration, campaignStartsOn: 'not-a-date' }).outcome).toBe('configuration_error')
    expect(evaluate(evidence, { ...configuration, campaignEndsOn: 'not-a-date' }).outcome).toBe('configuration_error')
  })

  test('approval and capacity checks become not-required when configured off', () => {
    const optional = { ...configuration, requireCurrentBusinessApproval: false, capacityRestrictionConfigured: false }
    const result = evaluate(
      { ...evidence, businessApprovalState: 'not_required', capacityAvailable: undefined },
      optional,
    )
    expect(result.outcome).toBe('pass')
  })
})

describe('T133 single-location businesses have no branch', () => {
  const singleLocation: ReservationRuleConfiguration = {
    ...configuration,
    businesses: [{ normalizedName: 'hellocafe', normalizedBranch: '' }],
  }
  const atSingleLocation: ReservationEvidence = { ...evidence, normalizedBranchName: '' }

  test('is accepted by the complete-configuration parser', () => {
    expect(parseReservationRuleConfiguration(singleLocation)).toEqual(singleLocation)
  })

  test('passes the business rule instead of reporting a configuration error', () => {
    const result = evaluate(atSingleLocation, singleLocation)
    const business = result.results.find((item) => item.ruleCode === RESERVATION_RULE.BUSINESS)
    expect(business?.outcome).toBe('pass')
    expect(result.outcome).toBe('pass')
  })

  test('still refuses a branch the single-location configuration does not name', () => {
    const result = evaluate({ ...atSingleLocation, normalizedBranchName: 'gangnam' }, singleLocation)
    const business = result.results.find((item) => item.ruleCode === RESERVATION_RULE.BUSINESS)
    expect(business?.outcome).toBe('fail')
    expect(business?.outcome === 'fail' ? business.correction : null).toBe(RESERVATION_CORRECTION.WRONG_BUSINESS)
  })

  test('reports a configuration error only when the business entry itself is unusable', () => {
    const unusable = { ...configuration, businesses: [{ normalizedName: '  ', normalizedBranch: '' }] }
    const result = evaluate(atSingleLocation, unusable)
    const business = result.results.find((item) => item.ruleCode === RESERVATION_RULE.BUSINESS)
    expect(business?.outcome).toBe('configuration_error')
    expect(parseReservationRuleConfiguration(unusable)).toBeUndefined()
  })
})
