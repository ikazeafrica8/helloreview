import { describe, expect, test } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../../packages/db/dist/index.js'
import { withPostgres } from '../../packages/testing/dist/index.js'
import {
  AutomationPauseService,
  StaleWorkflowEventError,
  StaleWorkflowVersionError,
  WORKFLOW_GUARD,
  WORKFLOW_TRIGGER,
  WorkflowCorrectionService,
  WorkflowInstanceService,
  WorkflowTransitionService,
} from '../../apps/api/dist/modules/workflow-core/index.js'

const seed = async (pool) => {
  const campaign = await pool.query(
    `INSERT INTO campaigns (code, name, type, visit_method, status, starts_at, ends_at)
     VALUES ('phase5-shipping', 'Phase 5 shipping', 'shipping', 'not_applicable', 'active', $1, $2)
     RETURNING id`,
    [new Date('2026-08-01T00:00:00Z'), new Date('2026-09-30T00:00:00Z')],
  )
  const participant = await pool.query(`INSERT INTO participants (name) VALUES ('Phase Five') RETURNING id`)
  const application = await pool.query(
    `INSERT INTO applications (
       source_system, source_application_id, campaign_id, status, source_status,
       applicant_name, phone_normalized, source_version, submitted_at,
       last_source_event_id, last_source_occurred_at, last_synchronized_at
     ) VALUES ('manual_pilot','phase5-application',$1,'received','received','Phase Five',
               '+821012345678',1,$2,'phase5-source-1',$2,$2)
     RETURNING id`,
    [campaign.rows[0].id, new Date('2026-08-24T10:00:00Z')],
  )
  const secondCampaign = await pool.query(
    `INSERT INTO campaigns (code, name, type, visit_method, status, starts_at, ends_at)
     VALUES ('phase5-payback', 'Phase 5 payback', 'payback', 'not_applicable', 'active', $1, $2)
     RETURNING id`,
    [new Date('2026-08-01T00:00:00Z'), new Date('2026-09-30T00:00:00Z')],
  )
  const secondApplication = await pool.query(
    `INSERT INTO applications (
       source_system, source_application_id, campaign_id, status, source_status,
       applicant_name, phone_normalized, source_version, submitted_at,
       last_source_event_id, last_source_occurred_at, last_synchronized_at
     ) VALUES ('manual_pilot','phase5-application-2',$1,'received','received','Phase Five',
               '+821012345678',1,$2,'phase5-source-2',$2,$2)
     RETURNING id`,
    [secondCampaign.rows[0].id, new Date('2026-08-24T10:00:00Z')],
  )
  return {
    campaignId: campaign.rows[0].id,
    participantId: participant.rows[0].id,
    applicationId: application.rows[0].id,
    secondCampaignId: secondCampaign.rows[0].id,
    secondApplicationId: secondApplication.rows[0].id,
  }
}

const actor = {
  actorType: 'operator',
  actorId: 'operator_phase5',
  authorized: true,
  correlationId: 'cor_phase5',
}

describe('workflow core transactional behavior', () => {
  test('serializes transitions, persists rejections, applies four pause scopes, and supersedes corrections', async () => {
    await withPostgres(async (postgres) => {
      await applyMigrations(postgres.url)
      const pool = new Pool({ connectionString: postgres.url })
      try {
        const ids = await seed(pool)
        const workflows = new WorkflowInstanceService(pool)
        const pauses = new AutomationPauseService(pool)
        const transitions = new WorkflowTransitionService(pool, workflows, pauses)
        const corrections = new WorkflowCorrectionService(pool, workflows)

        const workflow = await workflows.create({
          ...ids,
          actorType: 'system',
          actorId: 'system_phase5',
          triggeringEventId: 'workflow-create-1',
          correlationId: 'cor_phase5',
          occurredAt: new Date('2026-08-24T10:00:00Z'),
        })
        expect(workflow.version).toBe(0)
        expect(workflow.snapshot).toMatchObject({
          campaign_type: 'shipping',
          shipping: 'address_requested',
          payback_consent: 'not_applicable',
          reservation: 'not_applicable',
        })
        expect(
          (
            await pool.query(`SELECT count(*)::integer AS count FROM workflow_events WHERE workflow_id = $1`, [
              workflow.id,
            ])
          ).rows[0].count,
        ).toBe(12)
        const secondWorkflow = await workflows.create({
          participantId: ids.participantId,
          applicationId: ids.secondApplicationId,
          campaignId: ids.secondCampaignId,
          actorType: 'system',
          actorId: 'system_phase5',
          triggeringEventId: 'workflow-create-2',
          correlationId: 'cor_phase5',
          occurredAt: new Date('2026-08-24T10:00:00Z'),
        })
        expect(secondWorkflow.id).not.toBe(workflow.id)
        expect(secondWorkflow.snapshot).toMatchObject({
          campaign_type: 'payback',
          payback_consent: 'not_requested',
        })
        expect(
          (
            await pool.query(`SELECT count(*)::integer AS count FROM workflow_instances WHERE participant_id = $1`, [
              ids.participantId,
            ])
          ).rows[0].count,
        ).toBe(2)

        const command = (eventId) => ({
          workflowId: workflow.id,
          expectedVersion: 0,
          dimension: 'application',
          to: 'application_requested',
          trigger: WORKFLOW_TRIGGER.INITIAL_APPLICANT_CONTACT,
          triggeringEventId: eventId,
          actorType: 'system',
          actorId: 'system_phase5',
          preconditionCodes: [WORKFLOW_GUARD.CAMPAIGN_APPLICATION_URL_EXISTS],
          guardResults: { [WORKFLOW_GUARD.CAMPAIGN_APPLICATION_URL_EXISTS]: true },
          correlationId: 'cor_phase5',
          occurredAt: new Date('2026-08-24T10:01:00Z'),
          automated: false,
        })
        const concurrent = await Promise.allSettled([
          transitions.apply(command('concurrent-a')),
          transitions.apply(command('concurrent-b')),
        ])
        expect(concurrent.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
        const rejected = concurrent.find((result) => result.status === 'rejected')
        expect(rejected.reason).toBeInstanceOf(StaleWorkflowVersionError)

        const afterConcurrent = await workflows.findById(workflow.id)
        expect(afterConcurrent).toMatchObject({ version: 1, snapshot: { application: 'application_requested' } })
        const transitionEvidence = await pool.query(
          `SELECT id, result, side_effects
             FROM workflow_events
            WHERE workflow_id = $1 AND event_kind <> 'initialized'
            ORDER BY result`,
          [workflow.id],
        )
        expect(transitionEvidence.rows).toHaveLength(2)
        expect(transitionEvidence.rows.find((row) => row.result === 'rejected').side_effects).toEqual([])
        const acceptedEvent = transitionEvidence.rows.find((row) => row.result === 'success')

        const correction = await corrections.apply({
          workflowId: workflow.id,
          expectedVersion: 1,
          priorEventId: acceptedEvent.id,
          dimension: 'application',
          to: 'not_applied',
          triggeringEventId: 'correction-1',
          ...actor,
          scopeCode: 'WORKFLOW',
          reasonCode: 'OPERATOR_CORRECTED_STATE',
          occurredAt: new Date('2026-08-24T10:02:00Z'),
        })
        expect(correction).toMatchObject({
          workflowVersion: 2,
          supersededEventId: acceptedEvent.id,
          cancelledSideEffectCount: 1,
          criticalIncidentCreated: false,
          snapshot: { application: 'not_applied' },
        })
        expect((await corrections.currentEvents(workflow.id)).some((event) => event.id === acceptedEvent.id)).toBe(
          false,
        )
        expect(
          (
            await pool.query(
              `SELECT detail FROM audit_logs
                WHERE action = 'CORRECTION_APPLIED' AND target_id = $1 AND result = 'success'`,
              [workflow.id],
            )
          ).rows[0],
        ).toMatchObject({
          detail: {
            override_evidence: {
              schemaVersion: 'sensitive-override-evidence-v1',
              scopeCode: 'WORKFLOW',
              priorValueCode: 'application_requested',
              newValueCode: 'not_applied',
            },
          },
        })

        await expect(
          transitions.apply({
            ...command('old-after-correction'),
            expectedVersion: 2,
            occurredAt: new Date('2026-08-24T10:01:30Z'),
          }),
        ).rejects.toBeInstanceOf(StaleWorkflowEventError)
        expect(
          (
            await pool.query(
              `SELECT retained_for_replay FROM workflow_events WHERE triggering_event_id = 'old-after-correction'`,
            )
          ).rows[0].retained_for_replay,
        ).toBe(true)

        const pauseInputs = [
          { scope: 'global', kind: 'standard' },
          { scope: 'campaign', kind: 'standard', campaignId: ids.campaignId },
          { scope: 'workflow_type', kind: 'standard', workflowType: 'shipping' },
          { scope: 'participant', kind: 'standard', participantId: ids.participantId },
        ]
        const activated = []
        for (const [index, target] of pauseInputs.entries()) {
          activated.push(
            await pauses.activate({
              ...target,
              ...actor,
              reasonCode: `OPERATOR_PAUSE_${index + 1}`,
              activatedAt: new Date(`2026-08-24T10:0${index + 3}:00Z`),
            }),
          )
        }
        expect((await pauses.effectiveForWorkflow(workflow.id)).map((pause) => pause.scope).sort()).toEqual([
          'campaign',
          'global',
          'participant',
          'workflow_type',
        ])
        await expect(
          transitions.apply({
            ...command('blocked-by-pause'),
            expectedVersion: 2,
            occurredAt: new Date('2026-08-24T10:08:00Z'),
            automated: true,
          }),
        ).rejects.toMatchObject({ reasonCode: 'WORKFLOW_AUTOMATION_PAUSED' })
        expect((await workflows.findById(workflow.id)).version).toBe(2)

        for (const [index, pause] of activated.entries()) {
          await pauses.deactivate({
            pauseId: pause.id,
            ...actor,
            reasonCode: `OPERATOR_RESUME_${index + 1}`,
            deactivatedAt: new Date('2026-08-24T10:09:00Z'),
          })
        }
        expect(await pauses.effectiveForWorkflow(workflow.id)).toEqual([])

        await pool.query(
          `UPDATE workflow_instances
              SET guideline_state = 'delivered', guideline_origin_at = $2, version = 3, updated_at = $2
            WHERE id = $1`,
          [workflow.id, new Date('2026-08-24T10:10:00Z')],
        )
        const delivered = await pool.query(
          `INSERT INTO workflow_events (
             workflow_id, expected_version, workflow_version, dimension, event_kind,
             current_state, requested_target_state, trigger_code, triggering_event_id,
             actor_type, actor_id, preconditions, decision_reason, side_effects,
             occurred_at, correlation_id, result, retained_for_replay
           ) VALUES ($1,2,3,'guideline','transition','delivery_queued','delivered',
                     'GUIDELINE_DELIVERED','delivered-fixture','system','system_phase5','{}'::jsonb,
                     'WORKFLOW_TRANSITION_APPROVED','["RECORD_DELIVERY"]'::jsonb,$2,'cor_phase5','success',false)
           RETURNING id`,
          [workflow.id, new Date('2026-08-24T10:10:00Z')],
        )
        const invalidation = await corrections.apply({
          workflowId: workflow.id,
          expectedVersion: 3,
          priorEventId: delivered.rows[0].id,
          dimension: 'guideline',
          to: 'delivery_failed',
          triggeringEventId: 'correction-delivered-guideline',
          ...actor,
          scopeCode: 'WORKFLOW',
          reasonCode: 'OPERATOR_INVALIDATED_DELIVERY',
          occurredAt: new Date('2026-08-24T10:11:00Z'),
        })
        expect(invalidation).toMatchObject({
          workflowVersion: 4,
          criticalIncidentCreated: true,
          snapshot: { guideline: 'delivery_failed' },
        })

        await expect(
          pool.query(`UPDATE workflow_events SET decision_reason = 'TAMPERED' WHERE id = $1`, [acceptedEvent.id]),
        ).rejects.toThrow(/append-only/)

        const evidence = await pool.query(
          `SELECT
             (SELECT count(*)::integer FROM workflow_event_supersessions WHERE workflow_id = $1) AS supersessions,
             (SELECT count(*)::integer FROM audit_logs WHERE target_id = $2) AS audits,
             (SELECT count(*)::integer FROM workflow_side_effects WHERE status = 'cancelled') AS cancelled_effects`,
          [workflow.id, workflow.id],
        )
        expect(evidence.rows[0]).toMatchObject({ supersessions: 2, cancelled_effects: 2 })
        expect(evidence.rows[0].audits).toBe(8)
        expect(
          (
            await pool.query(`SELECT count(*)::integer AS count FROM workflow_incidents WHERE workflow_id = $1`, [
              workflow.id,
            ])
          ).rows[0].count,
        ).toBe(1)
      } finally {
        await pool.end()
      }
    })
  })
})
