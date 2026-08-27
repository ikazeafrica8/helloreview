import { createHash } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, test } from 'vitest'
import { applyMigrations } from '../../packages/db/dist/index.js'
import { withPostgres } from '../../packages/testing/dist/index.js'
import {
  ADMIN_RBAC_TEST_FIXTURE_POLICY,
  AdminAuthorizationDeniedError,
  DeterministicSensitiveAccessPolicyProvider,
  OperationsAdminService,
  ParticipantAdminQueryService,
  SENSITIVE_ACCESS_TEST_FIXTURE_POLICY,
  SensitiveAccessAdminService,
} from '../../apps/api/dist/modules/admin-api/index.js'
import { OPERATOR_PRINCIPAL_SCHEMA_VERSION } from '../../apps/api/dist/modules/admin-api/operator-principal.js'
import { AuditLogService } from '../../apps/api/dist/modules/audit-log/index.js'
import {
  ShippingService,
  addressFingerprint,
  encryptShippingAddress,
  maskShippingAddress,
} from '../../apps/api/dist/modules/shipping/index.js'

const occurredAt = new Date('2026-08-26T04:00:00.000Z')
const encryptionKey = Buffer.alloc(32, 19)
const address = {
  recipientName: '홍길동',
  phone: '+821012345678',
  postalCode: '06236',
  addressLine1: '서울시 강남구 테헤란로 1',
  addressLine2: '5층',
  deliveryNote: '',
}

const invocation = ({ role, scope, assuranceLevel = 'mfa', authorizationVersion = 4 }) => ({
  principal: {
    schemaVersion: OPERATOR_PRINCIPAL_SCHEMA_VERSION,
    principalReference: `operator:${role}:110`,
    verified: true,
    roles: [role],
    campaignScope: scope,
    assuranceLevel,
    sessionReference: `session:${role}:110`,
    authenticationContextReference: `auth-context:${role}:110`,
    authorizationPolicyVersion: ADMIN_RBAC_TEST_FIXTURE_POLICY.policyVersion,
    authorizationVersion,
    environment: 'test',
    issuedAt: new Date('2026-08-26T00:00:00.000Z'),
    expiresAt: new Date('2026-08-26T08:00:00.000Z'),
  },
  policy: ADMIN_RBAC_TEST_FIXTURE_POLICY,
  context: { environment: 'test', evaluatedAt: occurredAt, currentAuthorizationVersion: 4 },
  requestReference: `admin-request:${role}:110`,
  correlationId: `cor:${role}:110`,
})

const seed = async (pool) => {
  const campaignA = (
    await pool.query(
      `INSERT INTO campaigns (code, name, type, visit_method, status, starts_at, ends_at)
       VALUES ('admin-e2e-a','Admin E2E A','shipping','not_applicable','active',$1,$2) RETURNING id`,
      [new Date('2026-08-25T00:00:00Z'), new Date('2026-09-25T00:00:00Z')],
    )
  ).rows[0].id
  const campaignB = (
    await pool.query(
      `INSERT INTO campaigns (code, name, type, visit_method, status, starts_at, ends_at)
       VALUES ('admin-e2e-b','Admin E2E B','shipping','not_applicable','active',$1,$2) RETURNING id`,
      [new Date('2026-08-25T00:00:00Z'), new Date('2026-09-25T00:00:00Z')],
    )
  ).rows[0].id
  const participantId = (
    await pool.query(`INSERT INTO participants (name, phone_normalized) VALUES ('홍길동','+821012345678') RETURNING id`)
  ).rows[0].id
  const applicationId = (
    await pool.query(
      `INSERT INTO applications (
         source_system, source_application_id, campaign_id, status, source_status,
         applicant_name, phone_normalized, blogger_level, blog_daily_visitors, blogger_region,
         source_version, submitted_at, last_source_event_id, last_source_occurred_at, last_synchronized_at
       ) VALUES ('test','admin-e2e-app',$1,'received','received','홍길동','+821012345678',1,1500,'서울',
                 1,$2,'admin-e2e-event',$2,$2) RETURNING id`,
      [campaignA, occurredAt],
    )
  ).rows[0].id
  const workflowId = (
    await pool.query(
      `INSERT INTO workflow_instances (
         participant_id, application_id, campaign_id, campaign_type, visit_method,
         application_state, selection_state, shipping_state,
         application_origin_at, selection_origin_at, secret_comment_origin_at,
         payback_consent_origin_at, business_approval_origin_at, shipping_origin_at,
         reservation_origin_at, guideline_origin_at, human_handoff_origin_at, automation_mode_origin_at
       ) VALUES ($1,$2,$3,'shipping','not_applicable','application_matched','manually_selected','address_valid',
                 $4,$4,$4,$4,$4,$4,$4,$4,$4,$4) RETURNING id`,
      [participantId, applicationId, campaignA, occurredAt],
    )
  ).rows[0].id
  const addressId = (
    await pool.query(
      `INSERT INTO shipping_addresses (
         workflow_id, participant_id, campaign_id, version, encrypted_payload, address_fingerprint,
         masked_summary, validation_state, validation_evidence, policy_version, change_source,
         actor_reference, created_at
       ) VALUES ($1,$2,$3,1,$4,$5,$6,'valid','[]'::jsonb,'shipping-policy-v1','participant_form','participant',$7)
       RETURNING id`,
      [
        workflowId,
        participantId,
        campaignA,
        encryptShippingAddress(encryptionKey, address),
        addressFingerprint(encryptionKey, address),
        maskShippingAddress(address),
        occurredAt,
      ],
    )
  ).rows[0].id
  await pool.query(`INSERT INTO shipping_address_heads (workflow_id, address_id, updated_at) VALUES ($1,$2,$3)`, [
    workflowId,
    addressId,
    occurredAt,
  ])
  const failedEventId = (
    await pool.query(
      `INSERT INTO event_inbox (
         source, external_event_id, event_type, payload_hash, payload, occurred_at, status,
         attempt_count, last_error_reason, correlation_id
       ) VALUES ('test','admin-e2e-retry','application.created',$1,'{}'::jsonb,$2,'failed',2,'TRANSIENT_FAILURE',
                 'cor:failed:110') RETURNING id`,
      [createHash('sha256').update('{}').digest('hex'), occurredAt],
    )
  ).rows[0].id
  return { campaignA, campaignB, participantId, workflowId, addressId, failedEventId }
}

describe('T110 administrative authorization end to end', () => {
  test('proves scopes, stale state, masked defaults, audited reveal, and idempotent retry on PostgreSQL', async () => {
    await withPostgres(async ({ url }) => {
      await applyMigrations(url)
      const pool = new Pool({ connectionString: url })
      try {
        const ids = await seed(pool)
        const participantQueries = new ParticipantAdminQueryService(pool)
        const scopedCs = invocation({
          role: 'cs_operator',
          scope: { kind: 'campaigns', campaignIds: [ids.campaignA] },
          assuranceLevel: 'single_factor',
        })
        const page = await participantQueries.search(scopedCs, { campaignId: ids.campaignA, query: '홍길' })
        expect(page.items).toHaveLength(1)
        expect(page.items[0]).toMatchObject({
          participantId: ids.participantId,
          applicationStatus: 'received',
          maskedName: '홍**',
          maskedPhone: '***-****-5678',
        })
        expect(JSON.stringify(page)).not.toContain('홍길동')
        expect(JSON.stringify(page)).not.toContain('+821012345678')

        await expect(
          participantQueries.search(
            invocation({
              role: 'cs_operator',
              scope: { kind: 'campaigns', campaignIds: [ids.campaignB] },
              assuranceLevel: 'single_factor',
            }),
            { campaignId: ids.campaignA, query: '홍길' },
          ),
        ).rejects.toBeInstanceOf(AdminAuthorizationDeniedError)
        await expect(
          participantQueries.search(
            invocation({
              role: 'cs_operator',
              scope: { kind: 'campaigns', campaignIds: [ids.campaignA] },
              assuranceLevel: 'single_factor',
              authorizationVersion: 3,
            }),
            { campaignId: ids.campaignA, query: '홍길' },
          ),
        ).rejects.toMatchObject({ decision: { reasonCode: 'ADMIN_AUTHORIZATION_VERSION_STALE' } })

        const logger = { debug() {}, info() {}, warn() {}, error() {}, fatal() {} }
        const audit = new AuditLogService(pool, logger)
        const shipping = new ShippingService(pool, encryptionKey, {})
        const sensitive = new SensitiveAccessAdminService(
          shipping,
          audit,
          new DeterministicSensitiveAccessPolicyProvider(SENSITIVE_ACCESS_TEST_FIXTURE_POLICY),
        )
        await expect(
          sensitive.revealShippingAddress(scopedCs, {
            workflowId: ids.workflowId,
            participantId: ids.participantId,
            reasonCode: 'FULFILLMENT',
            occurredAt,
            sensitiveAccessPolicyVersion: SENSITIVE_ACCESS_TEST_FIXTURE_POLICY.policyVersion,
          }),
        ).rejects.toBeInstanceOf(AdminAuthorizationDeniedError)
        const revealed = await sensitive.revealShippingAddress(
          invocation({
            role: 'privacy_reviewer',
            scope: { kind: 'global' },
            assuranceLevel: 'phishing_resistant',
          }),
          {
            workflowId: ids.workflowId,
            participantId: ids.participantId,
            reasonCode: 'FULFILLMENT',
            occurredAt,
            sensitiveAccessPolicyVersion: SENSITIVE_ACCESS_TEST_FIXTURE_POLICY.policyVersion,
          },
        )
        expect(revealed).toEqual(address)
        const audits = await pool.query(
          `SELECT result::text, reason, protected_action, target_id FROM audit_logs
            WHERE action = 'SENSITIVE_FIELD_REVEALED' ORDER BY id`,
        )
        expect(audits.rows).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ result: 'rejected', reason: 'ADMIN_ROLE_NOT_ALLOWED', protected_action: 'yes' }),
            expect.objectContaining({ result: 'success', target_id: ids.addressId, protected_action: 'yes' }),
          ]),
        )

        const operations = new OperationsAdminService(pool, {})
        const systemAdmin = invocation({ role: 'system_administrator', scope: { kind: 'global' } })
        const retry = {
          eventId: ids.failedEventId,
          operationReference: 'retry:admin-e2e:110',
          reasonCode: 'OPERATOR_RETRY',
          occurredAt,
        }
        await expect(
          operations.retryInboundEvent(systemAdmin, { ...retry, expectedStatus: 'dead_lettered' }),
        ).rejects.toMatchObject({ reasonCode: 'FAILED_JOB_STATUS_STALE' })
        expect(await operations.retryInboundEvent(systemAdmin, { ...retry, expectedStatus: 'failed' })).toEqual({
          eventId: ids.failedEventId,
          outcome: 'requeued',
          deduplicated: false,
        })
        expect(await operations.retryInboundEvent(systemAdmin, { ...retry, expectedStatus: 'failed' })).toEqual({
          eventId: ids.failedEventId,
          outcome: 'requeued',
          deduplicated: true,
        })
        expect((await pool.query(`SELECT count(*)::integer AS count FROM admin_retry_operations`)).rows[0].count).toBe(
          1,
        )
      } finally {
        await pool.end()
      }
    })
  }, 120_000)
})
