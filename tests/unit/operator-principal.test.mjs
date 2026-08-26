import { describe, expect, test } from 'vitest'
import {
  OPERATOR_PRINCIPAL_SCHEMA_VERSION,
  OperatorPrincipalContractError,
  parseOperatorPrincipal,
} from '../../apps/api/src/modules/admin-api/operator-principal.ts'

const campaignA = '8d2a408e-9a26-4f0e-8469-08305a4fbb99'
const campaignB = '9f3b519f-aa37-4f1e-9570-19416b5fcc88'
const principal = (overrides = {}) => ({
  schemaVersion: OPERATOR_PRINCIPAL_SCHEMA_VERSION,
  principalReference: 'operator:pseudo:103',
  verified: true,
  roles: ['senior_operator', 'cs_operator'],
  campaignScope: { kind: 'campaigns', campaignIds: [campaignB, campaignA] },
  assuranceLevel: 'mfa',
  sessionReference: 'session:pseudo:103',
  authenticationContextReference: 'auth-context:pseudo:103',
  authorizationPolicyVersion: 'admin-rbac-test-fixture-v1',
  authorizationVersion: 7,
  environment: 'test',
  issuedAt: new Date('2026-08-26T00:00:00.000Z'),
  expiresAt: new Date('2026-08-26T08:00:00.000Z'),
  ...overrides,
})

describe('T103 auth-neutral operator principal', () => {
  test('accepts a verified provider-neutral principal and canonicalizes roles and campaign scope', () => {
    expect(parseOperatorPrincipal(principal())).toEqual({
      ...principal(),
      roles: ['cs_operator', 'senior_operator'],
      campaignScope: { kind: 'campaigns', campaignIds: [campaignA, campaignB] },
    })
  })

  test('accepts an explicitly global principal without binding an identity vendor', () => {
    expect(parseOperatorPrincipal(principal({ campaignScope: { kind: 'global' } }))).toMatchObject({
      campaignScope: { kind: 'global' },
      verified: true,
      authorizationVersion: 7,
    })
  })

  test.each([
    ['unverified', () => principal({ verified: false })],
    ['unknown role', () => principal({ roles: ['owner'] })],
    ['duplicate role', () => principal({ roles: ['cs_operator', 'cs_operator'] })],
    ['empty roles', () => principal({ roles: [] })],
    ['empty campaign scope', () => principal({ campaignScope: { kind: 'campaigns', campaignIds: [] } })],
    [
      'duplicate campaign',
      () => principal({ campaignScope: { kind: 'campaigns', campaignIds: [campaignA, campaignA] } }),
    ],
    ['ambiguous global scope', () => principal({ campaignScope: { kind: 'global', campaignIds: [campaignA] } })],
    ['raw email', () => principal({ principalReference: 'operator@example.com' })],
    ['raw phone', () => principal({ sessionReference: 'session:010-1234-5678' })],
    ['raw URL', () => principal({ authenticationContextReference: 'https://idp.example/private' })],
    ['invalid policy version', () => principal({ authorizationPolicyVersion: 'current' })],
    ['invalid authorization version', () => principal({ authorizationVersion: 0 })],
    ['expired at issue', () => principal({ expiresAt: new Date('2026-08-26T00:00:00.000Z') })],
    ['unknown field', () => principal({ provider: 'some-idp' })],
  ])('fails closed for %s', (_name, fixture) => {
    expect(() => parseOperatorPrincipal(fixture())).toThrow(OperatorPrincipalContractError)
  })
})
