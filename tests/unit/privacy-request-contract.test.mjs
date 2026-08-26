import { describe, expect, test } from 'vitest'
import {
  PRIVACY_REQUEST_INTAKE_EVIDENCE_VERSION,
  PRIVACY_REQUEST_SCOPE_VERSION,
  PrivacyRequestContractError,
  parsePrivacyRequestIntakeEvidence,
  parsePrivacyRequestScope,
} from '../../apps/api/src/modules/privacy-ops/privacy-request-contract.ts'

const scope = (overrides = {}) => ({
  schemaVersion: PRIVACY_REQUEST_SCOPE_VERSION,
  state: 'declared',
  subjectReference: 'participant:pseudo:96',
  dataClasses: ['shipping_addresses'],
  campaignReferences: ['campaign:pseudo:b', 'campaign:pseudo:a'],
  workflowReferences: ['workflow:pseudo:96'],
  ...overrides,
})

describe('T96 privacy-request contracts', () => {
  test('accepts only versioned coded scope and canonicalizes reference order', () => {
    expect(parsePrivacyRequestScope(scope())).toEqual({
      schemaVersion: PRIVACY_REQUEST_SCOPE_VERSION,
      state: 'declared',
      subjectReference: 'participant:pseudo:96',
      dataClasses: ['shipping_addresses'],
      campaignReferences: ['campaign:pseudo:a', 'campaign:pseudo:b'],
      workflowReferences: ['workflow:pseudo:96'],
    })
  })

  test('preserves an explicitly unconfirmed scope without inventing requested data classes', () => {
    expect(
      parsePrivacyRequestScope(
        scope({ state: 'unconfirmed', dataClasses: [], campaignReferences: [], workflowReferences: [] }),
      ),
    ).toMatchObject({ state: 'unconfirmed', dataClasses: [], campaignReferences: [], workflowReferences: [] })
  })

  test.each([
    ['unknown field', scope({ freeText: 'delete everything' })],
    ['raw phone', scope({ subjectReference: '010-1234-5678' })],
    ['raw landline', scope({ subjectReference: '02-1234-5678' })],
    ['raw email', scope({ subjectReference: 'person@example.com' })],
    ['raw URL', scope({ workflowReferences: ['https://example.com/private'] })],
    ['unknown data class', scope({ dataClasses: ['message_bodies'] })],
    ['duplicate class', scope({ dataClasses: ['attachments', 'attachments'] })],
    [
      'unconfirmed values',
      scope({ state: 'unconfirmed', dataClasses: ['attachments'], campaignReferences: [], workflowReferences: [] }),
    ],
    ['empty declared scope', scope({ dataClasses: [], campaignReferences: [], workflowReferences: [] })],
  ])('rejects %s', (_name, value) => {
    expect(() => parsePrivacyRequestScope(value)).toThrow(PrivacyRequestContractError)
  })

  test('requires strict versioned intake evidence with a pseudonymous reference', () => {
    expect(
      parsePrivacyRequestIntakeEvidence({
        schemaVersion: PRIVACY_REQUEST_INTAKE_EVIDENCE_VERSION,
        channel: 'kakao',
        reference: 'message:pseudo:96',
      }),
    ).toEqual({
      schemaVersion: PRIVACY_REQUEST_INTAKE_EVIDENCE_VERSION,
      channel: 'kakao',
      reference: 'message:pseudo:96',
    })
    expect(() =>
      parsePrivacyRequestIntakeEvidence({
        schemaVersion: PRIVACY_REQUEST_INTAKE_EVIDENCE_VERSION,
        channel: 'kakao',
        reference: 'person@example.com',
      }),
    ).toThrow(PrivacyRequestContractError)
  })
})
