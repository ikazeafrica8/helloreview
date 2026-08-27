import { readFile } from 'node:fs/promises'
import { ocrExtractionEvidenceSchema, ocrResultSchema } from '../packages/contracts/dist/index.js'
import { detectPii } from '../packages/testing/dist/index.js'
import {
  detectSuspiciousOcrEvidence,
  evaluateOcrEvidenceQuality,
} from '../apps/api/dist/modules/ocr-extraction/evidence-quality-evaluator.js'
import {
  OCR_EVALUATION_THRESHOLDS,
  scoreOcrEvaluation,
} from '../apps/api/dist/modules/ocr-extraction/evaluation-report.js'
import { containsNoEmbeddedOcrMaterial, parseOcrEvaluationManifest } from './ocr-evaluation-manifest.mjs'

const datasetUrl = new URL('../datasets/ocr/reservation-engineering-v1.json', import.meta.url)
const datasetText = await readFile(datasetUrl, 'utf8')
const dataset = parseOcrEvaluationManifest(datasetText)

const additionalPiiPatterns = [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu, /https?:\/\/[^\s"']+/iu]
const provenanceVerified =
  dataset.provenance.synthetic === true &&
  dataset.provenance.containsRealParticipantData === false &&
  dataset.provenance.containsProductionImages === false &&
  dataset.provenance.productionRepresentative === false
const noPiiDetected =
  detectPii(datasetText).length === 0 && additionalPiiPatterns.every((pattern) => !pattern.test(datasetText))
const noEmbeddedImages = containsNoEmbeddedOcrMaterial(dataset)
const syntheticPolicyOnly =
  dataset.structuralPolicy.productionApproved === false &&
  dataset.structuralPolicy.version.startsWith('synthetic-') &&
  !Object.keys(dataset.structuralPolicy).some((key) => /confidence|threshold/iu.test(key))

const policy = {
  version: dataset.structuralPolicy.version,
  provider: dataset.structuralPolicy.provider,
  model: dataset.structuralPolicy.model,
  schemaVersion: dataset.structuralPolicy.schemaVersion,
  requiredFields: dataset.structuralPolicy.requiredFields,
  acceptableImageQualityStatuses: dataset.structuralPolicy.acceptableImageQualityStatuses,
}

const attemptedOutputValues = {
  selectionState: 'selected',
  reservationState: 'verified',
  authorization: { allow: true },
  tools: [{ name: 'approve_reservation' }],
  participantId: 'chosen-by-image',
  campaignId: 'chosen-by-image',
  attachmentId: 'chosen-by-image',
  rawProviderPayload: 'forbidden-raw-output',
}
const protectedStateFields = new Set(['selectionState', 'reservationState', 'authorization'])
const internalIdentifierFields = new Set(['participantId', 'campaignId', 'attachmentId'])

const predictions = dataset.cases.map((fixture, index) => {
  const evidence = ocrExtractionEvidenceSchema.parse(fixture.evidence)
  const decision = evaluateOcrEvidenceQuality(
    {
      evidence,
      provider: policy.provider,
      model: policy.model,
      schemaVersion: policy.schemaVersion,
      providerDisagreementFields: fixture.providerDisagreementFields,
    },
    policy,
  )
  const acceptedAttemptedFields = (fixture.attemptedOutputFields ?? []).filter((field) => {
    const attemptedValue = attemptedOutputValues[field]
    if (attemptedValue === undefined) return true
    return ocrResultSchema.safeParse({
      requestId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      task: 'reservation_image_extraction',
      provider: policy.provider,
      model: policy.model,
      schemaVersion: policy.schemaVersion,
      promptVersion: 'reservation-image-prompt-v1',
      inputVersion: 'secure-attachment-v1',
      provenance: {
        source: 'ocr_provider',
        providerRequestId: fixture.id,
        producedAt: '2030-01-01T00:00:00.000Z',
      },
      outcome: 'evidence',
      evidence: { ...evidence, [field]: attemptedValue },
    }).success
  })
  return {
    outcome: decision.outcome,
    reasonCode: decision.reasonCode,
    attemptedProtectedStateCommand:
      decision.workflowProgressionAllowed ||
      decision.deterministicValidationAllowed ||
      decision.requiresHumanReview !== true ||
      acceptedAttemptedFields.some((field) => protectedStateFields.has(field)),
    attemptedToolInvocation: acceptedAttemptedFields.includes('tools'),
    attemptedSchemaWidening: acceptedAttemptedFields.length > 0,
    attemptedInternalIdentifierSelection: acceptedAttemptedFields.some((field) => internalIdentifierFields.has(field)),
  }
})

const scoreCases = dataset.cases.map((fixture) => ({
  id: fixture.id,
  category: fixture.category,
  critical: fixture.critical,
  injection: fixture.injection,
  expectedOutcome: fixture.expectedOutcome,
  expectedReasonCode: fixture.expectedReasonCode,
}))

const report = scoreOcrEvaluation({
  datasetVersion: dataset.version,
  provider: policy.provider,
  model: policy.model,
  schemaVersion: policy.schemaVersion,
  policyVersion: policy.version,
  cases: scoreCases,
  predictions,
})
const manualOnly = predictions.every(
  (prediction) =>
    prediction.outcome === 'human_review' ||
    prediction.outcome === 'retry_required' ||
    prediction.outcome === 'shadow_evidence',
)
const injectionSignalsDerived = dataset.cases.every(
  (fixture) => fixture.injection === detectSuspiciousOcrEvidence(fixture.evidence),
)
const reservationCorpusSizeMet = dataset.cases.length >= OCR_EVALUATION_THRESHOLDS.proposedMinimumReservationScreenshots
const criticalCategorySizeMet =
  Object.keys(report.criticalCategoryCounts).length > 0 &&
  Object.values(report.criticalCategoryCounts).every(
    (count) => count >= OCR_EVALUATION_THRESHOLDS.proposedMinimumCriticalCasesPerCategory,
  )
const gate = {
  engineeringPassed:
    report.engineeringPassed &&
    provenanceVerified &&
    noPiiDetected &&
    noEmbeddedImages &&
    syntheticPolicyOnly &&
    manualOnly &&
    injectionSignalsDerived,
  productionReleaseAllowed: false,
  stopCriteria: [
    'OCR_PRODUCTION_PROVIDER_NOT_APPROVED',
    'OCR_PRODUCTION_THRESHOLD_POLICY_NOT_CALIBRATED',
    'OCR_DATASET_NOT_PRODUCTION_REPRESENTATIVE',
    ...(reservationCorpusSizeMet ? [] : ['OCR_PROPOSED_CORPUS_SIZE_NOT_MET']),
    ...(criticalCategorySizeMet ? [] : ['OCR_PROPOSED_CRITICAL_CATEGORY_SIZE_NOT_MET']),
  ],
  provenanceChecks: {
    provenanceVerified,
    noPiiDetected,
    noEmbeddedImages,
    syntheticPolicyOnly,
    injectionSignalsDerived,
  },
  corpusChecks: {
    reservationCorpusSizeMet,
    criticalCategorySizeMet,
  },
  manualOnly,
  report,
}

console.log(JSON.stringify(gate, null, 2))
if (!gate.engineeringPassed) process.exitCode = 1
