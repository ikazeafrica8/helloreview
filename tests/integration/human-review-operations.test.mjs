import { describe, expect, test } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../../packages/db/dist/index.js'
import { withPostgres } from '../../packages/testing/dist/index.js'
import {
  buildHumanReviewCasePacket,
  HumanReviewOperationError,
  HumanReviewOperationsService,
  HUMAN_REVIEW_REASON,
} from '../../apps/api/dist/modules/human-tasks/index.js'
import {
  HumanOwnershipService,
  MessageTemplateRepository,
  OutboundIntentService,
} from '../../apps/api/dist/modules/messaging/index.js'
import {
  AutomationPauseService,
  HumanHandoffProjectionService,
} from '../../apps/api/dist/modules/workflow-core/index.js'
import { seedPhase6Workflow } from '../helpers/phase6-seed.mjs'

const slaPolicy = {
  version: 'operator-hours-v1',
  timezone: 'Asia/Seoul',
  serviceWeekdays: [1, 2, 3, 4, 5],
  serviceStartMinute: 9 * 60,
  serviceEndMinute: 18 * 60,
  holidayDates: [],
  targets: {
    normal: { responseMinutes: 120, escalationMinutes: 240 },
    high: { responseMinutes: 60, escalationMinutes: 120 },
    critical: { responseMinutes: 15, escalationMinutes: 30 },
  },
}

const serviceFor = (pool) =>
  new HumanReviewOperationsService(
    pool,
    new OutboundIntentService(new MessageTemplateRepository()),
    new HumanOwnershipService(pool),
    new AutomationPauseService(pool),
    new HumanHandoffProjectionService(),
  )

const addHoldingTemplate = (pool, now) =>
  pool.query(
    `INSERT INTO message_templates (
       purpose_code, version, status, legal_classification, body,
       approved_by, approved_at, activated_at
     ) VALUES ('HUMAN_HANDOFF_HOLDING',1,'active','service_notice',
               '담당자가 확인하고 있습니다.','legal_handoff',$1,$1)`,
    [now],
  )

const packetFor = (ids) =>
  buildHumanReviewCasePacket({
    workflowReference: ids.workflowId,
    workflowStateCode: 'HUMAN_REVIEW_REQUIRED',
    maskedIdentity: {
      participantReference: 'participant:masked:phase6',
      displayName: '테**',
      phone: '010-****-9999',
    },
    application: { reference: 'application:pseudo:phase6', lifecycleStatusCode: 'RECEIVED' },
    campaign: { reference: 'campaign:pseudo:phase6', typeCode: 'SHIPPING' },
    summaryCode: HUMAN_REVIEW_REASON.COMPLAINT,
    evidence: [
      {
        evidenceCode: 'PARTICIPANT_MESSAGE',
        reference: 'message:pseudo:complaint',
        observedAt: ids.now.toISOString(),
      },
    ],
    rules: [{ ruleCode: 'COMPLAINT_HANDOFF', resultCode: 'REQUIRED', version: 'handoff-v1' }],
    allowedActionCodes: ['SEND_APPROVED_MESSAGE', 'RETURN_TO_AUTOMATION'],
    priority: 'high',
    recommendationCode: 'OPERATOR_REVIEW_REQUIRED',
    createdAt: ids.now,
  })

const openInput = (ids, overrides = {}) => ({
  workflowId: ids.workflowId,
  expectedWorkflowVersion: 0,
  reasonCode: HUMAN_REVIEW_REASON.COMPLAINT,
  casePacket: packetFor(ids),
  recipientReference: 'kakao:pseudo:phase6',
  channel: 'KAKAO',
  holdingTemplateVersion: 1,
  actorType: 'system',
  actorId: 'handoff_router',
  correlationId: 'cor_handoff_open',
  deduplicationKey: `handoff:${ids.workflowId}:complaint:message-1`,
  occurredAt: ids.now,
  slaPolicy,
  ...overrides,
})

describe('T89-T92 human-review operations', () => {
  test('opens one durable episode, queues one holding message, and persists SLA evidence', async () => {
    await withPostgres(async (postgres) => {
      await applyMigrations(postgres.url)
      const pool = new Pool({ connectionString: postgres.url })
      try {
        const ids = await seedPhase6Workflow(pool, 'handoff-open')
        await addHoldingTemplate(pool, ids.now)
        const service = serviceFor(pool)
        const first = await service.openEpisode(openInput(ids))
        const replay = await service.openEpisode(
          openInput(ids, { slaPolicy: { ...slaPolicy, version: 'operator-hours-v2' } }),
        )

        expect(first).toMatchObject({
          deduplicated: false,
          task: { episodeNumber: 1, priority: 'high', status: 'open', assigneeId: null },
          sla: { state: 'scheduled', policyVersion: 'operator-hours-v1' },
        })
        expect(replay).toMatchObject({
          deduplicated: true,
          task: { id: first.task.id },
          sla: { state: 'scheduled', policyVersion: 'operator-hours-v1' },
        })
        expect(
          (
            await pool.query(
              `SELECT human_handoff_state, automation_mode_state, version
                 FROM workflow_instances WHERE id = $1`,
              [ids.workflowId],
            )
          ).rows,
        ).toEqual([{ human_handoff_state: 'queued', automation_mode_state: 'paused_for_human', version: 2 }])
        expect(
          (await pool.query(`SELECT count(*)::integer AS count FROM human_review_holding_messages`)).rows[0].count,
        ).toBe(1)
        expect(
          (
            await pool.query(
              `SELECT count(*)::integer AS count
                 FROM outbound_notifications WHERE purpose_code = 'HUMAN_HANDOFF_HOLDING'`,
            )
          ).rows[0].count,
        ).toBe(1)
        expect(
          (await pool.query(`SELECT event_type FROM human_review_task_events ORDER BY occurred_at, event_type`)).rows,
        ).toEqual([{ event_type: 'created' }, { event_type: 'holding_queued' }])
        await expect(pool.query(`DELETE FROM human_review_holding_messages`)).rejects.toThrow(/append-only/)
        await expect(pool.query(`UPDATE human_review_task_events SET detail = '{}'::jsonb`)).rejects.toThrow(
          /append-only/,
        )
      } finally {
        await pool.end()
      }
    })
  })

  test('assigns exclusively, filters the queue, records rejected resume, then returns safely', async () => {
    await withPostgres(async (postgres) => {
      await applyMigrations(postgres.url)
      const pool = new Pool({ connectionString: postgres.url })
      try {
        const ids = await seedPhase6Workflow(pool, 'handoff-return')
        await addHoldingTemplate(pool, ids.now)
        const service = serviceFor(pool)
        const opened = await service.openEpisode(openInput(ids))
        const assignedAt = new Date(ids.now.getTime() + 60_000)
        const assigned = await service.assign({
          taskId: opened.task.id,
          operatorId: 'operator_1',
          authorized: true,
          expectedWorkflowVersion: 2,
          reasonCode: 'OPERATOR_CLAIMED',
          correlationId: 'cor_handoff_assign',
          occurredAt: assignedAt,
        })
        expect(assigned).toMatchObject({ status: 'in_progress', assigneeId: 'operator_1' })
        await expect(
          service.assign({
            taskId: opened.task.id,
            operatorId: 'operator_2',
            authorized: true,
            expectedWorkflowVersion: 4,
            reasonCode: 'SECOND_OPERATOR_CLAIMED',
            correlationId: 'cor_handoff_assign_other',
            occurredAt: assignedAt,
          }),
        ).rejects.toBeInstanceOf(HumanReviewOperationError)
        const released = await service.release({
          taskId: opened.task.id,
          operatorId: 'operator_1',
          authorized: true,
          expectedWorkflowVersion: 4,
          reasonCode: 'OPERATOR_SHIFT_ENDED',
          correlationId: 'cor_handoff_release',
          occurredAt: new Date(ids.now.getTime() + 70_000),
        })
        expect(released).toMatchObject({ status: 'open', assigneeId: null })
        const reassigned = await service.assign({
          taskId: opened.task.id,
          operatorId: 'operator_1',
          authorized: true,
          expectedWorkflowVersion: 6,
          reasonCode: 'OPERATOR_RECLAIMED',
          correlationId: 'cor_handoff_reassign',
          occurredAt: new Date(ids.now.getTime() + 80_000),
        })
        expect(reassigned).toMatchObject({ status: 'in_progress', assigneeId: 'operator_1' })
        expect(
          await service.queue({ assigneeId: 'operator_1', overdueAt: new Date('2026-08-25T02:00:00Z') }),
        ).toHaveLength(1)

        await expect(
          service.resolveAndReturn({
            taskId: opened.task.id,
            operatorId: 'operator_1',
            authorized: true,
            expectedWorkflowVersion: 8,
            resolutionCode: 'COMPLAINT_REVIEWED',
            resolutionReason: 'Operator reviewed current workflow evidence.',
            validation: {
              optOutClear: false,
              requiredEvidenceCurrent: true,
              deterministicReadinessPassed: true,
              policyVersion: 'human-return-v1',
              evaluatedAt: new Date(ids.now.getTime() + 84_000),
            },
            correlationId: 'cor_resume_opt_out_rejected',
            occurredAt: new Date(ids.now.getTime() + 85_000),
          }),
        ).rejects.toMatchObject({ reasonCode: 'HUMAN_REVIEW_RESUME_STATE_INVALID' })

        const pauses = new AutomationPauseService(pool)
        const pause = await pauses.activate({
          scope: 'participant',
          kind: 'standard',
          participantId: ids.participantId,
          actorType: 'operator',
          actorId: 'operator_1',
          authorized: true,
          correlationId: 'cor_pause_for_resume_test',
          reasonCode: 'MANUAL_SAFETY_PAUSE',
          activatedAt: new Date(ids.now.getTime() + 90_000),
        })
        await expect(
          service.resolveAndReturn({
            taskId: opened.task.id,
            operatorId: 'operator_1',
            authorized: true,
            expectedWorkflowVersion: 8,
            resolutionCode: 'COMPLAINT_REVIEWED',
            resolutionReason: 'Operator reviewed current workflow evidence.',
            validation: {
              optOutClear: true,
              requiredEvidenceCurrent: true,
              deterministicReadinessPassed: true,
              policyVersion: 'human-return-v1',
              evaluatedAt: new Date(ids.now.getTime() + 115_000),
            },
            correlationId: 'cor_resume_rejected',
            occurredAt: new Date(ids.now.getTime() + 120_000),
          }),
        ).rejects.toMatchObject({ reasonCode: 'HUMAN_REVIEW_ACTIVE_AUTOMATION_PAUSE' })
        expect(
          (
            await pool.query(
              `SELECT event_type, reason_code FROM human_review_task_events
                WHERE event_type = 'resume_rejected'
                  AND reason_code = 'HUMAN_REVIEW_ACTIVE_AUTOMATION_PAUSE'`,
            )
          ).rows,
        ).toEqual([{ event_type: 'resume_rejected', reason_code: 'HUMAN_REVIEW_ACTIVE_AUTOMATION_PAUSE' }])

        await pauses.deactivate({
          pauseId: pause.id,
          actorType: 'operator',
          actorId: 'operator_1',
          authorized: true,
          correlationId: 'cor_pause_cleared',
          reasonCode: 'SAFE_TO_RESUME',
          deactivatedAt: new Date(ids.now.getTime() + 150_000),
        })
        const blockingTask = await pool.query(
          `INSERT INTO human_review_tasks (
             workflow_id, campaign_id, workflow_reference, episode_number, reason_code, priority,
             status, case_packet, case_packet_version, automation_paused,
             deduplication_key, created_at, updated_at
           ) VALUES ($1,$2,$3,2,'COMPLAINT','high','open',$4::jsonb,
                     'human-review-case-packet-v1',true,$5,$6,$6)
           RETURNING id`,
          [
            ids.workflowId,
            ids.campaignId,
            ids.workflowId,
            JSON.stringify(packetFor(ids)),
            `handoff:${ids.workflowId}:blocking-task`,
            new Date(ids.now.getTime() + 155_000),
          ],
        )
        await expect(
          service.resolveAndReturn({
            taskId: opened.task.id,
            operatorId: 'operator_1',
            authorized: true,
            expectedWorkflowVersion: 8,
            resolutionCode: 'COMPLAINT_REVIEWED',
            resolutionReason: 'Operator reviewed current workflow evidence.',
            validation: {
              optOutClear: true,
              requiredEvidenceCurrent: true,
              deterministicReadinessPassed: true,
              policyVersion: 'human-return-v1',
              evaluatedAt: new Date(ids.now.getTime() + 159_000),
            },
            correlationId: 'cor_resume_other_task_rejected',
            occurredAt: new Date(ids.now.getTime() + 160_000),
          }),
        ).rejects.toMatchObject({ reasonCode: 'HUMAN_REVIEW_OTHER_OPEN_TASK' })
        await pool.query(`UPDATE human_review_tasks SET status = 'cancelled' WHERE id = $1`, [blockingTask.rows[0].id])
        const resolved = await service.resolveAndReturn({
          taskId: opened.task.id,
          operatorId: 'operator_1',
          authorized: true,
          expectedWorkflowVersion: 8,
          resolutionCode: 'COMPLAINT_REVIEWED',
          resolutionReason: 'Operator reviewed current workflow evidence.',
          validation: {
            optOutClear: true,
            requiredEvidenceCurrent: true,
            deterministicReadinessPassed: true,
            policyVersion: 'human-return-v1',
            evaluatedAt: new Date(ids.now.getTime() + 175_000),
          },
          correlationId: 'cor_resume_approved',
          occurredAt: new Date(ids.now.getTime() + 180_000),
        })
        expect(resolved).toMatchObject({ status: 'resolved', assigneeId: 'operator_1' })
        expect(
          (
            await pool.query(
              `SELECT human_handoff_state, automation_mode_state, version
                 FROM workflow_instances WHERE id = $1`,
              [ids.workflowId],
            )
          ).rows,
        ).toEqual([{ human_handoff_state: 'returned_to_automation', automation_mode_state: 'active', version: 10 }])
        expect(
          (
            await pool.query(
              `SELECT count(*)::integer AS count,
                      bool_and(ended_at IS NOT NULL) AS all_released
                 FROM operator_assignments`,
            )
          ).rows,
        ).toEqual([{ count: 2, all_released: true }])
        expect(
          (
            await pool.query(
              `SELECT event_type FROM human_review_task_events
                WHERE event_type IN ('resolution_recorded','returned_to_automation') ORDER BY event_type`,
            )
          ).rows,
        ).toEqual([{ event_type: 'resolution_recorded' }, { event_type: 'returned_to_automation' }])
        expect(
          (
            await pool.query(
              `SELECT count(*)::integer AS count FROM human_review_task_events WHERE event_type = 'released'`,
            )
          ).rows[0].count,
        ).toBe(1)
      } finally {
        await pool.end()
      }
    })
  })

  test('stores no deadline when the SLA policy is not approved', async () => {
    await withPostgres(async (postgres) => {
      await applyMigrations(postgres.url)
      const pool = new Pool({ connectionString: postgres.url })
      try {
        const ids = await seedPhase6Workflow(pool, 'handoff-no-sla')
        await addHoldingTemplate(pool, ids.now)
        const opened = await serviceFor(pool).openEpisode(openInput(ids, { slaPolicy: null }))
        expect(opened.sla).toEqual({ state: 'SLA_POLICY_MISSING' })
        expect(
          (
            await pool.query(`SELECT sla_policy_version, due_at, escalation_at FROM human_review_tasks WHERE id = $1`, [
              opened.task.id,
            ])
          ).rows,
        ).toEqual([{ sla_policy_version: null, due_at: null, escalation_at: null }])
      } finally {
        await pool.end()
      }
    })
  })

  test('keeps legacy pre-workflow tasks queue-visible but blocks workflow operations', async () => {
    await withPostgres(async (postgres) => {
      await applyMigrations(postgres.url)
      const pool = new Pool({ connectionString: postgres.url })
      try {
        const now = new Date('2026-08-26T00:00:00.000Z')
        const inserted = await pool.query(
          `INSERT INTO human_review_tasks (
             workflow_reference, reason_code, priority, status, case_packet,
             deduplication_key, created_at, updated_at
           ) VALUES ($1,'COMPLAINT','high','open',$2::jsonb,$3,$4,$4)
           RETURNING id`,
          [
            'pre-workflow:legacy-task',
            JSON.stringify({
              stateCode: 'human_review_required',
              summaryCode: 'COMPLAINT',
              evidenceCodes: ['legacy_event_reference'],
              allowedActionCodes: ['KEEP_AUTOMATION_PAUSED'],
              recommendationCode: 'OPERATOR_REVIEW_REQUIRED',
            }),
            'legacy:pre-workflow:complaint',
            now,
          ],
        )
        const taskId = inserted.rows[0].id
        const service = serviceFor(pool)
        expect(await service.queue({ status: 'open' })).toMatchObject([
          {
            id: taskId,
            workflowId: null,
            campaignId: null,
            casePacketVersion: 'legacy-case-packet-v0',
          },
        ])
        await expect(
          service.assign({
            taskId,
            operatorId: 'operator_legacy',
            authorized: true,
            expectedWorkflowVersion: 0,
            reasonCode: 'OPERATOR_CLAIMED',
            correlationId: 'cor_legacy_assign',
            occurredAt: now,
          }),
        ).rejects.toMatchObject({ reasonCode: 'HUMAN_REVIEW_RESUME_STATE_INVALID' })
      } finally {
        await pool.end()
      }
    })
  })
})
