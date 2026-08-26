import { describe, expect, test } from 'vitest'
import {
  ADMIN_ACTIONS,
  ADMIN_AUTHORIZATION_POLICY_SCHEMA_VERSION,
  ADMIN_AUTHORIZATION_REQUEST_SCHEMA_VERSION,
  ADMIN_RBAC_TEST_FIXTURE_POLICY,
  AdminAuthorizationContractError,
  AdminAuthorizationDeniedError,
  assertAdminAuthorized,
  evaluateAdminAuthorization,
  parseAdminAuthorizationPolicy,
  parseAdminAuthorizationRequest,
} from '../../apps/api/src/modules/admin-api/index.ts'
import { OPERATOR_PRINCIPAL_SCHEMA_VERSION } from '../../apps/api/src/modules/admin-api/operator-principal.ts'

const campaignA = '8d2a408e-9a26-4f0e-8469-08305a4fbb99'
const campaignB = '9f3b519f-aa37-4f1e-9570-19416b5fcc88'
const evaluatedAt = new Date('2026-08-26T04:00:00.000Z')
const principal = (overrides = {}) => ({
  schemaVersion: OPERATOR_PRINCIPAL_SCHEMA_VERSION,
  principalReference: 'operator:pseudo:104',
  verified: true,
  roles: ['cs_operator'],
  campaignScope: { kind: 'campaigns', campaignIds: [campaignA] },
  assuranceLevel: 'mfa',
  sessionReference: 'session:pseudo:104',
  authenticationContextReference: 'auth-context:pseudo:104',
  authorizationPolicyVersion: ADMIN_RBAC_TEST_FIXTURE_POLICY.policyVersion,
  authorizationVersion: 3,
  environment: 'test',
  issuedAt: new Date('2026-08-26T00:00:00.000Z'),
  expiresAt: new Date('2026-08-26T08:00:00.000Z'),
  ...overrides,
})
const request = (overrides = {}) => ({
  schemaVersion: ADMIN_AUTHORIZATION_REQUEST_SCHEMA_VERSION,
  requestReference: 'admin-request:pseudo:104',
  correlationId: 'cor:admin:104',
  action: 'human_tasks.assign',
  targetCampaignId: campaignA,
  ...overrides,
})
const context = (overrides = {}) => ({
  environment: 'test',
  evaluatedAt,
  currentAuthorizationVersion: 3,
  ...overrides,
})
const evaluate = (overrides = {}) =>
  evaluateAdminAuthorization({
    principal: overrides.principal ?? principal(),
    request: overrides.request ?? request(),
    policy: overrides.policy ?? ADMIN_RBAC_TEST_FIXTURE_POLICY,
    context: overrides.context ?? context(),
  })

describe('T104 complete deny-by-default RBAC contract', () => {
  test('maps every known administrative command and sensitive read exactly once', () => {
    const parsed = parseAdminAuthorizationPolicy(ADMIN_RBAC_TEST_FIXTURE_POLICY)
    expect(parsed.entries.map((entry) => entry.action)).toEqual(ADMIN_ACTIONS)
    expect(new Set(parsed.entries.map((entry) => entry.action)).size).toBe(ADMIN_ACTIONS.length)
  })

  test('rejects unknown actions, incomplete matrices, duplicate actions, and extra fields', () => {
    expect(() => parseAdminAuthorizationRequest(request({ action: 'database.drop' }))).toThrow(
      AdminAuthorizationContractError,
    )
    expect(() =>
      parseAdminAuthorizationPolicy({
        ...ADMIN_RBAC_TEST_FIXTURE_POLICY,
        entries: ADMIN_RBAC_TEST_FIXTURE_POLICY.entries.slice(1),
      }),
    ).toThrow(AdminAuthorizationContractError)
    expect(() =>
      parseAdminAuthorizationPolicy({
        ...ADMIN_RBAC_TEST_FIXTURE_POLICY,
        entries: ADMIN_RBAC_TEST_FIXTURE_POLICY.entries.map((entry, index) =>
          index === 0 ? ADMIN_RBAC_TEST_FIXTURE_POLICY.entries[1] : entry,
        ),
      }),
    ).toThrow(AdminAuthorizationContractError)
    expect(() => parseAdminAuthorizationRequest({ ...request(), reason: 'extra' })).toThrow(
      AdminAuthorizationContractError,
    )
  })

  test('keeps the deterministic matrix test-only and requires dual references for an approved policy', () => {
    expect(() =>
      parseAdminAuthorizationPolicy({
        ...ADMIN_RBAC_TEST_FIXTURE_POLICY,
        environment: 'production',
      }),
    ).toThrow(AdminAuthorizationContractError)
    expect(() =>
      parseAdminAuthorizationPolicy({
        ...ADMIN_RBAC_TEST_FIXTURE_POLICY,
        status: 'approved',
        environment: 'production',
      }),
    ).toThrow(AdminAuthorizationContractError)
    expect(
      parseAdminAuthorizationPolicy({
        ...ADMIN_RBAC_TEST_FIXTURE_POLICY,
        status: 'approved',
        environment: 'production',
        companyApprovalReference: 'company-approval:pseudo:104',
        securityApprovalReference: 'security-approval:pseudo:104',
      }),
    ).toMatchObject({ status: 'approved', environment: 'production' })
  })
})

describe('T104 authorization enforcement', () => {
  test('allows a mapped role only inside its campaign scope', () => {
    expect(evaluate()).toEqual({
      allowed: true,
      reasonCode: 'ADMIN_AUTHORIZED',
      action: 'human_tasks.assign',
      policyVersion: 'admin-rbac-test-fixture-v1',
      matchedRole: 'cs_operator',
      principalReference: 'operator:pseudo:104',
      sessionReference: 'session:pseudo:104',
      correlationId: 'cor:admin:104',
      authorizationVersion: 3,
      evaluatedAt,
    })
    expect(evaluate({ request: request({ targetCampaignId: campaignB }) })).toMatchObject({
      allowed: false,
      reasonCode: 'ADMIN_CAMPAIGN_SCOPE_DENIED',
    })
    expect(evaluate({ request: request({ targetCampaignId: null }) })).toMatchObject({
      allowed: false,
      reasonCode: 'ADMIN_CAMPAIGN_SCOPE_REQUIRED',
    })
  })

  test('requires the mapped role, assurance level, and global scope independently', () => {
    expect(evaluate({ principal: principal({ roles: ['support_engineer'] }) })).toMatchObject({
      allowed: false,
      reasonCode: 'ADMIN_ROLE_NOT_ALLOWED',
    })
    expect(
      evaluate({
        principal: principal({ roles: ['senior_operator'], assuranceLevel: 'single_factor' }),
        request: request({ action: 'overrides.approve' }),
      }),
    ).toMatchObject({ allowed: false, reasonCode: 'ADMIN_ASSURANCE_INSUFFICIENT' })
    expect(
      evaluate({
        principal: principal({ roles: ['privacy_reviewer'] }),
        request: request({ action: 'privacy_requests.read', targetCampaignId: null }),
      }),
    ).toMatchObject({ allowed: false, reasonCode: 'ADMIN_GLOBAL_SCOPE_REQUIRED' })
  })

  test('allows global principals to satisfy campaign and global actions without widening role permission', () => {
    expect(evaluate({ principal: principal({ campaignScope: { kind: 'global' } }) })).toMatchObject({ allowed: true })
    expect(
      evaluate({
        principal: principal({ roles: ['privacy_reviewer'], campaignScope: { kind: 'global' } }),
        request: request({ action: 'privacy_requests.read', targetCampaignId: null }),
      }),
    ).toMatchObject({ allowed: true, matchedRole: 'privacy_reviewer' })
  })

  test.each([
    [
      'stale authorization snapshot',
      { context: context({ currentAuthorizationVersion: 4 }) },
      'ADMIN_AUTHORIZATION_VERSION_STALE',
    ],
    [
      'stale policy',
      { principal: principal({ authorizationPolicyVersion: 'admin-rbac-test-fixture-v2' }) },
      'ADMIN_POLICY_VERSION_STALE',
    ],
    [
      'not yet valid',
      { context: context({ evaluatedAt: new Date('2026-08-25T23:59:59.999Z') }) },
      'ADMIN_PRINCIPAL_NOT_YET_VALID',
    ],
    ['expired', { context: context({ evaluatedAt: new Date('2026-08-26T08:00:00.000Z') }) }, 'ADMIN_PRINCIPAL_EXPIRED'],
    [
      'principal environment mismatch',
      { context: context({ environment: 'production' }) },
      'ADMIN_PRINCIPAL_ENVIRONMENT_MISMATCH',
    ],
  ])('denies %s', (_name, overrides, reasonCode) => {
    expect(evaluate(overrides)).toMatchObject({ allowed: false, reasonCode })
  })

  test('production rejects the test fixture before considering its permissions', () => {
    expect(
      evaluate({
        principal: principal({ environment: 'production' }),
        context: context({ environment: 'production' }),
      }),
    ).toMatchObject({ allowed: false, reasonCode: 'ADMIN_POLICY_NOT_APPROVED' })
  })

  test('accepts a separately approved production policy with matching principal and snapshot', () => {
    const policy = {
      ...ADMIN_RBAC_TEST_FIXTURE_POLICY,
      status: 'approved',
      environment: 'production',
      companyApprovalReference: 'company-approval:pseudo:104',
      securityApprovalReference: 'security-approval:pseudo:104',
    }
    expect(
      evaluate({
        policy,
        principal: principal({ environment: 'production' }),
        context: context({ environment: 'production' }),
      }),
    ).toMatchObject({ allowed: true, reasonCode: 'ADMIN_AUTHORIZED' })
  })

  test('support diagnostics access does not imply retry authority', () => {
    const support = principal({ roles: ['support_engineer'], campaignScope: { kind: 'global' } })
    expect(
      evaluate({
        principal: support,
        request: request({ action: 'integrations.health.read', targetCampaignId: null }),
      }),
    ).toMatchObject({ allowed: true, matchedRole: 'support_engineer' })
    expect(
      evaluate({
        principal: support,
        request: request({ action: 'failed_jobs.retry', targetCampaignId: null }),
      }),
    ).toMatchObject({ allowed: false, reasonCode: 'ADMIN_ROLE_NOT_ALLOWED' })
  })

  test('the enforcement helper throws on denial and returns the allow evidence on success', () => {
    expect(() =>
      assertAdminAuthorized({
        principal: principal(),
        request: request({ targetCampaignId: campaignB }),
        policy: ADMIN_RBAC_TEST_FIXTURE_POLICY,
        context: context(),
      }),
    ).toThrow(AdminAuthorizationDeniedError)
    expect(
      assertAdminAuthorized({
        principal: principal(),
        request: request(),
        policy: ADMIN_RBAC_TEST_FIXTURE_POLICY,
        context: context(),
      }),
    ).toMatchObject({ allowed: true, reasonCode: 'ADMIN_AUTHORIZED' })
  })

  test('invalid context and raw approval references fail closed at the contract boundary', () => {
    expect(() => evaluate({ context: { ...context(), evaluatedAt: 'now' } })).toThrow(AdminAuthorizationContractError)
    expect(() =>
      parseAdminAuthorizationPolicy({
        schemaVersion: ADMIN_AUTHORIZATION_POLICY_SCHEMA_VERSION,
        ...ADMIN_RBAC_TEST_FIXTURE_POLICY,
        status: 'approved',
        environment: 'production',
        companyApprovalReference: '010-1234-5678',
        securityApprovalReference: 'security:pseudo:104',
      }),
    ).toThrow(AdminAuthorizationContractError)
    expect(() => parseAdminAuthorizationRequest(request({ correlationId: 'person@example.com' }))).toThrow(
      AdminAuthorizationContractError,
    )
  })
})
