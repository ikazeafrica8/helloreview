import { describe, expect, test } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../../packages/db/dist/index.js'
import { withPostgres } from '../../packages/testing/dist/index.js'
import {
  PRIVACY_IDENTITY_VERIFICATION_EVIDENCE_SCHEMA_VERSION,
  PRIVACY_IDENTITY_VERIFICATION_POLICY_SCHEMA_VERSION,
  PRIVACY_REQUEST_INTAKE_EVIDENCE_VERSION,
  PRIVACY_REQUEST_SCOPE_VERSION,
  PrivacyRequestService,
} from '../../apps/api/dist/modules/privacy-ops/index.js'
import { AutomationPauseService, WorkflowInstanceService } from '../../apps/api/dist/modules/workflow-core/index.js'

const at = new Date('2026-08-26T07:00:00.000Z')

const seed = async (pool) => {
  const participants = await pool.query(
    `INSERT INTO participants (name) VALUES ('Privacy One'), ('Privacy Two') RETURNING id`,
  )
  const [participantOne, participantTwo] = participants.rows.map((row) => row.id)
  const campaigns = await pool.query(
    `INSERT INTO campaigns (code, name, type, visit_method, status, starts_at, ends_at)
     VALUES ('privacy-97-a','Privacy 97 A','shipping','not_applicable','active',$1,$2),
            ('privacy-97-b','Privacy 97 B','payback','not_applicable','active',$1,$2)
     RETURNING id`,
    [new Date('2026-08-01T00:00:00Z'), new Date('2026-09-30T00:00:00Z')],
  )
  const [campaignOne, campaignTwo] = campaigns.rows.map((row) => row.id)
  const applications = await pool.query(
    `INSERT INTO applications (
       source_system, source_application_id, campaign_id, status, source_status,
       applicant_name, phone_normalized, source_version, submitted_at, last_source_event_id,
       last_source_occurred_at, last_synchronized_at
     ) VALUES
       ('manual_pilot','privacy-97-app-a1',$1,'received','received','Privacy One','+821011111111',1,$3,'privacy-97-source-a1',$3,$3),
       ('manual_pilot','privacy-97-app-b1',$2,'received','received','Privacy One','+821011111111',1,$3,'privacy-97-source-b1',$3,$3),
       ('manual_pilot','privacy-97-app-a2',$1,'received','received','Privacy Two','+821022222222',1,$3,'privacy-97-source-a2',$3,$3)
     RETURNING id`,
    [campaignOne, campaignTwo, at],
  )
  const workflows = new WorkflowInstanceService(pool)
  const create = (participantId, applicationId, campaignId, suffix) =>
    workflows.create({
      participantId,
      applicationId,
      campaignId,
      actorType: 'system',
      actorId: 'privacy-system:pseudo:97',
      triggeringEventId: `privacy-workflow-create:${suffix}`,
      correlationId: `privacy-workflow-cor:${suffix}`,
      occurredAt: at,
    })
  const workflowOneCampaignOne = await create(participantOne, applications.rows[0].id, campaignOne, 'a1')
  const workflowOneCampaignTwo = await create(participantOne, applications.rows[1].id, campaignTwo, 'b1')
  const workflowTwoCampaignOne = await create(participantTwo, applications.rows[2].id, campaignOne, 'a2')
  return {
    participantOne,
    participantTwo,
    campaignOne,
    campaignTwo,
    workflowOneCampaignOne,
    workflowOneCampaignTwo,
    workflowTwoCampaignOne,
  }
}

const intake = (participantId, requestReference, scope) => ({
  requestReference,
  requesterReference: `${requestReference}:requester`,
  claimedParticipantId: participantId,
  requestType: 'deletion',
  scope,
  deadlinePolicy: null,
  assigneeId: 'privacy-reviewer:pseudo:97',
  evidence: {
    schemaVersion: PRIVACY_REQUEST_INTAKE_EVIDENCE_VERSION,
    channel: 'operator',
    reference: `${requestReference}:intake-evidence`,
  },
  actorType: 'operator',
  actorReference: 'privacy-reviewer:pseudo:97',
  sourceAuthorized: true,
  correlationId: `${requestReference}:correlation`,
  occurredAt: at,
})

const reviewer = (requestId, operationReference, occurredAt = new Date(at.getTime() + 60_000)) => ({
  requestId,
  operationReference,
  actorReference: 'privacy-reviewer:pseudo:97',
  reviewerAuthorized: true,
  correlationId: `${operationReference}:correlation`,
  occurredAt,
})

const policy = {
  schemaVersion: PRIVACY_IDENTITY_VERIFICATION_POLICY_SCHEMA_VERSION,
  policyVersion: 'privacy-verified-channel-fixture-v1',
  approved: true,
  approvedByReference: 'privacy-governance:pseudo:fixture',
  approvedAt: at,
  method: 'verified_channel_identity',
}

const evidence = (channelIdentityId, reference) => ({
  schemaVersion: PRIVACY_IDENTITY_VERIFICATION_EVIDENCE_SCHEMA_VERSION,
  method: 'verified_channel_identity',
  channelIdentityId,
  reference,
})

describe('T97 minimal identity verification and affected-processing pauses', () => {
  test('pauses only declared participant-campaign and workflow processing and keeps privacy pauses protected', async () => {
    await withPostgres(async (postgres) => {
      await applyMigrations(postgres.url)
      const pool = new Pool({ connectionString: postgres.url })
      try {
        const ids = await seed(pool)
        const service = new PrivacyRequestService(pool)
        const pauses = new AutomationPauseService(pool)
        const received = await service.intake(
          intake(ids.participantOne, 'privacy-request:pseudo:97:scoped', {
            schemaVersion: PRIVACY_REQUEST_SCOPE_VERSION,
            state: 'declared',
            subjectReference: 'participant:pseudo:97:one',
            dataClasses: ['shipping_addresses'],
            campaignReferences: [`campaign:${ids.campaignOne}`],
            workflowReferences: [`workflow:${ids.workflowOneCampaignTwo.id}`],
          }),
        )
        const action = {
          ...reviewer(received.request.id, 'privacy-verification-start:pseudo:97:scoped'),
          affectedScopes: [
            { scope: 'participant_campaign', participantId: ids.participantOne, campaignId: ids.campaignOne },
            { scope: 'workflow', workflowId: ids.workflowOneCampaignTwo.id },
          ],
        }
        const started = await service.beginIdentityVerification(action)
        const replay = await service.beginIdentityVerification(action)
        expect(started).toMatchObject({ deduplicated: false, request: { status: 'identity_verification' } })
        expect(replay).toMatchObject({ deduplicated: true, pauses: [{}, {}] })
        expect(await pauses.effectiveForWorkflow(ids.workflowOneCampaignOne.id)).toHaveLength(1)
        expect(await pauses.effectiveForWorkflow(ids.workflowOneCampaignTwo.id)).toHaveLength(1)
        expect(await pauses.effectiveForWorkflow(ids.workflowTwoCampaignOne.id)).toHaveLength(0)
        const unrelatedStandardPause = await pauses.activate({
          scope: 'participant',
          kind: 'standard',
          participantId: ids.participantTwo,
          reasonCode: 'OPERATOR_STANDARD_PAUSE',
          actorType: 'operator',
          actorId: 'operator:pseudo:97',
          authorized: true,
          correlationId: 'standard-pause:pseudo:97',
        })
        await expect(
          pool.query(
            `INSERT INTO privacy_request_processing_pauses (
               request_id, pause_id, scope, participant_id, created_at
             ) VALUES ($1,$2,'participant',$3,$4)`,
            [received.request.id, unrelatedStandardPause.id, ids.participantTwo, at],
          ),
        ).rejects.toThrow(/privacy request processing pause link is invalid/)
        await expect(
          pauses.deactivate({
            pauseId: started.pauses[0].pauseId,
            reasonCode: 'OPERATOR_RESUME',
            actorType: 'operator',
            actorId: 'operator:pseudo:97',
            authorized: true,
            correlationId: 'privacy-resume:pseudo:97',
          }),
        ).rejects.toMatchObject({ reasonCode: 'WORKFLOW_PRIVACY_PAUSE_REQUIRES_PRIVACY_WORKFLOW' })
        expect(
          (
            await pool.query(
              `SELECT result, reason FROM audit_logs
                WHERE action = 'AUTOMATION_RESUMED' ORDER BY occurred_at DESC LIMIT 1`,
            )
          ).rows[0],
        ).toEqual({ result: 'rejected', reason: 'WORKFLOW_PRIVACY_PAUSE_REQUIRES_PRIVACY_WORKFLOW' })
        await expect(pool.query(`UPDATE privacy_request_processing_pauses SET created_at = now()`)).rejects.toThrow(
          /append-only/,
        )
        await expect(pool.query(`DELETE FROM privacy_request_processing_pauses`)).rejects.toThrow(/append-only/)
        expect(
          (
            await pool.query(
              `SELECT relname, relrowsecurity FROM pg_class
                WHERE relname IN ('automation_pauses','privacy_request_processing_pauses') ORDER BY relname`,
            )
          ).rows,
        ).toEqual([
          { relname: 'automation_pauses', relrowsecurity: true },
          { relname: 'privacy_request_processing_pauses', relrowsecurity: true },
        ])
      } finally {
        await pool.end()
      }
    })
  })

  test('uses one generic failure for missing, revoked, or cross-participant identity evidence', async () => {
    await withPostgres(async (postgres) => {
      await applyMigrations(postgres.url)
      const pool = new Pool({ connectionString: postgres.url })
      try {
        const ids = await seed(pool)
        const service = new PrivacyRequestService(pool)
        const identities = await pool.query(
          `INSERT INTO channel_identities (
             participant_id, provider, external_user_id, verification_state, verified_at
           ) VALUES ($1,'kakao','privacy-97-other','verified',$3),
                    ($2,'kakao','privacy-97-revoked','revoked',null)
           RETURNING id, verification_state`,
          [ids.participantTwo, ids.participantOne, at],
        )
        const crossIdentityId = identities.rows.find((row) => row.verification_state === 'verified').id
        const revokedIdentityId = identities.rows.find((row) => row.verification_state === 'revoked').id
        const attempts = [
          ['missing', 'bcb86ef1-d286-46f0-9a7e-b666cc42d4b1'],
          ['revoked', revokedIdentityId],
          ['cross', crossIdentityId],
        ]
        for (const [index, [label, channelIdentityId]] of attempts.entries()) {
          const requestReference = `privacy-request:pseudo:97:failed:${label}`
          const received = await service.intake(
            intake(ids.participantOne, requestReference, {
              schemaVersion: PRIVACY_REQUEST_SCOPE_VERSION,
              state: 'unconfirmed',
              subjectReference: `participant:pseudo:97:failed:${label}`,
              dataClasses: [],
              campaignReferences: [],
              workflowReferences: [],
            }),
          )
          await service.beginIdentityVerification({
            ...reviewer(received.request.id, `privacy-verification-start:pseudo:97:${label}`),
            affectedScopes: [{ scope: 'participant', participantId: ids.participantOne }],
          })
          const result = await service.completeIdentityVerification({
            ...reviewer(
              received.request.id,
              `privacy-verification-complete:pseudo:97:${label}`,
              new Date(at.getTime() + (index + 2) * 60_000),
            ),
            policy,
            evidence: evidence(channelIdentityId, `privacy-evidence:pseudo:97:${label}`),
          })
          expect(result).toMatchObject({
            verified: false,
            request: {
              identityVerificationState: 'failed',
              status: 'blocked',
              verificationPolicyReference: null,
            },
          })
        }
        const failures = await pool.query(
          `SELECT reason_code, detail FROM privacy_request_events
            WHERE reason_code = 'PRIVACY_IDENTITY_VERIFICATION_FAILED' ORDER BY occurred_at`,
        )
        expect(failures.rows).toHaveLength(3)
        for (const event of failures.rows) {
          expect(event).toMatchObject({
            reason_code: 'PRIVACY_IDENTITY_VERIFICATION_FAILED',
            detail: { outcome: 'failed', method: 'verified_channel_identity' },
          })
          expect(JSON.stringify(event)).not.toContain(ids.participantTwo)
          expect(JSON.stringify(event)).not.toContain(crossIdentityId)
          expect(JSON.stringify(event)).not.toContain(revokedIdentityId)
        }
      } finally {
        await pool.end()
      }
    })
  })

  test('advances only an exact verified identity under the approved policy and retains the pauses', async () => {
    await withPostgres(async (postgres) => {
      await applyMigrations(postgres.url)
      const pool = new Pool({ connectionString: postgres.url })
      try {
        const ids = await seed(pool)
        const service = new PrivacyRequestService(pool)
        const identity = await pool.query(
          `INSERT INTO channel_identities (participant_id, provider, external_user_id, verification_state, verified_at)
           VALUES ($1,'kakao','privacy-97-owner','verified',$2) RETURNING id`,
          [ids.participantOne, at],
        )
        const received = await service.intake(
          intake(ids.participantOne, 'privacy-request:pseudo:97:verified', {
            schemaVersion: PRIVACY_REQUEST_SCOPE_VERSION,
            state: 'unconfirmed',
            subjectReference: 'participant:pseudo:97:verified',
            dataClasses: [],
            campaignReferences: [],
            workflowReferences: [],
          }),
        )
        await service.beginIdentityVerification({
          ...reviewer(received.request.id, 'privacy-verification-start:pseudo:97:verified'),
          affectedScopes: [{ scope: 'participant', participantId: ids.participantOne }],
        })
        await expect(
          service.completeIdentityVerification({
            ...reviewer(
              received.request.id,
              'privacy-verification-complete:pseudo:97:unapproved',
              new Date(at.getTime() + 120_000),
            ),
            policy: { ...policy, approved: false },
            evidence: evidence(identity.rows[0].id, 'privacy-evidence:pseudo:97:unapproved'),
          }),
        ).rejects.toMatchObject({ reasonCode: 'PRIVACY_IDENTITY_POLICY_NOT_APPROVED' })
        expect(
          (await pool.query(`SELECT status FROM privacy_requests WHERE id = $1`, [received.request.id])).rows[0],
        ).toEqual({ status: 'identity_verification' })
        const action = {
          ...reviewer(
            received.request.id,
            'privacy-verification-complete:pseudo:97:verified',
            new Date(at.getTime() + 120_000),
          ),
          policy,
          evidence: evidence(identity.rows[0].id, 'privacy-evidence:pseudo:97:verified'),
        }
        const completed = await service.completeIdentityVerification(action)
        const replay = await service.completeIdentityVerification(action)
        expect(completed).toMatchObject({
          verified: true,
          deduplicated: false,
          request: {
            identityVerificationState: 'verified',
            status: 'in_review',
            verificationPolicyReference: policy.policyVersion,
            verificationMethod: 'verified_channel_identity',
          },
        })
        expect(replay).toMatchObject({ verified: true, deduplicated: true })
        expect(await new AutomationPauseService(pool).effectiveForWorkflow(ids.workflowOneCampaignOne.id)).toHaveLength(
          1,
        )
      } finally {
        await pool.end()
      }
    })
  })

  test('rejects a cross-participant workflow with the same safe scope error and no partial pause', async () => {
    await withPostgres(async (postgres) => {
      await applyMigrations(postgres.url)
      const pool = new Pool({ connectionString: postgres.url })
      try {
        const ids = await seed(pool)
        const service = new PrivacyRequestService(pool)
        const received = await service.intake(
          intake(ids.participantOne, 'privacy-request:pseudo:97:cross-scope', {
            schemaVersion: PRIVACY_REQUEST_SCOPE_VERSION,
            state: 'declared',
            subjectReference: 'participant:pseudo:97:cross-scope',
            dataClasses: [],
            campaignReferences: [],
            workflowReferences: [`workflow:${ids.workflowTwoCampaignOne.id}`],
          }),
        )
        await expect(
          service.beginIdentityVerification({
            ...reviewer(received.request.id, 'privacy-verification-start:pseudo:97:cross-scope'),
            affectedScopes: [{ scope: 'workflow', workflowId: ids.workflowTwoCampaignOne.id }],
          }),
        ).rejects.toMatchObject({ reasonCode: 'PRIVACY_REQUEST_AFFECTED_SCOPE_INVALID' })
        expect((await pool.query(`SELECT count(*)::integer AS count FROM automation_pauses`)).rows[0].count).toBe(0)
        expect(
          (await pool.query(`SELECT status FROM privacy_requests WHERE id = $1`, [received.request.id])).rows[0],
        ).toEqual({
          status: 'received',
        })
      } finally {
        await pool.end()
      }
    })
  })
})
