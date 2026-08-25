import type { AiDateTimeEvidence } from '@helloreview/contracts'
import { AiBudgetLedger, type AiBudgetReservation } from './ai-budget.js'
import { AiOrchestrationService } from './ai-orchestration.service.js'
import { preprocessParticipantText, type PreprocessedParticipantText } from './ai-safety.js'
import {
  KOREAN_DATE_TIME_REASON,
  normalizeKoreanDateTime,
  type SeoulCalendarDate,
} from './korean-date-time-normalizer.js'
import { AI_ORCHESTRATION_REASON } from './reason-codes.js'

export type AiClock = Readonly<{ now: () => Date }>
export type DateTimePipelineRoute = 'deterministic_validation' | 'clarification' | 'human_review'

export type KoreanDateTimeInput = Readonly<{
  requestId: string
  budgetScope: string
  text: string
  messageTimestamp: Date | null
  campaignTimezone: string | null
  schemaVersion: string
  promptVersion: string
  inputVersion: string
}>

export type KoreanDateTimeDecision = Readonly<{
  requestId: string
  route: DateTimePipelineRoute
  reasonCode: string
  source: 'deterministic' | 'ai_provider' | 'safe_failure'
  evidence: AiDateTimeEvidence
  referenceTimestamp: string
  preprocessing: PreprocessedParticipantText
  budget: AiBudgetReservation | null
  provenance: Readonly<{ provider: string; model: string; promptVersion: string; schemaVersion: string }> | null
}>

const seoulDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const seoulCalendarDate = (instant: Date): SeoulCalendarDate => {
  const parts = seoulDateFormatter.formatToParts(instant)
  const value = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === type)?.value)
  return { year: value('year'), month: value('month'), day: value('day') }
}

const routeEvidence = (value: AiDateTimeEvidence): DateTimePipelineRoute => {
  if (value.requiresHumanReview) return 'human_review'
  if (value.requiresClarification || value.ambiguities.length > 0) return 'clarification'
  return 'deterministic_validation'
}

const withIssue = (value: AiDateTimeEvidence, issue: string, humanReview = true): AiDateTimeEvidence => ({
  ...value,
  ambiguities: [...new Set([...value.ambiguities, issue])].sort(),
  requiresClarification: humanReview ? false : true,
  requiresHumanReview: humanReview || value.requiresHumanReview,
})

export class KoreanDateTimePipeline {
  constructor(
    private readonly orchestration: AiOrchestrationService,
    private readonly budget: AiBudgetLedger,
    private readonly clock: AiClock,
  ) {}

  async extract(input: KoreanDateTimeInput): Promise<KoreanDateTimeDecision> {
    const reference = input.messageTimestamp ?? this.clock.now()
    const preprocessing = preprocessParticipantText(input.text)
    const normalized = normalizeKoreanDateTime({
      text: preprocessing.normalizedText,
      referenceDate: seoulCalendarDate(reference),
      campaignTimezone: input.campaignTimezone,
    })
    if (preprocessing.injectionSignals.length > 0) {
      return this.decision(input, preprocessing, reference, {
        source: 'safe_failure',
        reasonCode: AI_ORCHESTRATION_REASON.PROMPT_INJECTION_SUSPECTED,
        evidence: withIssue(normalized.evidence, AI_ORCHESTRATION_REASON.PROMPT_INJECTION_SUSPECTED),
      })
    }
    if (
      normalized.complete ||
      normalized.recognizedExpression ||
      input.campaignTimezone === null ||
      input.campaignTimezone !== 'Asia/Seoul'
    ) {
      return this.decision(input, preprocessing, reference, {
        source: 'deterministic',
        reasonCode: normalized.complete ? 'DATE_TIME_READY_FOR_DETERMINISTIC_VALIDATION' : 'DATE_TIME_REQUIRES_REVIEW',
        evidence: normalized.evidence,
      })
    }

    const reservation = this.budget.reserve(input.requestId, input.budgetScope, preprocessing.modelText)
    if (!reservation.allowed) {
      return this.decision(input, preprocessing, reference, {
        source: 'safe_failure',
        reasonCode: reservation.reasonCode ?? AI_ORCHESTRATION_REASON.SCOPE_BUDGET_EXCEEDED,
        evidence: withIssue(
          normalized.evidence,
          reservation.reasonCode ?? AI_ORCHESTRATION_REASON.SCOPE_BUDGET_EXCEEDED,
        ),
        budget: reservation,
      })
    }

    const result = await this.orchestration.execute({
      requestId: input.requestId,
      task: 'date_time_extraction',
      schemaVersion: input.schemaVersion,
      promptVersion: input.promptVersion,
      inputVersion: input.inputVersion,
      input: {
        text: preprocessing.modelText,
        locale: 'ko-KR',
        timezone: 'Asia/Seoul',
        referenceTimestamp: reference.toISOString(),
      },
    })
    if (result.outcome !== 'evidence' || result.evidence.task !== 'date_time_extraction') {
      return this.decision(input, preprocessing, reference, {
        source: 'safe_failure',
        reasonCode: AI_ORCHESTRATION_REASON.PROVIDER_CASCADE_EXHAUSTED,
        evidence: withIssue(normalized.evidence, AI_ORCHESTRATION_REASON.PROVIDER_CASCADE_EXHAUSTED),
        budget: reservation,
      })
    }

    const checked = this.validateProviderEvidence(result.evidence, seoulCalendarDate(reference))
    return this.decision(input, preprocessing, reference, {
      source: 'ai_provider',
      reasonCode:
        routeEvidence(checked) === 'deterministic_validation'
          ? 'DATE_TIME_READY_FOR_DETERMINISTIC_VALIDATION'
          : 'DATE_TIME_REQUIRES_REVIEW',
      evidence: checked,
      budget: reservation,
      provenance: {
        provider: result.provider,
        model: result.model,
        promptVersion: result.promptVersion,
        schemaVersion: result.schemaVersion,
      },
    })
  }

  private validateProviderEvidence(value: AiDateTimeEvidence, reference: SeoulCalendarDate): AiDateTimeEvidence {
    let checked = value
    const dates = new Set(value.candidates.flatMap((candidate) => candidate.normalizedDate ?? []))
    const times = new Set(value.candidates.flatMap((candidate) => candidate.normalizedTime ?? []))
    if (dates.size > 1) checked = withIssue(checked, KOREAN_DATE_TIME_REASON.CONFLICTING_DATE_EXPRESSIONS, false)
    if (times.size > 1) checked = withIssue(checked, KOREAN_DATE_TIME_REASON.CONFLICTING_TIME_EXPRESSIONS, false)
    const referenceIso = `${String(reference.year).padStart(4, '0')}-${String(reference.month).padStart(2, '0')}-${String(reference.day).padStart(2, '0')}`
    if ([...dates].some((date) => date < referenceIso)) {
      checked = withIssue(checked, KOREAN_DATE_TIME_REASON.DATE_IN_PAST)
    }
    if (checked.candidates.length === 0) {
      checked = withIssue(checked, KOREAN_DATE_TIME_REASON.UNSUPPORTED_DATE_TIME_EXPRESSION)
    }
    return checked
  }

  private decision(
    input: KoreanDateTimeInput,
    preprocessing: PreprocessedParticipantText,
    reference: Date,
    value: Readonly<{
      source: KoreanDateTimeDecision['source']
      reasonCode: string
      evidence: AiDateTimeEvidence
      budget?: AiBudgetReservation
      provenance?: NonNullable<KoreanDateTimeDecision['provenance']>
    }>,
  ): KoreanDateTimeDecision {
    return {
      requestId: input.requestId,
      route: routeEvidence(value.evidence),
      reasonCode: value.reasonCode,
      source: value.source,
      evidence: value.evidence,
      referenceTimestamp: reference.toISOString(),
      preprocessing,
      budget: value.budget ?? null,
      provenance: value.provenance ?? null,
    }
  }
}
