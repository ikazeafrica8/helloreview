import { describe, expect, test } from 'vitest'
import {
  RESERVATION_CORRECTION,
  RESERVATION_RULE,
  evaluateReservationRules,
  type ReservationEvidence,
  type ReservationRuleConfiguration,
} from '../rules-engine/index.js'
import { reservationCorrectionVariables } from './correction-values.js'

const now = new Date('2026-08-24T00:00:00.000Z')

const configuration: ReservationRuleConfiguration = {
  expectedCampaignId: '10000000-0000-4000-8000-000000000001',
  businesses: [{ normalizedName: '테스트카페', normalizedBranch: '강남점' }],
  campaignStartsOn: '2026-08-01',
  campaignEndsOn: '2026-09-30',
  allowedIsoWeekdays: [1, 2, 3, 4, 5],
  windowsByIsoWeekday: {
    '1': [{ startsAt: '10:00:00', endsAt: '18:00:00', startInclusive: true, endInclusive: false }],
  },
  timezone: 'Asia/Seoul',
  bookingMethod: 'visit_a',
  requireCurrentBusinessApproval: false,
  acceptedReservationStatus: 'completed',
  minimumLeadMinutes: 60,
  blackoutDates: ['2026-09-07'],
  requiredCampaignStatus: 'active',
  capacityRestrictionConfigured: false,
}

const evidence: ReservationEvidence = {
  campaignId: configuration.expectedCampaignId,
  normalizedBusinessName: '테스트카페',
  normalizedBranchName: '강남점',
  localDate: '2026-08-31',
  localTime: '11:00:00',
  timezone: 'Asia/Seoul',
  bookingMethod: 'visit_a',
  businessApprovalState: 'not_required',
  reservationStatus: 'completed',
  campaignStatus: 'active',
}

const failureFor = (overrides: Partial<ReservationEvidence>, ruleCode: string) => {
  const submitted = { ...evidence, ...overrides }
  const validation = evaluateReservationRules(submitted, { version: 4, configuration }, now)
  const failure = validation.failures.find((item) => item.ruleCode === ruleCode)
  if (failure === undefined) throw new Error(`expected ${ruleCode} to fail`)
  return reservationCorrectionVariables({ failure, evidence: submitted, configuration })
}

describe('T133 participant-safe Korean correction values', () => {
  test('explains an out-of-window time with the submitted time and the allowed window', () => {
    const values = failureFor({ localTime: '19:00:00' }, RESERVATION_RULE.TIME)
    expect(values.submitted_value).toBe('2026-08-31 19:00')
    expect(values.expected_condition).toBe('2026-08-31 10:00~18:00')
  })

  test('explains a wrong weekday in Korean rather than as an ISO number', () => {
    const values = failureFor({ localDate: '2026-08-30' }, RESERVATION_RULE.WEEKDAY)
    expect(values.submitted_value).toBe('2026-08-30 (일요일)')
    expect(values.expected_condition).toBe('월, 화, 수, 목, 금요일')
  })

  test('explains a wrong business with the configured name and branch', () => {
    const values = failureFor({ normalizedBranchName: '홍대점' }, RESERVATION_RULE.BUSINESS)
    expect(values.submitted_value).toBe('테스트카페 홍대점')
    expect(values.expected_condition).toBe('테스트카페 강남점')
  })

  test('names a single-location business without inventing a branch', () => {
    const singleLocation = { ...configuration, businesses: [{ normalizedName: '테스트카페', normalizedBranch: '' }] }
    const submitted = { ...evidence, normalizedBranchName: '홍대점' }
    const validation = evaluateReservationRules(submitted, { version: 4, configuration: singleLocation }, now)
    const failure = validation.failures.find((item) => item.ruleCode === RESERVATION_RULE.BUSINESS)
    const values = reservationCorrectionVariables({
      failure: failure ?? null,
      evidence: submitted,
      configuration: singleLocation,
    })
    expect(values.expected_condition).toBe('테스트카페')
  })

  test('explains a date outside the campaign period', () => {
    const values = failureFor({ localDate: '2026-10-05' }, RESERVATION_RULE.DATE_PERIOD)
    expect(values.submitted_value).toBe('2026-10-05')
    expect(values.expected_condition).toBe('2026-08-01 ~ 2026-09-30')
  })

  test('explains a blackout date without naming the whole restricted list', () => {
    const values = failureFor({ localDate: '2026-09-07' }, RESERVATION_RULE.BLACKOUT)
    expect(values.submitted_value).toBe('2026-09-07')
    expect(values.expected_condition).toBe('예약이 불가능한 날짜를 제외한 날짜')
  })

  test('explains insufficient lead time with the configured minimum', () => {
    const values = failureFor({ localDate: '2026-08-24', localTime: '09:10:00' }, RESERVATION_RULE.LEAD_TIME)
    expect(values.submitted_value).toBe('2026-08-24 09:10')
    expect(values.expected_condition).toBe('예약 시각 기준 최소 60분 전')
  })

  test('explains a wrong booking method in Korean, never as an internal code', () => {
    const values = failureFor({ bookingMethod: 'visit_b' }, RESERVATION_RULE.BOOKING_METHOD)
    expect(values.submitted_value).toBe('네이버 예약')
    expect(values.expected_condition).toBe('매장 전화 예약')
    expect(`${values.submitted_value}${values.expected_condition}`).not.toContain('visit_')
  })

  test('withholds internal identifiers and states behind an operator-review explanation', () => {
    const campaign = failureFor({ campaignId: '10000000-0000-4000-8000-000000000099' }, RESERVATION_RULE.CAMPAIGN)
    expect(campaign.submitted_value).toBe('확인 필요')
    expect(campaign.expected_condition).toBe('담당자 확인 후 안내드리겠습니다')
    expect(`${campaign.submitted_value}${campaign.expected_condition}`).not.toContain('10000000')

    const status = failureFor({ reservationStatus: 'cancelled' }, RESERVATION_RULE.STATUS)
    expect(status.submitted_value).toBe('예약 취소')
    expect(status.expected_condition).toBe('예약 완료 상태')
  })

  test('describes an unresolved extraction without echoing the participant message', () => {
    const values = reservationCorrectionVariables({ failure: null, evidence: null, configuration })
    expect(values.submitted_value).toBe('확인하지 못했습니다')
    expect(values.expected_condition).toBe('예약 날짜와 시간 (예: 2026-08-26 14:00)')
  })

  test('withholds everything when the rule configuration itself could not be parsed', () => {
    // A configuration error means the rules could not be applied at all, so the message must not
    // claim the submitted time was the problem.
    const submitted = { ...evidence, localTime: '19:00:00' }
    const validation = evaluateReservationRules(submitted, { version: 4 }, now)
    const failure = validation.failures.find((item) => item.ruleCode === RESERVATION_RULE.TIME)
    expect(failure?.outcome).toBe('configuration_error')
    const values = reservationCorrectionVariables({
      failure: failure ?? null,
      evidence: submitted,
      configuration: undefined,
    })
    expect(values.submitted_value).toBe('확인 필요')
    expect(values.expected_condition).toBe('담당자 확인 후 안내드리겠습니다')
  })

  test('falls back to an operator follow-up when a rule fails but its configuration is missing', () => {
    const submitted = { ...evidence, localTime: '19:00:00' }
    const values = reservationCorrectionVariables({
      failure: {
        outcome: 'fail',
        reasonCode: 'RULE_FAILED',
        ruleCode: RESERVATION_RULE.TIME,
        ruleVersion: 4,
        submittedValue: submitted.localTime,
        expectedCondition: 'inside at least one allowed interval',
        correction: RESERVATION_CORRECTION.INVALID_TIME,
        retryEligible: true,
        reviewRequired: false,
      },
      evidence: submitted,
      configuration: undefined,
    })
    expect(values.submitted_value).toBe('2026-08-31 19:00')
    expect(values.expected_condition).toBe('담당자 확인 후 안내드리겠습니다')
  })

  test('bounds every returned value and strips control characters', () => {
    const submitted = { ...evidence, normalizedBusinessName: `${'가'.repeat(400)}`, normalizedBranchName: '' }
    const validation = evaluateReservationRules(submitted, { version: 4, configuration }, now)
    const failure = validation.failures.find((item) => item.ruleCode === RESERVATION_RULE.BUSINESS)
    const values = reservationCorrectionVariables({ failure: failure ?? null, evidence: submitted, configuration })
    expect(values.submitted_value.length).toBeLessThanOrEqual(200)
    expect(values.submitted_value).not.toContain('')
  })

  test('covers every reservation correction code with a non-empty Korean explanation', () => {
    const codes = Object.values(RESERVATION_CORRECTION)
    for (const code of codes) {
      const values = reservationCorrectionVariables({
        failure: {
          outcome: 'fail',
          reasonCode: 'RULE_FAILED',
          ruleCode: RESERVATION_RULE.CAMPAIGN,
          ruleVersion: 4,
          submittedValue: null,
          expectedCondition: 'internal engineering text',
          correction: code,
          retryEligible: true,
          reviewRequired: false,
        },
        evidence,
        configuration,
      })
      expect(values.submitted_value.length).toBeGreaterThan(0)
      expect(values.expected_condition.length).toBeGreaterThan(0)
      expect(values.expected_condition).not.toContain('internal engineering text')
    }
  })
})

describe('T133 corrections composed without the judged evidence', () => {
  const timeFailure = (submittedValue: unknown) =>
    ({
      outcome: 'fail',
      reasonCode: 'RULE_FAILED',
      ruleCode: RESERVATION_RULE.TIME,
      ruleVersion: 4,
      submittedValue,
      expectedCondition: 'inside at least one allowed interval',
      correction: RESERVATION_CORRECTION.INVALID_TIME,
      retryEligible: true,
      reviewRequired: false,
    }) as const

  test('reads a strictly shaped local time from the failure when no evidence was supplied', () => {
    const values = reservationCorrectionVariables({
      failure: timeFailure('19:00:00'),
      evidence: null,
      configuration: undefined,
    })
    expect(values.submitted_value).toBe('19:00')
    expect(values.expected_condition).toBe('담당자 확인 후 안내드리겠습니다')
  })

  test('reads a strictly shaped calendar date from the failure', () => {
    const values = reservationCorrectionVariables({
      failure: { ...timeFailure('2026-10-05'), correction: RESERVATION_CORRECTION.INVALID_DATE },
      evidence: null,
      configuration: undefined,
    })
    expect(values.submitted_value).toBe('2026-10-05')
  })

  test.each([
    ['an internal identifier', '10000000-0000-4000-8000-000000000001'],
    ['a structured value', { name: '테스트카페', branch: '강남점' }],
    ['free text', '오후 7시쯤에 예약했어요'],
    ['nothing at all', null],
  ])('withholds %s rather than echoing it into the message', (_label, submittedValue) => {
    const values = reservationCorrectionVariables({
      failure: timeFailure(submittedValue),
      evidence: null,
      configuration: undefined,
    })
    expect(values.submitted_value).toBe('확인하지 못했습니다')
  })

  test('prefers the judged evidence over the failure value when both are available', () => {
    const values = reservationCorrectionVariables({
      failure: timeFailure('19:00:00'),
      evidence: { ...evidence, localTime: '20:00:00' },
      configuration,
    })
    expect(values.submitted_value).toBe('2026-08-31 20:00')
  })
})
