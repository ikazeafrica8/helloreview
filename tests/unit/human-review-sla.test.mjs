import { describe, expect, test } from 'vitest'
import { scheduleHumanReviewSla } from '../../apps/api/dist/modules/human-tasks/index.js'

const policy = () => ({
  version: 'operator-hours-v1',
  timezone: 'Asia/Seoul',
  serviceWeekdays: [1, 2, 3, 4, 5],
  serviceStartMinute: 9 * 60,
  serviceEndMinute: 18 * 60,
  holidayDates: ['2026-08-27'],
  targets: {
    normal: { responseMinutes: 120, escalationMinutes: 240 },
    high: { responseMinutes: 60, escalationMinutes: 120 },
    critical: { responseMinutes: 15, escalationMinutes: 30 },
  },
})

describe('T91 human-review SLA schedule', () => {
  test('does not invent a deadline when the service policy is absent', () => {
    expect(scheduleHumanReviewSla(new Date('2026-08-26T07:00:00.000Z'), 'critical', null)).toEqual({
      state: 'SLA_POLICY_MISSING',
    })
  })

  test('counts only approved Seoul service minutes and skips a configured holiday', () => {
    const schedule = scheduleHumanReviewSla(new Date('2026-08-26T08:30:00.000Z'), 'normal', policy())
    expect(schedule).toEqual({
      state: 'scheduled',
      policyVersion: 'operator-hours-v1',
      dueAt: new Date('2026-08-28T01:30:00.000Z'),
      escalationAt: new Date('2026-08-28T03:30:00.000Z'),
    })
  })

  test('rejects an incomplete or incoherent policy', () => {
    expect(() =>
      scheduleHumanReviewSla(new Date('2026-08-26T00:00:00.000Z'), 'high', {
        ...policy(),
        targets: { ...policy().targets, high: { responseMinutes: 60, escalationMinutes: 30 } },
      }),
    ).toThrow(/target/)
  })

  test('rejects an impossible holiday date', () => {
    expect(() =>
      scheduleHumanReviewSla(new Date('2026-08-26T00:00:00.000Z'), 'high', {
        ...policy(),
        holidayDates: ['2026-02-30'],
      }),
    ).toThrow(/holiday/)
  })
})
