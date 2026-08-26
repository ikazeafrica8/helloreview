import { describe, expect, test } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../../packages/db/dist/index.js'
import { withPostgres } from '../../packages/testing/dist/index.js'
import {
  PRIVACY_REQUEST_INTAKE_EVIDENCE_VERSION,
  PRIVACY_REQUEST_SCOPE_VERSION,
  PrivacyRequestService,
  PrivacyRequestServiceError,
} from '../../apps/api/dist/modules/privacy-ops/index.js'

const at = new Date('2026-08-26T07:00:00.000Z')

const input = (participantId, overrides = {}) => ({
  requestReference: 'privacy-request:pseudo:96',
  requesterReference: 'requester:pseudo:96',
  claimedParticipantId: participantId,
  requestType: 'deletion',
  scope: {
    schemaVersion: PRIVACY_REQUEST_SCOPE_VERSION,
    state: 'unconfirmed',
    subjectReference: 'participant:pseudo:96',
    dataClasses: [],
    campaignReferences: [],
    workflowReferences: [],
  },
  deadlinePolicy: null,
  assigneeId: null,
  evidence: {
    schemaVersion: PRIVACY_REQUEST_INTAKE_EVIDENCE_VERSION,
    channel: 'kakao',
    reference: 'message:pseudo:privacy:96',
  },
  actorType: 'participant',
  actorReference: 'participant:pseudo:96',
  sourceAuthorized: true,
  correlationId: 'cor:privacy:96',
  occurredAt: at,
  ...overrides,
})

describe('T96 privacy-request aggregate and intake', () => {
  test('records one unverified request, immutable evidence and protected audit without a guessed deadline', async () => {
    await withPostgres(async (postgres) => {
      await applyMigrations(postgres.url)
      const pool = new Pool({ connectionString: postgres.url })
      try {
        const participant = await pool.query(`INSERT INTO participants DEFAULT VALUES RETURNING id`)
        const participantId = participant.rows[0].id
        const service = new PrivacyRequestService(pool)

        const first = await service.intake(input(participantId))
        const replay = await service.intake(input(participantId, { occurredAt: new Date(at.getTime() + 60_000) }))

        expect(first).toMatchObject({
          deduplicated: false,
          request: {
            requestReference: 'privacy-request:pseudo:96',
            claimedParticipantId: participantId,
            requestType: 'deletion',
            identityVerificationState: 'unverified',
            status: 'received',
            deadlinePolicyReference: null,
            deadlineAt: null,
            assigneeId: null,
            scope: { state: 'unconfirmed', dataClasses: [] },
          },
        })
        expect(replay).toMatchObject({ deduplicated: true, request: { id: first.request.id } })

        await expect(service.intake(input(participantId, { requestType: 'access' }))).rejects.toMatchObject({
          reasonCode: 'PRIVACY_REQUEST_REFERENCE_CONFLICT',
        })

        expect((await pool.query(`SELECT count(*)::integer AS count FROM privacy_requests`)).rows[0].count).toBe(1)
        expect(
          (await pool.query(`SELECT event_type, to_status, to_verification_state FROM privacy_request_events`)).rows,
        ).toEqual([{ event_type: 'intake_recorded', to_status: 'received', to_verification_state: 'unverified' }])
        expect(
          (
            await pool.query(
              `SELECT action, result, reason, protected_action, detail
                 FROM audit_logs WHERE target_type = 'privacy_request'`,
            )
          ).rows,
        ).toEqual([
          expect.objectContaining({
            action: 'PRIVACY_REQUEST_RECEIVED',
            result: 'success',
            reason: 'PRIVACY_REQUEST_INTAKE_RECORDED',
            protected_action: 'yes',
            detail: expect.objectContaining({ deadline_policy_reference: null, scope_state: 'unconfirmed' }),
          }),
        ])

        await expect(pool.query(`UPDATE privacy_request_events SET detail = '{}'::jsonb`)).rejects.toThrow(
          /append-only/,
        )
        await expect(pool.query(`DELETE FROM privacy_request_events`)).rejects.toThrow(/append-only/)
        await expect(pool.query(`TRUNCATE privacy_request_events`)).rejects.toThrow(/append-only/)
        await expect(pool.query(`DELETE FROM privacy_requests`)).rejects.toThrow(/foreign key constraint/i)

        const rls = await pool.query(
          `SELECT relname, relrowsecurity
             FROM pg_class
            WHERE relname IN ('privacy_requests','privacy_request_events')
            ORDER BY relname`,
        )
        expect(rls.rows).toEqual([
          { relname: 'privacy_request_events', relrowsecurity: true },
          { relname: 'privacy_requests', relrowsecurity: true },
        ])
      } finally {
        await pool.end()
      }
    })
  })

  test('rejects unauthorized intake and unknown claimed participants before storing evidence', async () => {
    await withPostgres(async (postgres) => {
      await applyMigrations(postgres.url)
      const pool = new Pool({ connectionString: postgres.url })
      try {
        const service = new PrivacyRequestService(pool)
        await expect(service.intake(input(null, { sourceAuthorized: false }))).rejects.toBeInstanceOf(
          PrivacyRequestServiceError,
        )
        await expect(service.intake(input('8d2a408e-9a26-4f0e-8469-08305a4fbb99'))).rejects.toMatchObject({
          reasonCode: 'PRIVACY_REQUEST_CLAIMED_PARTICIPANT_NOT_FOUND',
        })
        expect((await pool.query(`SELECT count(*)::integer AS count FROM privacy_requests`)).rows[0].count).toBe(0)
        expect((await pool.query(`SELECT count(*)::integer AS count FROM audit_logs`)).rows[0].count).toBe(0)
      } finally {
        await pool.end()
      }
    })
  })

  test('persists an explicitly supplied request-deadline policy without deriving retention', async () => {
    await withPostgres(async (postgres) => {
      await applyMigrations(postgres.url)
      const pool = new Pool({ connectionString: postgres.url })
      try {
        const service = new PrivacyRequestService(pool)
        const deadlineAt = new Date('2026-09-02T07:00:00.000Z')
        const recorded = await service.intake(
          input(null, {
            requestReference: 'privacy-request:pseudo:deadline',
            requestType: 'access',
            scope: {
              schemaVersion: PRIVACY_REQUEST_SCOPE_VERSION,
              state: 'declared',
              subjectReference: 'participant:pseudo:deadline',
              dataClasses: ['privacy_requests'],
              campaignReferences: [],
              workflowReferences: [],
            },
            deadlinePolicy: { reference: 'privacy-deadline-policy-v1', deadlineAt },
            assigneeId: 'privacy-reviewer:pseudo:1',
          }),
        )
        expect(recorded.request).toMatchObject({
          deadlinePolicyReference: 'privacy-deadline-policy-v1',
          deadlineAt,
          assigneeId: 'privacy-reviewer:pseudo:1',
          scope: { state: 'declared', dataClasses: ['privacy_requests'] },
        })
        const retentionColumns = await pool.query(
          `SELECT column_name
             FROM information_schema.columns
            WHERE table_name = 'privacy_requests'
              AND column_name IN ('retention_days','retention_until','delete_after')`,
        )
        expect(retentionColumns.rows).toEqual([])
      } finally {
        await pool.end()
      }
    })
  })
})
