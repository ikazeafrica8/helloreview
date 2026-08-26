import { describe, expect, test } from 'vitest'
import {
  buildSensitiveOverrideEvidence,
  SENSITIVE_OVERRIDE_EVIDENCE_VERSION,
} from '../../apps/api/dist/modules/workflow-core/index.js'

const validInput = () => ({
  operationCode: 'WORKFLOW_CORRECTION',
  scopeCode: 'WORKFLOW',
  targetReference: 'workflow:pseudo:42',
  fieldCode: 'APPLICATION',
  priorValueCode: 'application_requested',
  newValueCode: 'not_applied',
  reasonCode: 'OPERATOR_CORRECTED_STATE',
  actorType: 'operator',
  actorReference: 'operator:pseudo:7',
  authorized: true,
  correlationId: 'cor:override:42',
  recordedAt: new Date('2026-08-26T03:00:00.000Z'),
})

describe('T93 sensitive override evidence', () => {
  test('builds complete versioned evidence without raw values', () => {
    expect(buildSensitiveOverrideEvidence(validInput())).toEqual({
      schemaVersion: SENSITIVE_OVERRIDE_EVIDENCE_VERSION,
      operationCode: 'WORKFLOW_CORRECTION',
      scopeCode: 'WORKFLOW',
      targetReference: 'workflow:pseudo:42',
      fieldCode: 'APPLICATION',
      priorValueCode: 'application_requested',
      newValueCode: 'not_applied',
      reasonCode: 'OPERATOR_CORRECTED_STATE',
      actorReference: 'operator:pseudo:7',
      correlationId: 'cor:override:42',
      recordedAt: '2026-08-26T03:00:00.000Z',
    })
  })

  test.each([
    ['unauthorized actor', { authorized: false }],
    ['wrong actor type', { actorType: 'system' }],
    ['unsupported operation', { operationCode: 'DATABASE_OVERRIDE' }],
    ['empty reason', { reasonCode: '' }],
    ['missing scope', { scopeCode: '' }],
    ['no value change', { newValueCode: 'application_requested' }],
    ['unsafe actor reference', { actorReference: '010-1234-5678' }],
    ['free-form value', { newValueCode: 'operator approved this' }],
  ])('fails closed for %s', (_name, replacement) => {
    expect(() => buildSensitiveOverrideEvidence({ ...validInput(), ...replacement })).toThrow()
  })
})
