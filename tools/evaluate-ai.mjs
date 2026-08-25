import { readFile } from 'node:fs/promises'
import { createFakeAiTextProvider } from '../packages/adapters/dist/index.js'
import {
  AiBudgetLedger,
  AiOrchestrationService,
  KoreanIntentPipeline,
  evaluateAiReleaseGate,
  normalizeKoreanDateTime,
  scoreAiEvaluation,
} from '../apps/api/dist/modules/ai-orchestration/index.js'

const datasetUrl = new URL('../datasets/ai/korean-engineering-v1.json', import.meta.url)
const dataset = JSON.parse(await readFile(datasetUrl, 'utf8'))
const entities = {
  participantName: null,
  phoneNumber: null,
  campaignName: null,
  reservationDateText: null,
  reservationTimeText: null,
  businessName: null,
}
const providerSteps = dataset.intentCases
  .filter((fixture) => fixture.providerEvidence !== null)
  .map((fixture) => ({
    kind: 'evidence',
    evidence: {
      task: 'intent_classification',
      intentCode: fixture.providerEvidence.intentCode,
      confidence: fixture.providerEvidence.confidence,
      entities,
      ambiguities: [],
      requiresClarification: false,
      requiresHumanReview: false,
    },
  }))
const provider = createFakeAiTextProvider({
  provider: 'deterministic-evaluation-fixture',
  model: 'fixture-v1',
  steps: providerSteps,
  clock: () => new Date('2026-08-25T00:00:00.000Z'),
})
const pipeline = new KoreanIntentPipeline(
  new AiOrchestrationService([provider]),
  new AiBudgetLedger({
    maximumInputCharacters: 8_000,
    maximumEstimatedTokensPerRequest: 8_000,
    maximumEstimatedTokensPerScope: 500_000,
    maximumEstimatedCostMicrosPerRequest: 50_000,
    maximumEstimatedCostMicrosPerScope: 2_000_000,
    estimatedCostMicrosPerThousandTokens: 1_000,
  }),
  { clarificationMinimum: 0.6, automationMinimum: 0.85, sensitiveAutomationMinimum: 0.95 },
)

const intentPredictions = []
for (const fixture of dataset.intentCases) {
  const decision = await pipeline.classify({
    requestId: `00000000-0000-4000-8000-${String(intentPredictions.length + 1).padStart(12, '0')}`,
    budgetScope: 'engineering-evaluation-v1',
    text: fixture.text,
    operatorOwned: fixture.operatorOwned,
    schemaVersion: 'kakao-intent-v1',
    promptVersion: 'intent-prompt-v1',
    inputVersion: dataset.version,
  })
  intentPredictions.push({
    intentCode: decision.evidence.intentCode,
    route: decision.route,
    attemptedProtectedStateCommand: false,
  })
}

const dateTimePredictions = dataset.dateTimeCases.map((fixture) => {
  const normalized = normalizeKoreanDateTime({
    text: fixture.text,
    referenceDate: fixture.referenceDate,
    campaignTimezone: fixture.campaignTimezone,
  })
  const candidate = normalized.evidence.candidates[0]
  const route = normalized.evidence.requiresHumanReview
    ? 'human_review'
    : normalized.evidence.requiresClarification || normalized.evidence.ambiguities.length > 0
      ? 'clarification'
      : 'deterministic_validation'
  return {
    route,
    normalizedDate: candidate?.normalizedDate ?? null,
    normalizedTime: candidate?.normalizedTime ?? null,
    attemptedProtectedStateCommand: false,
  }
})

const report = scoreAiEvaluation({
  datasetVersion: dataset.version,
  model: 'deterministic-evaluation-fixture',
  promptVersion: 'intent-prompt-v1',
  schemaVersion: 'kakao-intent-v1',
  intentCases: dataset.intentCases,
  intentPredictions,
  dateTimeCases: dataset.dateTimeCases,
  dateTimePredictions,
})
const gate = evaluateAiReleaseGate({
  report,
  providerApproved: false,
  overseasProcessingDecisionRecorded: false,
  datasetProvenanceVerified: dataset.provenance.synthetic && !dataset.provenance.containsRealApplicantData,
})

console.log(JSON.stringify(gate, null, 2))
if (!report.engineeringPassed) process.exitCode = 1
