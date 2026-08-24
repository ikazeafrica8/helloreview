import { describe, expect, test } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations, runInTransaction } from '../../packages/db/dist/index.js'
import { withPostgres } from '../../packages/testing/dist/index.js'
import {
  BusinessApprovalError,
  BusinessApprovalRepository,
  BusinessApprovalService,
  VisitCBookingService,
} from '../../apps/api/dist/modules/business-approval/index.js'
import {
  GuidelineDeliveryService,
  GuidelineDeliveryRepository,
  GuidelineIncidentAuditorService,
} from '../../apps/api/dist/modules/guideline-delivery/index.js'
import { MessageTemplateRepository, OutboundIntentService } from '../../apps/api/dist/modules/messaging/index.js'
import { activateNextGuidelineVersion, guidelineRequest, seedPhase7Workflow } from '../helpers/phase7-seed.mjs'

const approvalInput = (ids, state, overrides = {}) => ({
  workflowId: ids.workflowId,
  campaignId: ids.campaignId,
  applicationId: ids.applicationId,
  state,
  source: 'authorized_operator',
  approverReference: 'operator_phase7',
  scopeCode: 'assigned-campaign-and-application',
  reasonCode: `APPROVAL_${state.toUpperCase()}`,
  issuedAt: state === 'approved' ? ids.now : null,
  expiresAt: state === 'approved' ? new Date(ids.now.getTime() + 86_400_000) : null,
  recordedAt: ids.now,
  ...overrides,
})

describe('Phase 7 persistence and hard gates', () => {
  test('keeps immutable versioned approval history, one current head, and critical revocation task', async () => {
    await withPostgres(async (postgres) => {
      await applyMigrations(postgres.url)
      const pool = new Pool({ connectionString: postgres.url })
      try {
        const ids = await seedPhase7Workflow(pool, 'approval-history')
        const repository = new BusinessApprovalRepository()
        const service = new BusinessApprovalService(pool, repository)
        await expect(service.record(approvalInput(ids, 'approved', { source: 'participant' }))).rejects.toMatchObject({
          reasonCode: 'APPROVAL_SOURCE_NOT_AUTHORIZED',
        })
        expect(BusinessApprovalError).toBeDefined()

        const pending = await service.record(approvalInput(ids, 'pending'))
        expect(pending).toMatchObject({ deduplicated: false, approval: { version: 1, state: 'pending' } })
        expect(await service.record(approvalInput(ids, 'pending'))).toMatchObject({ deduplicated: true })
        const approved = await service.record(
          approvalInput(ids, 'approved', { recordedAt: new Date(ids.now.getTime() + 1_000) }),
        )
        const revoked = await service.record(
          approvalInput(ids, 'revoked', { recordedAt: new Date(ids.now.getTime() + 2_000) }),
        )
        expect(approved.approval.version).toBe(2)
        expect(revoked.approval).toMatchObject({ version: 3, state: 'revoked' })

        const history = await runInTransaction(pool, (tx) => repository.history(tx, ids.workflowId))
        expect(history.map((item) => [item.version, item.state])).toEqual([
          [1, 'pending'],
          [2, 'approved'],
          [3, 'revoked'],
        ])
        expect(
          (
            await pool.query(
              `SELECT state FROM business_approvals a JOIN business_approval_heads h ON h.approval_id = a.id WHERE h.workflow_id = $1`,
              [ids.workflowId],
            )
          ).rows[0].state,
        ).toBe('revoked')
        await expect(
          pool.query(`UPDATE business_approvals SET state = 'approved' WHERE id = $1`, [pending.approval.id]),
        ).rejects.toThrow(/append-only/)
        expect(
          (await pool.query(`SELECT priority FROM human_review_tasks WHERE workflow_reference = $1`, [ids.workflowId]))
            .rows,
        ).toContainEqual({ priority: 'critical' })
      } finally {
        await pool.end()
      }
    })
  })

  test('blocks Visit C instructions while pending and releases exactly one after current approval', async () => {
    await withPostgres(async (postgres) => {
      await applyMigrations(postgres.url)
      const pool = new Pool({ connectionString: postgres.url })
      try {
        const ids = await seedPhase7Workflow(pool, 'visit-c-gate')
        const repository = new BusinessApprovalRepository()
        const approvals = new BusinessApprovalService(pool, repository)
        const booking = new VisitCBookingService(repository, new OutboundIntentService(new MessageTemplateRepository()))
        await approvals.record(approvalInput(ids, 'pending'))
        const pending = await runInTransaction(pool, (tx) =>
          booking.request(tx, {
            workflowId: ids.workflowId,
            channel: 'KAKAO',
            recipientReference: 'kakao-phase7',
            templateVersion: 1,
            triggeringEventId: 'pending-request',
            actorId: 'system_phase7',
            occurredAt: ids.now,
          }),
        )
        expect(pending).toMatchObject({
          gate: { allowed: false, reasonCode: 'APPROVAL_PENDING' },
          notificationPurpose: 'VISIT_C_APPROVAL_STATUS',
        })
        expect(
          (
            await pool.query(
              `SELECT count(*)::integer AS count FROM outbound_notifications WHERE purpose_code = 'VISIT_C_BOOKING_INSTRUCTIONS'`,
            )
          ).rows[0].count,
        ).toBe(0)

        await approvals.record(approvalInput(ids, 'approved', { recordedAt: new Date(ids.now.getTime() + 1_000) }))
        const first = await runInTransaction(pool, (tx) =>
          booking.request(tx, {
            workflowId: ids.workflowId,
            channel: 'KAKAO',
            recipientReference: 'kakao-phase7',
            templateVersion: 1,
            triggeringEventId: 'approved-request',
            actorId: 'system_phase7',
            occurredAt: new Date(ids.now.getTime() + 2_000),
          }),
        )
        const duplicate = await runInTransaction(pool, (tx) =>
          booking.request(tx, {
            workflowId: ids.workflowId,
            channel: 'KAKAO',
            recipientReference: 'kakao-phase7',
            templateVersion: 1,
            triggeringEventId: 'approved-request',
            actorId: 'system_phase7',
            occurredAt: new Date(ids.now.getTime() + 3_000),
          }),
        )
        expect(first).toMatchObject({ gate: { allowed: true }, notificationPurpose: 'VISIT_C_BOOKING_INSTRUCTIONS' })
        expect(duplicate.notification).toMatchObject({ deduplicated: true })
        expect(
          (
            await pool.query(
              `SELECT count(*)::integer AS count FROM outbound_notifications WHERE purpose_code = 'VISIT_C_BOOKING_INSTRUCTIONS'`,
            )
          ).rows[0].count,
        ).toBe(1)
      } finally {
        await pool.end()
      }
    })
  })

  test('records one delivery and two suppressions, then delivers one newly active version', async () => {
    await withPostgres(async (postgres) => {
      await applyMigrations(postgres.url)
      const pool = new Pool({ connectionString: postgres.url })
      try {
        const ids = await seedPhase7Workflow(pool, 'guideline-versioning', {
          route: 'visit_b',
          approvalState: 'not_required',
        })
        const service = new GuidelineDeliveryService(
          pool,
          new GuidelineDeliveryRepository(),
          new OutboundIntentService(new MessageTemplateRepository()),
        )
        const first = await service.request(guidelineRequest(ids))
        const second = await service.request(guidelineRequest(ids, { triggeringEventId: 'phase7-guideline-request-2' }))
        const third = await service.request(guidelineRequest(ids, { triggeringEventId: 'phase7-guideline-request-3' }))
        expect(first.outcome).toBe('queued')
        expect([second.outcome, third.outcome]).toEqual(['suppressed', 'suppressed'])
        expect(
          (await pool.query(`SELECT outcome FROM guideline_delivery_attempts ORDER BY occurred_at, id`)).rows.map(
            (row) => row.outcome,
          ),
        ).toEqual(['queued', 'suppressed', 'suppressed'])
        expect(
          (
            await pool.query(
              `SELECT count(*)::integer AS count FROM outbound_notifications WHERE purpose_code LIKE 'GUIDELINE_DELIVERY:%'`,
            )
          ).rows[0].count,
        ).toBe(1)

        const effectiveAt = new Date(ids.now.getTime() + 10_000)
        await activateNextGuidelineVersion(pool, ids, 4, effectiveAt)
        const fourth = await service.request(
          guidelineRequest(ids, { triggeringEventId: 'phase7-guideline-v4-1', occurredAt: effectiveAt }),
        )
        const repeat = await service.request(
          guidelineRequest(ids, {
            triggeringEventId: 'phase7-guideline-v4-2',
            occurredAt: new Date(effectiveAt.getTime() + 1_000),
          }),
        )
        expect(fourth.outcome).toBe('queued')
        expect(repeat.outcome).toBe('suppressed')
        expect(
          (await pool.query(`SELECT guideline_version FROM guideline_deliveries ORDER BY guideline_version`)).rows,
        ).toEqual([{ guideline_version: 3 }, { guideline_version: 4 }])
      } finally {
        await pool.end()
      }
    })
  })

  test('independent audit creates a critical incident, campaign pause, and post-delivery review task', async () => {
    await withPostgres(async (postgres) => {
      await applyMigrations(postgres.url)
      const pool = new Pool({ connectionString: postgres.url })
      try {
        const ids = await seedPhase7Workflow(pool, 'incident-audit', { route: 'visit_c', approvalState: 'revoked' })
        const notification = await pool.query(
          `SELECT id FROM message_templates WHERE purpose_code = 'GUIDELINE_DELIVERY'`,
        )
        const outbox = await pool.query(
          `INSERT INTO outbound_notifications (
             workflow_id, channel, recipient_reference, purpose_code, content_version,
             deduplication_key, intent_source, template_id, template_version,
             rendered_content, provider_name, provider_message_id, status,
             next_attempt_at, delivered_at, created_at, updated_at
           ) VALUES ($1,'KAKAO','masked','GUIDELINE_DELIVERY:3','guideline_v3',$2,'automated',$3,1,
                     'guideline','fake','provider-1','delivered',$4,$4,$4,$4)
           RETURNING id, deduplication_key`,
          [ids.workflowId, `incident-${ids.workflowId}`, notification.rows[0].id, ids.now],
        )
        await pool.query(
          `INSERT INTO guideline_deliveries (
             workflow_id, participant_id, application_id, campaign_id, guideline_version_id,
             guideline_version, channel, triggering_event_id, rule_result, status,
             outbound_notification_id, provider_result, deduplication_key,
             requested_at, delivered_at, updated_at, created_at
           ) VALUES ($1,$2,$3,$4,$5,3,'KAKAO','forged-event',$6::jsonb,'delivered',$7,$8::jsonb,$9,$10,$10,$10,$10)`,
          [
            ids.workflowId,
            ids.participantId,
            ids.applicationId,
            ids.campaignId,
            ids.guidelineVersionId,
            JSON.stringify({ ready: false, reasonCode: 'RESERVATION_NOT_VALID' }),
            outbox.rows[0].id,
            JSON.stringify({ status: 'delivered' }),
            outbox.rows[0].deduplication_key,
            ids.now,
          ],
        )
        const result = await new GuidelineIncidentAuditorService(pool).auditBatch(new Date(ids.now.getTime() + 1_000))
        expect(result).toEqual({ inspected: 1, incidentsCreated: 1, reviewTasksCreated: 1 })
        expect((await pool.query(`SELECT severity, reason_code FROM guideline_delivery_incidents`)).rows).toEqual([
          { severity: 'critical', reason_code: 'PREMATURE_GUIDELINE_DELIVERY' },
        ])
        expect((await pool.query(`SELECT scope, reason_code FROM automation_pauses`)).rows).toContainEqual({
          scope: 'campaign',
          reason_code: 'PREMATURE_GUIDELINE_DELIVERY',
        })
        expect((await pool.query(`SELECT priority, case_packet FROM human_review_tasks`)).rows[0]).toMatchObject({
          priority: 'critical',
        })
      } finally {
        await pool.end()
      }
    })
  })
})
