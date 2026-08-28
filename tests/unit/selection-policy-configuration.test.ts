import { describe, expect, test } from 'vitest'
import {
  NON_SELECTION_POLICIES,
  SOURCE_VISITOR_MEASUREMENT_PERIOD,
  VISITOR_MEASUREMENT_PERIODS,
  parseSelectionRuleConfiguration,
  selectionPolicyFrom,
} from '../../apps/api/src/modules/selection/selection-policy.js'
import { evaluateSelectionRecommendation } from '../../apps/api/src/modules/selection/recommendation-evaluator.js'

const configuration = (overrides: Record<string, unknown> = {}) => ({
  measurementPeriod: 'website_average_daily',
  eligibleLevels: [1, 2, 3],
  minimumDailyVisitors: 1000,
  regionalMinimumDailyVisitors: 300,
  reviewBand: { lowerInclusive: 900, upperInclusive: 1099 },
  regionMapping: { 서울: 'capital', 부산: 'regional' },
  eligibleMappedRegions: ['capital', 'regional'],
  regionalMappedRegions: ['regional'],
  nonSelectionPolicy: 'send_notice',
  automaticSelectionEnabled: false,
  ...overrides,
})

describe('T136 versioned selection policy', () => {
  test('names the one period this platform can actually produce', () => {
    expect(VISITOR_MEASUREMENT_PERIODS).toEqual(['website_average_daily'])
    expect(SOURCE_VISITOR_MEASUREMENT_PERIOD).toBe('website_average_daily')
    expect(NON_SELECTION_POLICIES).toEqual(['send_notice', 'suppress_notice'])
  })

  test('accepts a complete published configuration and versions the policy from the rule', () => {
    const parsed = parseSelectionRuleConfiguration(configuration())
    if (parsed === undefined) throw new Error('a complete configuration must parse')
    expect(parsed).toMatchObject({
      measurementPeriod: 'website_average_daily',
      minimumDailyVisitors: 1000,
      regionalMinimumDailyVisitors: 300,
      nonSelectionPolicy: 'send_notice',
      automaticSelectionEnabled: false,
    })
    expect(selectionPolicyFrom(parsed, 4)).toMatchObject({
      version: 'selection-rule-v4',
      eligibleLevels: [1, 2, 3],
      measurementPeriod: 'website_average_daily',
    })
  })

  test('refuses a previous-day period until a separately sourced metric exists', () => {
    expect(
      parseSelectionRuleConfiguration(configuration({ measurementPeriod: 'previous_calendar_day' })),
    ).toBeUndefined()
    expect(parseSelectionRuleConfiguration(configuration({ measurementPeriod: 'rolling_24_hours' }))).toBeUndefined()
  })

  test('refuses to store an enabled automatic selection', () => {
    expect(parseSelectionRuleConfiguration(configuration({ automaticSelectionEnabled: true }))).toBeUndefined()
  })

  test.each([
    ['an unknown field', configuration({ overrideThreshold: 1 })],
    ['no eligible levels', configuration({ eligibleLevels: [] })],
    ['duplicate eligible levels', configuration({ eligibleLevels: [1, 1] })],
    ['an inverted review band', configuration({ reviewBand: { lowerInclusive: 1200, upperInclusive: 900 } })],
    ['a regional region that is not eligible', configuration({ regionalMappedRegions: ['island'] })],
    ['a mapping target that is not an eligible region', configuration({ regionMapping: { 서울: 'offshore' } })],
    ['an unknown non-selection policy', configuration({ nonSelectionPolicy: 'ask_operator' })],
    ['a negative threshold', configuration({ minimumDailyVisitors: -1 })],
  ])('refuses %s rather than defaulting it', (_label, invalid) => {
    expect(parseSelectionRuleConfiguration(invalid)).toBeUndefined()
  })

  test('a policy that claims the wrong period now fails the evaluator instead of scoring', () => {
    const evidence = {
      bloggerLevel: 1,
      blogDailyVisitors: 1500,
      bloggerRegion: '서울',
      mappedRegion: 'capital',
      // What the adapter now reports, from the column it actually read.
      measurementPeriod: SOURCE_VISITOR_MEASUREMENT_PERIOD,
      sourceFreshnessAt: new Date('2026-08-28T00:00:00Z'),
      sourceEventId: 'evt-1',
      fresh: true,
    }
    const relabelled = {
      version: 'selection-legacy-v1',
      eligibleLevels: [1, 2],
      minimumDailyVisitors: 1000,
      reviewBand: { lowerInclusive: 900, upperInclusive: 1099 },
      eligibleMappedRegions: ['capital'],
      measurementPeriod: 'previous_calendar_day',
    }
    expect(evaluateSelectionRecommendation(evidence, relabelled)).toMatchObject({
      result: 'human_review',
      reasonCode: 'VISITOR_MEASUREMENT_PERIOD_MISMATCH',
    })

    const published = parseSelectionRuleConfiguration(configuration())
    if (published === undefined) throw new Error('a complete configuration must parse')
    expect(evaluateSelectionRecommendation(evidence, selectionPolicyFrom(published, 4))).toMatchObject({
      result: 'recommend_select',
    })
  })
})
