import { SELECTION_REASON, type SelectionReasonCode } from './reason-codes.js'

export type RankingEvidence = Readonly<{
  bloggerLevel: number | null
  blogDailyVisitors: number | null
  bloggerRegion: string | null
  mappedRegion: string | null
  measurementPeriod: string | null
  sourceFreshnessAt: Date
  sourceEventId: string
  fresh: boolean
}>

export type SelectionPolicy = Readonly<{
  version: string
  eligibleLevels: readonly number[]
  minimumDailyVisitors: number
  reviewBand: Readonly<{ lowerInclusive: number; upperInclusive: number }>
  eligibleMappedRegions: readonly string[]
  measurementPeriod: string
}>

export type SelectionRecommendationResult = 'recommend_select' | 'recommend_not_select' | 'human_review'

export type SelectionComponentOutcome = Readonly<{
  component: 'freshness' | 'level' | 'visitors' | 'region' | 'measurement_period'
  outcome: 'pass' | 'fail' | 'review'
  reasonCode: SelectionReasonCode
}>

export type SelectionEvaluation = Readonly<{
  result: SelectionRecommendationResult
  reasonCode: SelectionReasonCode
  policyVersion: string | null
  componentOutcomes: readonly SelectionComponentOutcome[]
}>

const outcome = (
  component: SelectionComponentOutcome['component'],
  result: SelectionComponentOutcome['outcome'],
  reasonCode: SelectionReasonCode,
): SelectionComponentOutcome => ({ component, outcome: result, reasonCode })

const review = (
  reasonCode: SelectionReasonCode,
  componentOutcomes: readonly SelectionComponentOutcome[],
  policyVersion: string | null,
): SelectionEvaluation => ({ result: 'human_review', reasonCode, policyVersion, componentOutcomes })

/** Pure shadow evaluator. Thresholds must be supplied by versioned campaign policy; none are invented here. */
export const evaluateSelectionRecommendation = (
  evidence: RankingEvidence,
  policy: SelectionPolicy | null,
): SelectionEvaluation => {
  if (policy === null) return review(SELECTION_REASON.MISSING_SELECTION_POLICY, [], null)
  if (!evidence.fresh)
    return review(
      SELECTION_REASON.STALE_RANKING_EVIDENCE,
      [outcome('freshness', 'review', SELECTION_REASON.STALE_RANKING_EVIDENCE)],
      policy.version,
    )
  if (evidence.bloggerLevel === null || evidence.blogDailyVisitors === null || evidence.measurementPeriod === null)
    return review(
      SELECTION_REASON.MISSING_RANKING_EVIDENCE,
      [outcome('visitors', 'review', SELECTION_REASON.MISSING_RANKING_EVIDENCE)],
      policy.version,
    )
  if (evidence.measurementPeriod !== policy.measurementPeriod)
    return review(
      SELECTION_REASON.VISITOR_MEASUREMENT_PERIOD_MISMATCH,
      [outcome('measurement_period', 'review', SELECTION_REASON.VISITOR_MEASUREMENT_PERIOD_MISMATCH)],
      policy.version,
    )
  if (evidence.bloggerRegion === null || evidence.mappedRegion === null)
    return review(
      SELECTION_REASON.UNRESOLVED_REGION_MAPPING,
      [outcome('region', 'review', SELECTION_REASON.UNRESOLVED_REGION_MAPPING)],
      policy.version,
    )

  const componentOutcomes: SelectionComponentOutcome[] = [
    outcome('freshness', 'pass', SELECTION_REASON.ELIGIBLE),
    outcome('measurement_period', 'pass', SELECTION_REASON.ELIGIBLE),
  ]
  if (!policy.eligibleMappedRegions.includes(evidence.mappedRegion)) {
    componentOutcomes.push(outcome('region', 'fail', SELECTION_REASON.INELIGIBLE_REGION))
    return {
      result: 'recommend_not_select',
      reasonCode: SELECTION_REASON.INELIGIBLE_REGION,
      policyVersion: policy.version,
      componentOutcomes,
    }
  }
  componentOutcomes.push(outcome('region', 'pass', SELECTION_REASON.ELIGIBLE))
  if (!policy.eligibleLevels.includes(evidence.bloggerLevel)) {
    componentOutcomes.push(outcome('level', 'fail', SELECTION_REASON.INELIGIBLE_LEVEL))
    return {
      result: 'recommend_not_select',
      reasonCode: SELECTION_REASON.INELIGIBLE_LEVEL,
      policyVersion: policy.version,
      componentOutcomes,
    }
  }
  componentOutcomes.push(outcome('level', 'pass', SELECTION_REASON.ELIGIBLE))
  if (
    evidence.blogDailyVisitors >= policy.reviewBand.lowerInclusive &&
    evidence.blogDailyVisitors <= policy.reviewBand.upperInclusive
  ) {
    componentOutcomes.push(outcome('visitors', 'review', SELECTION_REASON.BORDERLINE_SELECTION))
    return review(SELECTION_REASON.BORDERLINE_SELECTION, componentOutcomes, policy.version)
  }
  if (evidence.blogDailyVisitors < policy.minimumDailyVisitors) {
    componentOutcomes.push(outcome('visitors', 'fail', SELECTION_REASON.BELOW_VISITOR_THRESHOLD))
    return {
      result: 'recommend_not_select',
      reasonCode: SELECTION_REASON.BELOW_VISITOR_THRESHOLD,
      policyVersion: policy.version,
      componentOutcomes,
    }
  }
  componentOutcomes.push(outcome('visitors', 'pass', SELECTION_REASON.ELIGIBLE))
  return {
    result: 'recommend_select',
    reasonCode: SELECTION_REASON.ELIGIBLE,
    policyVersion: policy.version,
    componentOutcomes,
  }
}
