import { describe, expect, test, vi } from 'vitest'
import {
  ADMIN_RBAC_TEST_FIXTURE_POLICY,
  AdminAuthorizationDeniedError,
  DeterministicSensitiveAccessPolicyProvider,
  ProductionLockedSensitiveAccessPolicyProvider,
  SENSITIVE_ACCESS_OPERATIONS,
  SENSITIVE_ACCESS_TEST_FIXTURE_POLICY,
  SensitiveAccessAdminService,
  SensitiveAccessPolicyError,
  assertSensitiveAccessAllowed,
  parseSensitiveAccessPolicy,
} from '../../apps/api/src/modules/admin-api/index.ts'
import { OPERATOR_PRINCIPAL_SCHEMA_VERSION } from '../../apps/api/src/modules/admin-api/operator-principal.ts'

const workflowId = '0a4c62d0-91bd-46d1-a8a5-4343a2832e25'
const participantId = '2c6e84f2-b3df-48f3-8ac7-6565c4a54047'
const occurredAt = new Date('2026-08-26T04:00:00.000Z')

const invocation = (overrides = {}) => ({
  principal: {
    schemaVersion: OPERATOR_PRINCIPAL_SCHEMA_VERSION,
    principalReference: 'operator:privacy:109',
    verified: true,
    roles: ['privacy_reviewer'],
    campaignScope: { kind: 'global' },
    assuranceLevel: 'phishing_resistant',
    sessionReference: 'session:pseudo:109',
    authenticationContextReference: 'auth-context:pseudo:109',
    authorizationPolicyVersion: ADMIN_RBAC_TEST_FIXTURE_POLICY.policyVersion,
    authorizationVersion: 4,
    environment: 'test',
    issuedAt: new Date('2026-08-26T00:00:00.000Z'),
    expiresAt: new Date('2026-08-26T08:00:00.000Z'),
    ...overrides.principal,
  },
  policy: ADMIN_RBAC_TEST_FIXTURE_POLICY,
  context: { environment: 'test', evaluatedAt: occurredAt, currentAuthorizationVersion: 4 },
  requestReference: 'admin-request:pseudo:109',
  correlationId: 'cor:admin:109',
  ...overrides.invocation,
})

const revealCommand = (overrides = {}) => ({
  workflowId,
  participantId,
  reasonCode: 'FULFILLMENT',
  occurredAt,
  sensitiveAccessPolicyVersion: SENSITIVE_ACCESS_TEST_FIXTURE_POLICY.policyVersion,
  ...overrides,
})

describe('T109 strict sensitive-access policy', () => {
  test('covers each known reveal/export operation exactly once', () => {
    const policy = parseSensitiveAccessPolicy(SENSITIVE_ACCESS_TEST_FIXTURE_POLICY)
    expect(policy.entries.map((entry) => entry.operation)).toEqual(SENSITIVE_ACCESS_OPERATIONS)
  })

  test('rejects test fixtures in production, missing approvals, unknown fields, reasons, and record excess', () => {
    expect(() =>
      parseSensitiveAccessPolicy({ ...SENSITIVE_ACCESS_TEST_FIXTURE_POLICY, environment: 'production' }),
    ).toThrow(SensitiveAccessPolicyError)
    expect(() =>
      parseSensitiveAccessPolicy({
        ...SENSITIVE_ACCESS_TEST_FIXTURE_POLICY,
        status: 'approved',
        environment: 'production',
      }),
    ).toThrow(SensitiveAccessPolicyError)
    expect(() => parseSensitiveAccessPolicy({ ...SENSITIVE_ACCESS_TEST_FIXTURE_POLICY, extra: true })).toThrow(
      SensitiveAccessPolicyError,
    )
    expect(() =>
      assertSensitiveAccessAllowed({
        policy: SENSITIVE_ACCESS_TEST_FIXTURE_POLICY,
        environment: 'test',
        operation: 'shipping_address.reveal',
        reasonCode: 'CURIOSITY',
        requestedRecords: 1,
      }),
    ).toThrowError(expect.objectContaining({ reasonCode: 'SENSITIVE_ACCESS_REASON_NOT_ALLOWED' }))
    expect(() =>
      assertSensitiveAccessAllowed({
        policy: SENSITIVE_ACCESS_TEST_FIXTURE_POLICY,
        environment: 'test',
        operation: 'participant_data.export',
        reasonCode: 'LEGAL_RESPONSE',
        requestedRecords: 26,
      }),
    ).toThrowError(expect.objectContaining({ reasonCode: 'SENSITIVE_ACCESS_RECORD_LIMIT_EXCEEDED' }))
  })
})

describe('T109 authorized reveal and fail-closed export commands', () => {
  const setup = (
    policyProvider = new DeterministicSensitiveAccessPolicyProvider(SENSITIVE_ACCESS_TEST_FIXTURE_POLICY),
  ) => {
    const shipping = {
      reveal: vi.fn().mockResolvedValue({
        recipientName: '홍길동',
        phone: '+821012345678',
        postalCode: '06236',
        addressLine1: '서울시 강남구',
        addressLine2: null,
        deliveryNote: null,
      }),
    }
    const auditEntries = []
    const audit = {
      record: vi.fn(async (entry) => {
        auditEntries.push(entry)
      }),
    }
    return {
      service: new SensitiveAccessAdminService(shipping, audit, policyProvider),
      shipping,
      audit,
      auditEntries,
    }
  }

  test('passes dual authorization evidence to the one-record reveal and leaves success auditing atomic', async () => {
    const { service, shipping, audit } = setup()
    const result = await service.revealShippingAddress(invocation(), revealCommand())
    expect(result.addressLine1).toBe('서울시 강남구')
    expect(shipping.reveal).toHaveBeenCalledWith(
      expect.objectContaining({
        authorized: true,
        actorType: 'operator',
        reasonCode: 'FULFILLMENT',
        authorizationEvidence: expect.objectContaining({
          action: 'sensitive_values.reveal',
          sensitiveAccessPolicyVersion: SENSITIVE_ACCESS_TEST_FIXTURE_POLICY.policyVersion,
        }),
      }),
    )
    expect(audit.record).not.toHaveBeenCalled()
  })

  test('denies an unauthorized role before reveal and immutably audits the rejected attempt', async () => {
    const { service, shipping, auditEntries } = setup()
    await expect(
      service.revealShippingAddress(
        invocation({ principal: { roles: ['cs_operator'], assuranceLevel: 'phishing_resistant' } }),
        revealCommand(),
      ),
    ).rejects.toBeInstanceOf(AdminAuthorizationDeniedError)
    expect(shipping.reveal).not.toHaveBeenCalled()
    expect(auditEntries[0]).toMatchObject({
      action: 'SENSITIVE_FIELD_REVEALED',
      result: 'rejected',
      reason: 'ADMIN_ROLE_NOT_ALLOWED',
    })
  })

  test('authorizes and audits an export request but performs no real export', async () => {
    const { service, shipping, auditEntries } = setup()
    const result = await service.requestSensitiveExport(invocation(), {
      operationReference: 'export:pseudo:109',
      reasonCode: 'PRIVACY_REQUEST_FULFILLMENT',
      requestedRecordCount: 10,
      occurredAt,
      sensitiveAccessPolicyVersion: SENSITIVE_ACCESS_TEST_FIXTURE_POLICY.policyVersion,
    })
    expect(result).toEqual({
      operationReference: 'export:pseudo:109',
      outcome: 'unavailable_safe_fallback',
      realExportPerformed: false,
      reasonCode: 'SENSITIVE_EXPORT_UNAVAILABLE_SAFE_FALLBACK',
    })
    expect(shipping.reveal).not.toHaveBeenCalled()
    expect(auditEntries[0]).toMatchObject({
      action: 'SENSITIVE_DATA_EXPORT_REQUESTED',
      result: 'rejected',
      reason: 'SENSITIVE_EXPORT_UNAVAILABLE_SAFE_FALLBACK',
    })
    expect(JSON.stringify(auditEntries)).not.toContain('홍길동')
    expect(JSON.stringify(auditEntries)).not.toContain('+821012345678')
  })

  test('resolves only the trusted current policy and rejects stale or locked policy references', async () => {
    const stale = setup()
    await expect(
      stale.service.revealShippingAddress(
        invocation(),
        revealCommand({
          sensitiveAccessPolicyVersion: 'sensitive-access-test-fixture-v999',
          sensitiveAccessPolicy: {
            status: 'approved',
            entries: [{ operation: 'shipping_address.reveal', maximumRecords: 9999 }],
          },
        }),
      ),
    ).rejects.toMatchObject({ reasonCode: 'SENSITIVE_ACCESS_POLICY_VERSION_STALE' })
    expect(stale.shipping.reveal).not.toHaveBeenCalled()
    expect(stale.auditEntries[0]).toMatchObject({
      result: 'rejected',
      reason: 'SENSITIVE_ACCESS_POLICY_VERSION_STALE',
    })

    const locked = setup(new ProductionLockedSensitiveAccessPolicyProvider())
    await expect(locked.service.revealShippingAddress(invocation(), revealCommand())).rejects.toMatchObject({
      reasonCode: 'SENSITIVE_ACCESS_POLICY_PROVIDER_LOCKED',
    })
    expect(locked.shipping.reveal).not.toHaveBeenCalled()
  })
})

describe('T133 rejected sensitive-command audit evidence', () => {
  const setup = () => {
    const shipping = { reveal: vi.fn() }
    const auditEntries = []
    const audit = {
      record: vi.fn(async (entry) => {
        auditEntries.push(entry)
      }),
    }
    return {
      service: new SensitiveAccessAdminService(
        shipping,
        audit,
        new DeterministicSensitiveAccessPolicyProvider(SENSITIVE_ACCESS_TEST_FIXTURE_POLICY),
      ),
      shipping,
      auditEntries,
    }
  }

  test.each([
    ['a raw Korean mobile number', '01012345678'],
    ['an email address', 'operator@example.com'],
    ['a URL', 'https://example.com/operator/9'],
  ])('never writes %s from an unverified principal into the rejection audit', async (_label, unsafeReference) => {
    const { service, shipping, auditEntries } = setup()
    await expect(
      service.revealShippingAddress(
        invocation({ principal: { principalReference: unsafeReference } }),
        revealCommand(),
      ),
    ).rejects.toBeTruthy()
    expect(shipping.reveal).not.toHaveBeenCalled()
    expect(auditEntries).toHaveLength(1)
    expect(auditEntries[0].actorId).toBe('operator:unverified-principal')
    expect(JSON.stringify(auditEntries)).not.toContain(unsafeReference)
  })

  test('withholds an unverified authorization policy version instead of trusting the request', async () => {
    const { service, auditEntries } = setup()
    await expect(
      service.revealShippingAddress(
        invocation({
          invocation: { policy: { ...ADMIN_RBAC_TEST_FIXTURE_POLICY, policyVersion: 'NOT A POLICY VERSION' } },
        }),
        revealCommand(),
      ),
    ).rejects.toBeTruthy()
    expect(auditEntries[0].detail.authorizationPolicyVersion).toBeNull()
    expect(JSON.stringify(auditEntries)).not.toContain('NOT A POLICY VERSION')
  })

  test('records the validated decision policy version when authorization was evaluated and denied', async () => {
    const { service, auditEntries } = setup()
    await expect(
      service.revealShippingAddress(invocation({ principal: { roles: ['cs_operator'] } }), revealCommand()),
    ).rejects.toBeInstanceOf(AdminAuthorizationDeniedError)
    expect(auditEntries[0]).toMatchObject({
      actorId: 'operator:privacy:109',
      reason: 'ADMIN_ROLE_NOT_ALLOWED',
      detail: {
        operation: 'shipping_address.reveal',
        authorizationPolicyVersion: ADMIN_RBAC_TEST_FIXTURE_POLICY.policyVersion,
      },
    })
  })

  test('replaces an unsafe rejection target reference with a safe placeholder', async () => {
    const { service, auditEntries } = setup()
    await expect(
      service.revealShippingAddress(
        invocation({ principal: { roles: ['cs_operator'] } }),
        revealCommand({ workflowId: 'https://example.com/workflow/1' }),
      ),
    ).rejects.toBeInstanceOf(AdminAuthorizationDeniedError)
    expect(auditEntries[0].targetId).toBe('unverified-target')
    expect(JSON.stringify(auditEntries)).not.toContain('https://example.com/workflow/1')
  })

  test('audits the export safe fallback with the validated authorization policy version', async () => {
    const { service, auditEntries } = setup()
    await service.requestSensitiveExport(invocation(), {
      operationReference: 'export:pseudo:133',
      reasonCode: 'LEGAL_RESPONSE',
      requestedRecordCount: 3,
      occurredAt,
      sensitiveAccessPolicyVersion: SENSITIVE_ACCESS_TEST_FIXTURE_POLICY.policyVersion,
    })
    expect(auditEntries[0].detail).toMatchObject({
      authorizationPolicyVersion: ADMIN_RBAC_TEST_FIXTURE_POLICY.policyVersion,
      sensitiveAccessPolicyVersion: SENSITIVE_ACCESS_TEST_FIXTURE_POLICY.policyVersion,
    })
  })
})
