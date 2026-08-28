export { OcrExtractionError, OcrExtractionService } from './ocr-extraction.service.js'
export { DEFAULT_OCR_IDEMPOTENCY_POLICY } from './ocr-extraction.service.js'
export type { OcrExtractionServiceOptions, OcrIdempotencyPolicy } from './ocr-extraction.service.js'
export { OCR_ORCHESTRATION_REASON } from './reason-codes.js'
export {
  OCR_EVIDENCE_REASON,
  detectSuspiciousOcrEvidence,
  detectSuspiciousOcrText,
  evaluateOcrEvidenceQuality,
} from './evidence-quality-evaluator.js'
export type {
  OcrEvidenceQualityDecision,
  OcrEvidenceQualityInput,
  OcrEvidenceQualityPolicy,
  OcrEvidenceReasonCode,
} from './evidence-quality-evaluator.js'
export { OCR_EVALUATION_THRESHOLDS, scoreOcrEvaluation } from './evaluation-report.js'
export type {
  OcrEvaluationCase,
  OcrEvaluationInput,
  OcrEvaluationPrediction,
  OcrEvaluationReport,
} from './evaluation-report.js'
