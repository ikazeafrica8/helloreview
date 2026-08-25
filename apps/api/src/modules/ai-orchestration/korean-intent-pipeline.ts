import type { AiIntentEvidence, AiIntentCode } from '@helloreview/contracts'
import { AiBudgetLedger, type AiBudgetReservation } from './ai-budget.js'
import { AiOrchestrationService } from './ai-orchestration.service.js'
import { preprocessParticipantText, type PreprocessedParticipantText } from './ai-safety.js'
import { AI_ORCHESTRATION_REASON } from './reason-codes.js'

export type IntentPipelineRoute =
  'deterministic_validation' | 'clarification' | 'human_review' | 'human_takeover' | 'opt_out'

export type IntentConfidencePolicy = Readonly<{
  clarificationMinimum: number
  automationMinimum: number
  sensitiveAutomationMinimum: number
}>

export type KoreanIntentInput = Readonly<{
  requestId: string
  budgetScope: string
  text: string
  operatorOwned: boolean
  schemaVersion: string
  promptVersion: string
  inputVersion: string
}>

export type KoreanIntentDecision = Readonly<{
  requestId: string
  route: IntentPipelineRoute
  reasonCode: string
  source: 'deterministic_priority' | 'deterministic_fallback' | 'ai_provider' | 'safe_failure'
  evidence: AiIntentEvidence
  budget: AiBudgetReservation | null
  preprocessing: PreprocessedParticipantText
  provenance: Readonly<{
    provider: string
    model: string
    schemaVersion: string
    promptVersion: string
    inputVersion: string
  }> | null
}>

const emptyEntities: AiIntentEvidence['entities'] = {
  participantName: null,
  phoneNumber: null,
  campaignName: null,
  reservationDateText: null,
  reservationTimeText: null,
  businessName: null,
}

const sensitiveIntents = new Set<AiIntentCode>([
  'CONSENT_AGREE',
  'CONSENT_DECLINE',
  'CONSENT_WITHDRAW',
  'RESERVATION_RESCHEDULE',
  'RESERVATION_CANCEL',
  'PRIVACY_REQUEST',
])

const evidence = (
  intentCode: AiIntentCode,
  confidence: number,
  options: Readonly<{
    ambiguities?: readonly string[]
    requiresClarification?: boolean
    requiresHumanReview?: boolean
  }> = {},
): AiIntentEvidence => ({
  task: 'intent_classification',
  intentCode,
  confidence,
  entities: emptyEntities,
  ambiguities: [...(options.ambiguities ?? [])],
  requiresClarification: options.requiresClarification ?? false,
  requiresHumanReview: options.requiresHumanReview ?? false,
})

export const classifyDeterministicPriorityIntent = (text: string): AiIntentCode => {
  if (/(개인정보|내\s*정보).{0,12}(삭제|열람|수정|정정)/u.test(text)) return 'PRIVACY_REQUEST'
  if (/(불만|항의|신고|사기|분쟁|화가\s*나)/u.test(text)) return 'COMPLAINT'
  return 'HUMAN_REQUEST'
}

const safeKeywordFallback = (text: string): AiIntentEvidence | null => {
  if (/(가이드|안내문).{0,12}(주세요|보내|확인)/u.test(text)) return evidence('GUIDELINE_REQUEST', 1)
  if (/신청.{0,12}(어떻게|방법|링크|하고\s*싶)/u.test(text)) return evidence('APPLICATION_REQUEST', 1)
  return null
}

const validateConfidencePolicy = (policy: IntentConfidencePolicy): void => {
  const values = [policy.clarificationMinimum, policy.automationMinimum, policy.sensitiveAutomationMinimum]
  if (values.some((value) => value < 0 || value > 1)) throw new Error('AI confidence thresholds must be 0..1')
  if (
    policy.clarificationMinimum > policy.automationMinimum ||
    policy.automationMinimum > policy.sensitiveAutomationMinimum
  ) {
    throw new Error('AI confidence thresholds must be monotonic')
  }
}

export class KoreanIntentPipeline {
  constructor(
    private readonly orchestration: AiOrchestrationService,
    private readonly budget: AiBudgetLedger,
    private readonly confidencePolicy: IntentConfidencePolicy,
  ) {
    validateConfidencePolicy(confidencePolicy)
  }

  async classify(input: KoreanIntentInput): Promise<KoreanIntentDecision> {
    const preprocessing = preprocessParticipantText(input.text)
    if (preprocessing.priority === 'opt_out') {
      return this.decision(input, preprocessing, {
        route: 'opt_out',
        reasonCode: AI_ORCHESTRATION_REASON.PARTICIPANT_OPT_OUT,
        source: 'deterministic_priority',
        evidence: evidence('UNKNOWN', 1, { requiresHumanReview: true }),
      })
    }
    if (input.operatorOwned || preprocessing.priority === 'human_takeover') {
      return this.decision(input, preprocessing, {
        route: 'human_takeover',
        reasonCode: AI_ORCHESTRATION_REASON.OPERATOR_OWNERSHIP_ACTIVE,
        source: 'deterministic_priority',
        evidence: evidence(classifyDeterministicPriorityIntent(preprocessing.normalizedText), 1, {
          requiresHumanReview: true,
        }),
      })
    }
    if (preprocessing.injectionSignals.length > 0) {
      return this.decision(input, preprocessing, {
        route: 'human_review',
        reasonCode: AI_ORCHESTRATION_REASON.PROMPT_INJECTION_SUSPECTED,
        source: 'safe_failure',
        evidence: evidence('UNKNOWN', 0, {
          ambiguities: [AI_ORCHESTRATION_REASON.PROMPT_INJECTION_SUSPECTED],
          requiresHumanReview: true,
        }),
      })
    }

    const reservation = this.budget.reserve(input.requestId, input.budgetScope, preprocessing.modelText)
    if (!reservation.allowed) {
      return this.decision(input, preprocessing, {
        route: 'human_review',
        reasonCode: reservation.reasonCode ?? AI_ORCHESTRATION_REASON.SCOPE_BUDGET_EXCEEDED,
        source: 'safe_failure',
        evidence: evidence('UNKNOWN', 0, {
          ambiguities: [reservation.reasonCode ?? AI_ORCHESTRATION_REASON.SCOPE_BUDGET_EXCEEDED],
          requiresHumanReview: true,
        }),
        budget: reservation,
      })
    }

    const result = await this.orchestration.execute({
      requestId: input.requestId,
      task: 'intent_classification',
      schemaVersion: input.schemaVersion,
      promptVersion: input.promptVersion,
      inputVersion: input.inputVersion,
      input: { text: preprocessing.modelText, locale: 'ko-KR', timezone: 'Asia/Seoul' },
    })
    if (result.outcome !== 'evidence' || result.evidence.task !== 'intent_classification') {
      const fallback = safeKeywordFallback(preprocessing.normalizedText)
      return this.decision(input, preprocessing, {
        route: fallback === null ? 'human_review' : 'deterministic_validation',
        reasonCode:
          fallback === null
            ? AI_ORCHESTRATION_REASON.PROVIDER_CASCADE_EXHAUSTED
            : AI_ORCHESTRATION_REASON.DETERMINISTIC_FALLBACK,
        source: fallback === null ? 'safe_failure' : 'deterministic_fallback',
        evidence:
          fallback ??
          evidence('UNKNOWN', 0, {
            ambiguities: [AI_ORCHESTRATION_REASON.PROVIDER_CASCADE_EXHAUSTED],
            requiresHumanReview: true,
          }),
        budget: reservation,
      })
    }

    return this.routeProviderEvidence(input, preprocessing, reservation, result.evidence, {
      provider: result.provider,
      model: result.model,
      schemaVersion: result.schemaVersion,
      promptVersion: result.promptVersion,
      inputVersion: result.inputVersion,
    })
  }

  private routeProviderEvidence(
    input: KoreanIntentInput,
    preprocessing: PreprocessedParticipantText,
    budget: AiBudgetReservation,
    providerEvidence: AiIntentEvidence,
    provenance: NonNullable<KoreanIntentDecision['provenance']>,
  ): KoreanIntentDecision {
    if (['HUMAN_REQUEST', 'COMPLAINT', 'PRIVACY_REQUEST'].includes(providerEvidence.intentCode)) {
      return this.decision(input, preprocessing, {
        route: 'human_takeover',
        reasonCode: AI_ORCHESTRATION_REASON.OPERATOR_OWNERSHIP_ACTIVE,
        source: 'ai_provider',
        evidence: { ...providerEvidence, requiresHumanReview: true },
        budget,
        provenance,
      })
    }
    if (providerEvidence.requiresHumanReview || providerEvidence.intentCode === 'UNKNOWN') {
      return this.decision(input, preprocessing, {
        route: 'human_review',
        reasonCode: AI_ORCHESTRATION_REASON.UNSUPPORTED_INTENT,
        source: 'ai_provider',
        evidence: providerEvidence,
        budget,
        provenance,
      })
    }
    if (
      providerEvidence.requiresClarification ||
      providerEvidence.ambiguities.length > 0 ||
      providerEvidence.intentCode === 'CONSENT_AMBIGUOUS'
    ) {
      return this.decision(input, preprocessing, {
        route: 'clarification',
        reasonCode: AI_ORCHESTRATION_REASON.AMBIGUOUS_INTENT,
        source: 'ai_provider',
        evidence: providerEvidence,
        budget,
        provenance,
      })
    }

    const automationMinimum = sensitiveIntents.has(providerEvidence.intentCode)
      ? this.confidencePolicy.sensitiveAutomationMinimum
      : this.confidencePolicy.automationMinimum
    if (providerEvidence.confidence < this.confidencePolicy.clarificationMinimum) {
      return this.decision(input, preprocessing, {
        route: 'human_review',
        reasonCode: AI_ORCHESTRATION_REASON.LOW_CONFIDENCE,
        source: 'ai_provider',
        evidence: { ...providerEvidence, requiresHumanReview: true },
        budget,
        provenance,
      })
    }
    if (providerEvidence.confidence < automationMinimum) {
      return this.decision(input, preprocessing, {
        route: 'clarification',
        reasonCode: AI_ORCHESTRATION_REASON.LOW_CONFIDENCE,
        source: 'ai_provider',
        evidence: { ...providerEvidence, requiresClarification: true },
        budget,
        provenance,
      })
    }
    return this.decision(input, preprocessing, {
      route: 'deterministic_validation',
      reasonCode: 'AI_EVIDENCE_READY_FOR_DETERMINISTIC_VALIDATION',
      source: 'ai_provider',
      evidence: providerEvidence,
      budget,
      provenance,
    })
  }

  private decision(
    input: KoreanIntentInput,
    preprocessing: PreprocessedParticipantText,
    value: Readonly<{
      route: IntentPipelineRoute
      reasonCode: string
      source: KoreanIntentDecision['source']
      evidence: AiIntentEvidence
      budget?: AiBudgetReservation
      provenance?: NonNullable<KoreanIntentDecision['provenance']>
    }>,
  ): KoreanIntentDecision {
    return {
      requestId: input.requestId,
      route: value.route,
      reasonCode: value.reasonCode,
      source: value.source,
      evidence: value.evidence,
      budget: value.budget ?? null,
      preprocessing,
      provenance: value.provenance ?? null,
    }
  }
}
