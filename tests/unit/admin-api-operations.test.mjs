import { describe, expect, test, vi } from 'vitest'
import {
  ADMIN_RBAC_TEST_FIXTURE_POLICY,
  AdminAuthorizationDeniedError,
  AdminCommandService,
  OperationsAdminService,
  ParticipantAdminQueryService,
  maskParticipantName,
  maskParticipantPhone,
} from '../../apps/api/src/modules/admin-api/index.ts'
import { OPERATOR_PRINCIPAL_SCHEMA_VERSION } from '../../apps/api/src/modules/admin-api/operator-principal.ts'

const campaignA = '8d2a408e-9a26-4f0e-8469-08305a4fbb99'
const campaignB = '9f3b519f-aa37-4f1e-9570-19416b5fcc88'
const workflowId = '0a4c62d0-91bd-46d1-a8a5-4343a2832e25'
const applicationId = '1b5d73e1-a2ce-47e2-b9b6-5454b3943f36'
const participantId = '2c6e84f2-b3df-48f3-8ac7-6565c4a54047'
const eventId = '3d7f9503-c4e0-49f4-8bd8-7676d5b65158'
const evaluatedAt = new Date('2026-08-26T04:00:00.000Z')

const invocation = (role, scope = { kind: 'campaigns', campaignIds: [campaignA] }) => ({
  principal: {
    schemaVersion: OPERATOR_PRINCIPAL_SCHEMA_VERSION,
    principalReference: `operator:${role}:104`,
    verified: true,
    roles: [role],
    campaignScope: scope,
    assuranceLevel: 'mfa',
    sessionReference: 'session:pseudo:104',
    authenticationContextReference: 'auth-context:pseudo:104',
    authorizationPolicyVersion: ADMIN_RBAC_TEST_FIXTURE_POLICY.policyVersion,
    authorizationVersion: 3,
    environment: 'test',
    issuedAt: new Date('2026-08-26T00:00:00.000Z'),
    expiresAt: new Date('2026-08-26T08:00:00.000Z'),
  },
  policy: ADMIN_RBAC_TEST_FIXTURE_POLICY,
  context: { environment: 'test', evaluatedAt, currentAuthorizationVersion: 3 },
  requestReference: 'admin-request:pseudo:104',
  correlationId: 'cor:admin:104',
})

describe('T105 masked participant operations', () => {
  test('masks Korean names and phone numbers without leaking the source values', () => {
    expect(maskParticipantName('홍길동')).toBe('홍**')
    expect(maskParticipantPhone('+821012345678')).toBe('***-****-5678')
    expect(`${maskParticipantName('홍길동')} ${maskParticipantPhone('+821012345678')}`).not.toContain('홍길동')
    expect(maskParticipantPhone('+821012345678')).not.toContain('1234')
  })

  test('returns masked result fields and keeps raw database values out of the response', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({
        rows: [
          {
            participant_id: participantId,
            workflow_id: workflowId,
            application_id: applicationId,
            campaign_id: campaignA,
            name: '홍길동',
            phone_normalized: '+821012345678',
            application_status: 'received',
            blogger_level: 2,
            blog_daily_visitors: 1300,
            blogger_region: '부산',
            created_at: evaluatedAt,
          },
        ],
      }),
    }
    const service = new ParticipantAdminQueryService(pool)
    const page = await service.search(invocation('cs_operator'), { campaignId: campaignA, query: '홍길' })
    expect(page.items[0]).toMatchObject({ maskedName: '홍**', maskedPhone: '***-****-5678', bloggerLevel: 2 })
    expect(JSON.stringify(page)).not.toContain('홍길동')
    expect(JSON.stringify(page)).not.toContain('+821012345678')
  })
})

describe('T106 object-derived command authorization', () => {
  test('rejects a task outside the principal campaign before invoking the mutation service', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ campaign_id: campaignB, workflow_id: workflowId }] }) }
    const human = { assign: vi.fn() }
    const service = new AdminCommandService(pool, human, {}, {})
    await expect(
      service.assignHumanTask(invocation('cs_operator'), {
        taskId: eventId,
        expectedWorkflowVersion: 4,
        reasonCode: 'TAKE_OWNERSHIP',
        occurredAt: evaluatedAt,
      }),
    ).rejects.toBeInstanceOf(AdminAuthorizationDeniedError)
    expect(human.assign).not.toHaveBeenCalled()
  })
})

describe('T108 idempotent retry receipt', () => {
  test('replays the same operation reference without mutating the failed job again', async () => {
    let receipt
    let updateCount = 0
    const client = {
      query: vi.fn(async (sql, values = []) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] }
        if (sql.includes('FROM admin_retry_operations')) return { rows: receipt ? [receipt] : [] }
        if (sql.includes('FROM event_inbox')) return { rows: [{ id: eventId, status: 'failed' }] }
        if (sql.includes('UPDATE event_inbox')) {
          updateCount += 1
          return { rows: [] }
        }
        if (sql.includes('INSERT INTO admin_retry_operations')) {
          receipt = { target_event_id: eventId, input_digest: values[2] }
          return { rows: [] }
        }
        throw new Error(`unexpected SQL: ${sql}`)
      }),
      release: vi.fn(),
    }
    const pool = { connect: vi.fn().mockResolvedValue(client) }
    const service = new OperationsAdminService(pool, {})
    const admin = invocation('system_administrator', { kind: 'global' })
    const command = {
      eventId,
      operationReference: 'retry:event:104',
      expectedStatus: 'failed',
      reasonCode: 'OPERATOR_RETRY_APPROVED',
      occurredAt: evaluatedAt,
    }
    expect(await service.retryInboundEvent(admin, command)).toEqual({
      eventId,
      outcome: 'requeued',
      deduplicated: false,
    })
    expect(await service.retryInboundEvent(admin, command)).toEqual({
      eventId,
      outcome: 'requeued',
      deduplicated: true,
    })
    expect(updateCount).toBe(1)
  })
})
