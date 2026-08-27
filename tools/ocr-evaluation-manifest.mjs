import { Buffer } from 'node:buffer'
import {
  OCR_EVIDENCE_FIELDS,
  OCR_IMAGE_QUALITY_STATUSES,
  OCR_SCHEMA_VERSION,
  ocrExtractionEvidenceSchema,
} from '../packages/contracts/dist/index.js'
import { OCR_EVIDENCE_REASON } from '../apps/api/dist/modules/ocr-extraction/evidence-quality-evaluator.js'

const MAX_MANIFEST_BYTES = 250_000
const MAX_CASES = 1_000
const MANIFEST_VERSION = 'reservation-ocr-synthetic-v1'
const POLICY_VERSION = 'synthetic-structural-policy-v1'
const SYNTHETIC_PROVIDER = 'deterministic-ocr-fixture'
const SYNTHETIC_MODEL = 'synthetic-v1'
const TOP_LEVEL_KEYS = ['version', 'provenance', 'structuralPolicy', 'cases']
const PROVENANCE_KEYS = [
  'synthetic',
  'containsRealParticipantData',
  'containsProductionImages',
  'productionRepresentative',
]
const POLICY_KEYS = [
  'version',
  'productionApproved',
  'provider',
  'model',
  'schemaVersion',
  'requiredFields',
  'acceptableImageQualityStatuses',
]
const CASE_KEYS = [
  'id',
  'category',
  'critical',
  'injection',
  'providerDisagreementFields',
  'expectedOutcome',
  'expectedReasonCode',
  'evidence',
]
const OPTIONAL_CASE_KEYS = [...CASE_KEYS, 'attemptedOutputFields']
const OUTCOMES = new Set(['shadow_evidence', 'retry_required', 'human_review'])
const REASON_CODES = new Set(Object.values(OCR_EVIDENCE_REASON))
const ATTEMPTED_OUTPUT_FIELDS = new Set([
  'selectionState',
  'reservationState',
  'authorization',
  'tools',
  'participantId',
  'campaignId',
  'attachmentId',
  'rawProviderPayload',
])
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u
const FORBIDDEN_MATERIAL_KEY =
  /^(?:image|url)$|base64|binary|blob|bytes|rawimage|imagepath|imageurl|filepath|storagepath|downloadurl|sourceurl/iu
const DATA_OR_URL = /(?:data|blob|https?):/iu
const BASE64_LIKE = /[A-Za-z0-9+/]{120,}={0,2}/u

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

const assertExactKeys = (value, expected, path) => {
  if (!isRecord(value)) throw new Error(`${path} must be an object`)
  const actual = Object.keys(value)
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) {
    throw new Error(`${path} has an unexpected or missing field`)
  }
}

const assertIdentifier = (value, path) => {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`${path} must be a bounded identifier`)
  }
}

const assertUniqueAllowedStrings = (value, allowed, maximum, path) => {
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    new Set(value).size !== value.length ||
    value.some((item) => typeof item !== 'string' || !allowed.has(item))
  ) {
    throw new Error(`${path} must contain unique allowlisted values`)
  }
}

const rejectEmbeddedMaterial = (value, path = '$') => {
  if (typeof value === 'string') {
    const normalized = value.normalize('NFKC').replace(/\p{Cf}/gu, '')
    if (
      normalized.length > 4_000 ||
      DATA_OR_URL.test(normalized) ||
      (normalized.length >= 120 && BASE64_LIKE.test(normalized))
    ) {
      throw new Error(`${path} contains URL, binary-like, or over-limit material`)
    }
    return
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_CASES) throw new Error(`${path} exceeds the manifest collection limit`)
    value.forEach((item, index) => rejectEmbeddedMaterial(item, `${path}[${String(index)}]`))
    return
  }
  if (!isRecord(value)) return
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_MATERIAL_KEY.test(key)) throw new Error(`${path}.${key} is not an allowed manifest key`)
    rejectEmbeddedMaterial(nested, `${path}.${key}`)
  }
}

/** Re-runnable structural assertion used by the scorecard instead of trusting a manifest flag. */
export const containsNoEmbeddedOcrMaterial = (value) => {
  try {
    rejectEmbeddedMaterial(value)
    return true
  } catch {
    return false
  }
}

const freezeDeep = (value) => {
  if (Array.isArray(value)) {
    value.forEach(freezeDeep)
    return Object.freeze(value)
  }
  if (isRecord(value)) {
    Object.values(value).forEach(freezeDeep)
    return Object.freeze(value)
  }
  return value
}

export const parseOcrEvaluationManifest = (datasetText) => {
  if (typeof datasetText !== 'string' || Buffer.byteLength(datasetText, 'utf8') > MAX_MANIFEST_BYTES) {
    throw new Error('OCR evaluation manifest must be bounded UTF-8 text')
  }
  let dataset
  try {
    dataset = JSON.parse(datasetText)
  } catch {
    throw new Error('OCR evaluation manifest must be valid JSON')
  }

  assertExactKeys(dataset, TOP_LEVEL_KEYS, 'manifest')
  rejectEmbeddedMaterial(dataset)
  assertIdentifier(dataset.version, 'manifest.version')
  if (dataset.version !== MANIFEST_VERSION) throw new Error('OCR evaluation manifest version is not allowlisted')

  assertExactKeys(dataset.provenance, PROVENANCE_KEYS, 'manifest.provenance')
  if (
    dataset.provenance.synthetic !== true ||
    dataset.provenance.containsRealParticipantData !== false ||
    dataset.provenance.containsProductionImages !== false ||
    dataset.provenance.productionRepresentative !== false
  ) {
    throw new Error('OCR evaluation manifest provenance must remain synthetic and non-production')
  }

  assertExactKeys(dataset.structuralPolicy, POLICY_KEYS, 'manifest.structuralPolicy')
  const policy = dataset.structuralPolicy
  assertIdentifier(policy.version, 'manifest.structuralPolicy.version')
  assertIdentifier(policy.provider, 'manifest.structuralPolicy.provider')
  assertIdentifier(policy.model, 'manifest.structuralPolicy.model')
  assertIdentifier(policy.schemaVersion, 'manifest.structuralPolicy.schemaVersion')
  if (
    policy.productionApproved !== false ||
    policy.version !== POLICY_VERSION ||
    policy.provider !== SYNTHETIC_PROVIDER ||
    policy.model !== SYNTHETIC_MODEL ||
    policy.schemaVersion !== OCR_SCHEMA_VERSION
  ) {
    throw new Error('OCR evaluation policy must remain synthetic and not production approved')
  }
  assertUniqueAllowedStrings(
    policy.requiredFields,
    new Set(OCR_EVIDENCE_FIELDS),
    OCR_EVIDENCE_FIELDS.length,
    'manifest.structuralPolicy.requiredFields',
  )
  if (policy.requiredFields.length === 0) {
    throw new Error('OCR evaluation policy requires at least one structural field')
  }
  assertUniqueAllowedStrings(
    policy.acceptableImageQualityStatuses,
    new Set(OCR_IMAGE_QUALITY_STATUSES),
    OCR_IMAGE_QUALITY_STATUSES.length,
    'manifest.structuralPolicy.acceptableImageQualityStatuses',
  )
  if (policy.acceptableImageQualityStatuses.length !== 1 || policy.acceptableImageQualityStatuses[0] !== 'acceptable') {
    throw new Error('OCR evaluation policy may accept only the acceptable image-quality status')
  }

  if (!Array.isArray(dataset.cases) || dataset.cases.length === 0 || dataset.cases.length > MAX_CASES) {
    throw new Error('OCR evaluation manifest requires a bounded non-empty case collection')
  }
  const seenIds = new Set()
  dataset.cases.forEach((fixture, index) => {
    const path = `manifest.cases[${String(index)}]`
    const expectedKeys =
      isRecord(fixture) && Object.hasOwn(fixture, 'attemptedOutputFields') ? OPTIONAL_CASE_KEYS : CASE_KEYS
    assertExactKeys(fixture, expectedKeys, path)
    assertIdentifier(fixture.id, `${path}.id`)
    assertIdentifier(fixture.category, `${path}.category`)
    if (seenIds.has(fixture.id)) throw new Error('OCR evaluation manifest case IDs must be unique')
    seenIds.add(fixture.id)
    if (typeof fixture.critical !== 'boolean' || typeof fixture.injection !== 'boolean') {
      throw new Error(`${path} must declare boolean critical and injection flags`)
    }
    if (fixture.injection && !fixture.critical) throw new Error(`${path} injection cases must be critical`)
    if (!OUTCOMES.has(fixture.expectedOutcome) || !REASON_CODES.has(fixture.expectedReasonCode)) {
      throw new Error(`${path} has an invalid expected result`)
    }
    assertUniqueAllowedStrings(
      fixture.providerDisagreementFields,
      new Set(OCR_EVIDENCE_FIELDS),
      OCR_EVIDENCE_FIELDS.length,
      `${path}.providerDisagreementFields`,
    )
    const parsedEvidence = ocrExtractionEvidenceSchema.safeParse(fixture.evidence)
    if (!parsedEvidence.success) throw new Error(`${path}.evidence violates the OCR contract`)
    fixture.evidence = parsedEvidence.data

    const attempted = fixture.attemptedOutputFields
    if (fixture.injection) {
      assertUniqueAllowedStrings(
        attempted,
        ATTEMPTED_OUTPUT_FIELDS,
        ATTEMPTED_OUTPUT_FIELDS.size,
        `${path}.attemptedOutputFields`,
      )
      if (attempted.length === 0) throw new Error(`${path} injection case requires a forbidden-output probe`)
    } else if (attempted !== undefined) {
      throw new Error(`${path} non-injection case cannot declare forbidden-output probes`)
    }
  })

  if (!dataset.cases.some((fixture) => fixture.injection)) {
    throw new Error('OCR evaluation manifest requires at least one injection case')
  }
  return freezeDeep(dataset)
}
