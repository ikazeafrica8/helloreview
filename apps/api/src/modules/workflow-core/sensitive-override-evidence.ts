import type { WorkflowStateChange } from './state-model.js'

export const SENSITIVE_OVERRIDE_EVIDENCE_VERSION = 'sensitive-override-evidence-v1' as const

const CODE = /^[A-Z][A-Z0-9_]*$/
const TOKEN = /^[A-Za-z][A-Za-z0-9_:-]*$/
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9:._/-]*$/
const RAW_KOREAN_MOBILE = /(?:\+?82|0)[\s-]*10(?:[\s-]*\d){8}/
const OPERATIONS: ReadonlySet<string> = new Set(['SELECTION_MANUAL_DECISION', 'WORKFLOW_CORRECTION'])

export type SensitiveOverrideEvidence = Readonly<{
  schemaVersion: typeof SENSITIVE_OVERRIDE_EVIDENCE_VERSION
  operationCode: 'SELECTION_MANUAL_DECISION' | 'WORKFLOW_CORRECTION'
  scopeCode: string
  targetReference: string
  fieldCode: string
  priorValueCode: string
  newValueCode: string
  reasonCode: string
  actorReference: string
  correlationId: string
  recordedAt: string
}>

export type BuildSensitiveOverrideEvidenceInput = Omit<SensitiveOverrideEvidence, 'schemaVersion' | 'recordedAt'> &
  Readonly<{
    actorType: 'operator' | 'system' | 'participant' | 'provider' | 'scheduler'
    authorized: boolean
    recordedAt: Date
  }>

const assertReference = (value: string, field: string): void => {
  if (value.length > 200 || !REFERENCE.test(value) || RAW_KOREAN_MOBILE.test(value)) {
    throw new Error(`${field} must be a pseudonymous reference`)
  }
}

const assertCode = (value: string, field: string): void => {
  if (!CODE.test(value)) throw new Error(`${field} must be an uppercase reason code`)
}

const assertToken = (value: string, field: string): void => {
  if (value.length > 100 || !TOKEN.test(value)) throw new Error(`${field} must be a bounded state token`)
}

export const buildSensitiveOverrideEvidence = (
  input: BuildSensitiveOverrideEvidenceInput,
): SensitiveOverrideEvidence => {
  if (input.actorType !== 'operator' || !input.authorized) {
    throw new Error('sensitive overrides require an authorized operator')
  }
  if (!OPERATIONS.has(input.operationCode)) {
    throw new Error('sensitive override operation is unsupported')
  }
  if (Number.isNaN(input.recordedAt.getTime())) throw new Error('recordedAt must be a valid date')
  assertCode(input.scopeCode, 'scopeCode')
  assertCode(input.fieldCode, 'fieldCode')
  assertCode(input.reasonCode, 'reasonCode')
  assertReference(input.targetReference, 'targetReference')
  assertReference(input.actorReference, 'actorReference')
  assertReference(input.correlationId, 'correlationId')
  assertToken(input.priorValueCode, 'priorValueCode')
  assertToken(input.newValueCode, 'newValueCode')
  if (input.priorValueCode === input.newValueCode) throw new Error('sensitive override must change the value')

  return {
    schemaVersion: SENSITIVE_OVERRIDE_EVIDENCE_VERSION,
    operationCode: input.operationCode,
    scopeCode: input.scopeCode,
    targetReference: input.targetReference,
    fieldCode: input.fieldCode,
    priorValueCode: input.priorValueCode,
    newValueCode: input.newValueCode,
    reasonCode: input.reasonCode,
    actorReference: input.actorReference,
    correlationId: input.correlationId,
    recordedAt: input.recordedAt.toISOString(),
  }
}

const PROTECTED_PROMOTIONS: Readonly<Partial<Record<WorkflowStateChange['dimension'], ReadonlySet<string>>>> = {
  application: new Set(['application_completed', 'application_matched']),
  selection: new Set(['auto_selected', 'manually_selected']),
  secret_comment: new Set(['verified']),
  payback_consent: new Set(['agreed']),
  business_approval: new Set(['approved']),
  shipping: new Set(['address_valid', 'locked']),
  reservation: new Set(['valid']),
  guideline: new Set(['ready', 'delivery_queued', 'delivered', 'redelivery_authorized']),
  human_handoff: new Set(['returned_to_automation']),
  automation_mode: new Set(['active']),
}

/** Generic corrections may move state to safety, but cannot manufacture a protected positive state. */
export const isProtectedWorkflowPromotion = (change: WorkflowStateChange): boolean =>
  PROTECTED_PROMOTIONS[change.dimension]?.has(change.to) ?? false
