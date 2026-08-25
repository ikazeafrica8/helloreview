import { describe, expect, test } from 'vitest'
import {
  evaluateSelectionRecommendation,
  type RankingEvidence,
  type SelectionPolicy,
} from '../../apps/api/src/modules/selection/recommendation-evaluator.js'

const evidence = (overrides: Partial<RankingEvidence> = {}): RankingEvidence => ({
  bloggerLevel: 1,
  blogDailyVisitors: 1_500,
  bloggerRegion: '서울',
  mappedRegion: 'capital',
  measurementPeriod: 'previous_calendar_day',
  sourceFreshnessAt: new Date('2026-08-25T00:00:00Z'),
  sourceEventId: 'manual-csv-event-1',
  fresh: true,
  ...overrides,
})

const policy = (overrides: Partial<SelectionPolicy> = {}): SelectionPolicy => ({
  version: 'selection-v7',
  eligibleLevels: [1, 2],
  minimumDailyVisitors: 1_000,
  reviewBand: { lowerInclusive: 900, upperInclusive: 1_099 },
  eligibleMappedRegions: ['capital'],
  measurementPeriod: 'previous_calendar_day',
  ...overrides,
})

describe('pure selection recommendation evaluator', () => {
  test.each([
    ['missing policy', evidence(), null, 'human_review', 'MISSING_SELECTION_POLICY'],
    ['stale source', evidence({ fresh: false }), policy(), 'human_review', 'STALE_RANKING_EVIDENCE'],
    ['missing level', evidence({ bloggerLevel: null }), policy(), 'human_review', 'MISSING_RANKING_EVIDENCE'],
    ['missing visitors', evidence({ blogDailyVisitors: null }), policy(), 'human_review', 'MISSING_RANKING_EVIDENCE'],
    ['missing period', evidence({ measurementPeriod: null }), policy(), 'human_review', 'MISSING_RANKING_EVIDENCE'],
    [
      'wrong period',
      evidence({ measurementPeriod: 'rolling_24_hours' }),
      policy(),
      'human_review',
      'VISITOR_MEASUREMENT_PERIOD_MISMATCH',
    ],
    ['missing source region', evidence({ bloggerRegion: null }), policy(), 'human_review', 'UNRESOLVED_REGION_MAPPING'],
    ['unmapped region', evidence({ mappedRegion: null }), policy(), 'human_review', 'UNRESOLVED_REGION_MAPPING'],
    [
      'ineligible mapped region',
      evidence({ mappedRegion: 'other' }),
      policy(),
      'recommend_not_select',
      'INELIGIBLE_REGION',
    ],
    ['ineligible level', evidence({ bloggerLevel: 4 }), policy(), 'recommend_not_select', 'INELIGIBLE_LEVEL'],
    ['lower review boundary', evidence({ blogDailyVisitors: 900 }), policy(), 'human_review', 'BORDERLINE_SELECTION'],
    ['upper review boundary', evidence({ blogDailyVisitors: 1_099 }), policy(), 'human_review', 'BORDERLINE_SELECTION'],
    [
      'below threshold',
      evidence({ blogDailyVisitors: 899 }),
      policy(),
      'recommend_not_select',
      'BELOW_VISITOR_THRESHOLD',
    ],
    ['eligible', evidence(), policy(), 'recommend_select', 'ELIGIBLE'],
  ])('%s', (_label, facts, configuredPolicy, result, reasonCode) => {
    expect(evaluateSelectionRecommendation(facts, configuredPolicy)).toMatchObject({ result, reasonCode })
  })

  test('does not mutate evidence or policy and only reports supplied policy versions', () => {
    const facts = Object.freeze(evidence())
    const configuredPolicy = Object.freeze(policy())
    const result = evaluateSelectionRecommendation(facts, configuredPolicy)
    expect(result.policyVersion).toBe('selection-v7')
    expect(facts.blogDailyVisitors).toBe(1_500)
    expect(configuredPolicy.minimumDailyVisitors).toBe(1_000)
  })
})
